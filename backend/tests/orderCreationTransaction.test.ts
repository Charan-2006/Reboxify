import crypto from 'node:crypto';
import mongoose, { ClientSession } from 'mongoose';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { IdempotencyRecord, IdempotencyStore } from '../src/middleware/idempotency.js';
import { PackageEventModel, PackageModel, SearchOutboxModel } from '../src/models/index.js';
import { enqueueSearchOutbox } from '../src/repositories/outboxHelper.js';
import {
  BusinessDto,
  BusinessRepository,
  MongoosePackageRepository,
  OrderAllocatedPackageDto,
  OrderDto,
  OrderRepository,
  PackageDto,
  PackageRepository,
  ProductDto,
  ProductRepository,
} from '../src/repositories/phase2Repositories.js';
import { AuditWriter } from '../src/services/auditService.js';
import { AuthService, StoredUserRecord, UserRepository } from '../src/services/authService.js';
import { BusinessService, TransactionRunner } from '../src/services/businessService.js';
import { OrderService } from '../src/services/orderService.js';
import { PackagingService } from '../src/services/packagingService.js';
import { ProductService } from '../src/services/productService.js';
import {
  OrderStatus,
  PackageClass,
  PackageOwnerType,
  PackageStatus,
  UserRole,
} from '../src/types/domain.js';

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

interface SimulatedTxSession {
  id: string;
  undoCallbacks: Array<() => void>;
}

class TransactionalMemoryStore {
  users = new Map<string, StoredUserRecord>();
  businesses = new Map<string, BusinessDto>();
  products = new Map<string, ProductDto>();
  packages = new Map<string, PackageDto>();
  orders = new Map<string, OrderDto>();
  packageEvents: Array<{ packageId: string; type: string; orderId?: string }> = [];
  searchOutbox: Array<{ entityType: string; entityId: string }> = [];
  auditEntries: Array<{ action: string; entityId: string }> = [];
  idempotency = new Map<string, IdempotencyRecord>();
  injectPostReserveError = false;
  concurrentRaceBarrier = false;
  private raceWaiters: Array<() => void> = [];

  async awaitRaceBarrier(): Promise<void> {
    if (!this.concurrentRaceBarrier) return;
    await new Promise<void>((resolve) => {
      this.raceWaiters.push(resolve);
      if (this.raceWaiters.length >= 2) {
        const waiters = this.raceWaiters.splice(0, 2);
        this.concurrentRaceBarrier = false;
        waiters.forEach((fn) => fn());
      }
    });
  }
}

function getUndoList(session?: ClientSession | null): Array<() => void> | undefined {
  return (session as unknown as SimulatedTxSession | undefined)?.undoCallbacks;
}

function buildOrderTxHarness() {
  const store = new TransactionalMemoryStore();

  const runTx: TransactionRunner = async <T>(work: (session: ClientSession | null) => Promise<T>) => {
    const txSession: SimulatedTxSession = { id: `tx_${newId()}`, undoCallbacks: [] };
    try {
      return await work(txSession as unknown as ClientSession);
    } catch (err) {
      for (let i = txSession.undoCallbacks.length - 1; i >= 0; i -= 1) {
        txSession.undoCallbacks[i]();
      }
      throw err;
    }
  };

  const audit: AuditWriter = {
    async record(entry) {
      store.auditEntries.push({ action: entry.action, entityId: entry.entityId });
    },
  };

  const idempotencyStore: IdempotencyStore = {
    async findByKey(key) {
      return store.idempotency.get(key) ?? null;
    },
    async save(record) {
      store.idempotency.set(record.key, record);
    },
  };

  const userRepo: UserRepository = {
    async findByEmail(email) {
      for (const u of store.users.values()) {
        if (u.email === email.toLowerCase().trim()) return u;
      }
      return null;
    },
    async findById(id) {
      return store.users.get(id) ?? null;
    },
    async create(input) {
      const id = newId();
      const created: StoredUserRecord = { id, ...input };
      store.users.set(id, created);
      return created;
    },
  };

  const businessRepo: BusinessRepository = {
    async create(input) {
      const id = newId();
      const now = new Date();
      const dto: BusinessDto = { id, ...input, createdAt: now, updatedAt: now };
      store.businesses.set(id, dto);
      return dto;
    },
    async findById(id) {
      return store.businesses.get(id) ?? null;
    },
    async findBySlug(slug) {
      for (const b of store.businesses.values()) {
        if (b.slug === slug) return b;
      }
      return null;
    },
    async list(filters) {
      let items = Array.from(store.businesses.values());
      if (filters.status) items = items.filter((b) => b.status === filters.status);
      if (filters.packagingModel) items = items.filter((b) => b.packagingModel === filters.packagingModel);
      if (filters.businessId) items = items.filter((b) => b.id === filters.businessId);
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
    },
    async updateStatus(id, status) {
      const b = store.businesses.get(id);
      if (!b) return null;
      b.status = status;
      b.updatedAt = new Date();
      return b;
    },
    async updatePolicies(id, updates) {
      const b = store.businesses.get(id);
      if (!b) return null;
      Object.assign(b, updates, { updatedAt: new Date() });
      return b;
    },
    async linkOwnerUser(userId, businessId) {
      const u = store.users.get(userId);
      if (!u) return;
      u.businessId = businessId;
      if (u.role === 'CUSTOMER') u.role = 'MERCHANT_ADMIN';
    },
  };

  const productRepo: ProductRepository = {
    async upsertBySku(input) {
      for (const p of store.products.values()) {
        if (p.merchantId === input.merchantId && p.sku === input.sku) {
          Object.assign(p, input, { updatedAt: new Date() });
          return p;
        }
      }
      const id = newId();
      const now = new Date();
      const created: ProductDto = { id, ...input, createdAt: now, updatedAt: now };
      store.products.set(id, created);
      return created;
    },
    async findByMerchantAndIds(merchantId, ids) {
      return ids
        .map((id) => store.products.get(id))
        .filter((p): p is ProductDto => Boolean(p && p.merchantId === merchantId));
    },
    async list(filters) {
      let items = Array.from(store.products.values());
      if (filters.merchantId) items = items.filter((p) => p.merchantId === filters.merchantId);
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
    },
  };

  const packageRepo: PackageRepository = {
    async create(input) {
      const id = newId();
      const now = new Date();
      const created: PackageDto = { id, ...input, createdAt: now, updatedAt: now };
      store.packages.set(created.packageId, created);
      store.packageEvents.push({ packageId: created.packageId, type: 'PACKAGE_CREATED' });
      store.searchOutbox.push({ entityType: 'passport', entityId: created.packageId });
      return created;
    },
    async findByPackageId(packageId) {
      return store.packages.get(packageId.toUpperCase()) ?? null;
    },
    async list(filters) {
      let items = Array.from(store.packages.values());
      if (filters.ownerId) items = items.filter((p) => p.ownerId === filters.ownerId);
      if (filters.includeSharedPool && filters.ownerId) {
        items = Array.from(store.packages.values()).filter(
          (p) => p.ownerId === filters.ownerId || p.ownerType === 'REBOXIFY_POOL'
        );
      }
      if (filters.status) items = items.filter((p) => p.status === filters.status);
      if (filters.packageClass) items = items.filter((p) => p.packageClass === filters.packageClass);
      if (filters.ownerType) items = items.filter((p) => p.ownerType === filters.ownerType);
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
    },
    async findCandidatesForAllocation(merchantId, allowSharedPool) {
      const candidates = Array.from(store.packages.values())
        .filter(
          (p) =>
            p.status === 'AVAILABLE' &&
            (p.ownerId === merchantId || (allowSharedPool && p.ownerType === 'REBOXIFY_POOL'))
        )
        .map((p) => structuredClone(p));
      await store.awaitRaceBarrier();
      return candidates;
    },
    async reservePackagesAtomically(reservations, session) {
      expect(session).toBeTruthy();
      const undo = getUndoList(session);
      const out: PackageDto[] = [];
      for (const r of reservations) {
        const pkg = Array.from(store.packages.values()).find(
          (p) => p.id === r.packageRefId && p.status === 'AVAILABLE'
        );
        if (!pkg) return null;
        const prevStatus = pkg.status;
        const prevOrderId = pkg.currentOrderId;
        const prevCustodian = structuredClone(pkg.currentCustodian);
        pkg.status = 'RESERVED';
        pkg.currentOrderId = r.orderId;
        pkg.currentCustodian = {
          custodianType: 'MERCHANT',
          custodianId: r.merchantId,
          label: r.merchantCustodianLabel,
          assignedAt: new Date(),
        };
        const evtEntry = { packageId: pkg.packageId, type: 'PACKAGE_RESERVED', orderId: r.orderId };
        const outboxPassport = { entityType: 'passport', entityId: pkg.packageId };
        const outboxEvt = { entityType: 'package_event', entityId: `evt_${pkg.packageId}` };
        store.packageEvents.push(evtEntry);
        store.searchOutbox.push(outboxPassport, outboxEvt);
        undo?.push(() => {
          pkg.status = prevStatus;
          pkg.currentOrderId = prevOrderId;
          pkg.currentCustodian = prevCustodian;
          const evtIdx = store.packageEvents.indexOf(evtEntry);
          if (evtIdx >= 0) store.packageEvents.splice(evtIdx, 1);
          for (const ob of [outboxPassport, outboxEvt]) {
            const idx = store.searchOutbox.indexOf(ob);
            if (idx >= 0) store.searchOutbox.splice(idx, 1);
          }
        });
        out.push(pkg);
      }
      if (store.injectPostReserveError) {
        throw new Error('Simulated mid-transaction SearchOutbox failure');
      }
      return out;
    },
  };

  const orderRepo: OrderRepository = {
    async create(input, session) {
      const id = newId();
      const now = new Date();
      const dto: OrderDto = { id, ...input, createdAt: now, updatedAt: now };
      store.orders.set(id, dto);
      getUndoList(session)?.push(() => {
        store.orders.delete(id);
      });
      return dto;
    },
    async findById(id) {
      return store.orders.get(id) ?? null;
    },
    async list(filters) {
      let items = Array.from(store.orders.values());
      if (filters.merchantId) items = items.filter((o) => o.merchantId === filters.merchantId);
      if (filters.customerId) items = items.filter((o) => o.customerId === filters.customerId);
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
    },
    async applyAllocationAtomically(orderId, update) {
      const ord = store.orders.get(orderId);
      if (!ord || ord.allocatedPackages.length > 0) return null;
      ord.allocatedPackages = update.allocatedPackages;
      ord.allocationMetadata = update.allocationMetadata;
      ord.totals.depositTotal = update.depositTotal;
      ord.totals.grandTotal = update.grandTotal;
      ord.status = update.status;
      ord.updatedAt = new Date();
      return ord;
    },
  };

  const authService = new AuthService(userRepo, audit);
  const businessService = new BusinessService(businessRepo, audit, runTx);
  const productService = new ProductService(productRepo, businessRepo, audit);
  const packagingService = new PackagingService(packageRepo, businessRepo, audit);
  const orderService = new OrderService(orderRepo, productRepo, businessRepo, packageRepo, audit, runTx);

  const app = createApp({
    authService,
    businessService,
    productService,
    packagingService,
    orderService,
    idempotencyStore,
  });

  return { app, store, userRepo, authService };
}

describe('Order Creation & MongoDB Session Transaction Regression', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reproduces Mongoose multi-doc session create error without ordered: true and verifies enqueueSearchOutbox & MongoosePackageRepository pass ordered: true', async () => {
    const fakeSession = { id: 'tx-session-1', inTransaction: () => true } as unknown as ClientSession;

    // 1. Reproduce the exact Mongoose error when creating 2+ docs in a session without `ordered: true`
    await expect(
      SearchOutboxModel.create(
        [
          { entityType: 'passport', entityId: 'RBX-CHN-0001', operation: 'UPSERT', status: 'PENDING' },
          { entityType: 'package_event', entityId: 'evt_1', operation: 'UPSERT', status: 'PENDING' },
        ],
        { session: fakeSession }
      )
    ).rejects.toThrow(/Cannot call `create\(\)` with a session and multiple documents unless `ordered: true` is set/);

    // 2. Verify enqueueSearchOutbox passes `ordered: true` cleanly with an active session
    vi.spyOn(SearchOutboxModel, 'create').mockResolvedValue([] as never);
    await enqueueSearchOutbox(
      [
        { entityType: 'passport', entityId: 'RBX-CHN-0001' },
        { entityType: 'package_event', entityId: 'evt_1' },
      ],
      fakeSession
    );
    expect(SearchOutboxModel.create).toHaveBeenCalledWith(
      [
        { entityType: 'passport', entityId: 'RBX-CHN-0001', operation: 'UPSERT', status: 'PENDING' },
        { entityType: 'package_event', entityId: 'evt_1', operation: 'UPSERT', status: 'PENDING' },
      ],
      { session: fakeSession, ordered: true }
    );

    // 3. Verify MongoosePackageRepository.reservePackagesAtomically passes `{ session, ordered: true }`
    vi.restoreAllMocks();
    const prevReadyState = mongoose.connection.readyState;
    Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
    try {
      const pkgObjectId = new mongoose.Types.ObjectId();
      const orderObjectId = new mongoose.Types.ObjectId();
      const merchantObjectId = new mongoose.Types.ObjectId();

      vi.spyOn(PackageModel, 'findOneAndUpdate').mockReturnValue({
        lean: async () => ({
          _id: pkgObjectId,
          packageId: 'RBX-LIVE-TX01',
          ownerType: 'MERCHANT' as PackageOwnerType,
          ownerId: merchantObjectId,
          packageClass: 'M' as PackageClass,
          dimensionsCm: { length: 30, width: 25, height: 15 },
          maxWeightKg: 8,
          protectionCategory: 'STANDARD',
          supportsLiquidContainment: false,
          material: 'REUSABLE_PP',
          replacementValue: 10,
          depositAmount: 5,
          currency: 'USD',
          status: 'RESERVED' as PackageStatus,
          condition: 'NEW',
          reuseCount: 0,
          maxLifecycleLimit: 50,
          fulfilmentLocation: 'CHN-HUB-01',
          currentCustodian: {
            custodianType: 'MERCHANT',
            custodianId: merchantObjectId.toString(),
            label: 'Merchant Fulfilment',
            assignedAt: new Date(),
          },
          currentOrderId: orderObjectId,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      } as never);

      vi.spyOn(PackageEventModel, 'create').mockResolvedValue([{}] as never);
      const outboxSpy = vi.spyOn(SearchOutboxModel, 'create').mockResolvedValue([{}, {}] as never);

      const repo = new MongoosePackageRepository();
      const reserved = await repo.reservePackagesAtomically(
        [
          {
            packageRefId: pkgObjectId.toString(),
            packageId: 'RBX-LIVE-TX01',
            orderId: orderObjectId.toString(),
            merchantId: merchantObjectId.toString(),
            merchantCustodianLabel: 'Merchant Fulfilment',
            actor: { userId: merchantObjectId.toString(), role: 'CUSTOMER' },
          },
        ],
        fakeSession
      );

      expect(reserved).toHaveLength(1);
      expect(outboxSpy).toHaveBeenCalledTimes(1);
      const [, createOptions] = outboxSpy.mock.calls[0];
      expect(createOptions).toEqual({ session: fakeSession, ordered: true });
    } finally {
      Object.defineProperty(mongoose.connection, 'readyState', { value: prevReadyState, configurable: true });
    }
  });

  it('completes end-to-end transactional order creation, supports Idempotency-Key retries, rolls back on write failures, and blocks concurrent double allocation', async () => {
    const h = buildOrderTxHarness();

    const registerStaff = async (email: string, role: UserRole) => {
      const reg = await request(h.app).post('/api/auth/register').send({ name: email, email, password: 'Password123!' });
      const u = h.store.users.get(reg.body.user.userId)!;
      u.role = role;
      const login = await request(h.app).post('/api/auth/login').send({ email, password: 'Password123!' });
      return { token: login.body.token as string, userId: u.id };
    };

    const admin = await registerStaff('admin-tx@rbx.test', 'ADMIN');
    const merch = await registerStaff('merch-tx@rbx.test', 'MERCHANT_ADMIN');
    const cust1 = await registerStaff('cust1-tx@rbx.test', 'CUSTOMER');
    const cust2 = await registerStaff('cust2-tx@rbx.test', 'CUSTOMER');

    const bizRes = await request(h.app)
      .post('/api/businesses')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: 'TxGoods',
        legalName: 'TxGoods Ltd',
        slug: 'txgoods',
        ownerUserId: merch.userId,
        packagingModel: 'HYBRID',
        currency: 'USD',
      });
    const bizId = bizRes.body.business.id as string;

    const merchLogin = await request(h.app)
      .post('/api/auth/login')
      .send({ email: 'merch-tx@rbx.test', password: 'Password123!' });
    const merchToken = merchLogin.body.token as string;

    const prodRes = await request(h.app)
      .post('/api/products')
      .set('Authorization', `Bearer ${merchToken}`)
      .send({
        sku: 'TX-JAR-01',
        name: 'Glass Jar',
        dimensionsCm: { length: 14, width: 10, height: 8 },
        weightKg: 0.7,
        unitPrice: 20,
      });
    const productId = prodRes.body.product.id as string;

    const pkgRes = await request(h.app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${merchToken}`)
      .send({
        packageId: 'RBX-TX-001',
        ownerType: 'MERCHANT',
        packageClass: 'M',
        fulfilmentLocation: 'CHN-HUB-01',
      });
    expect(pkgRes.status).toBe(201);

    const shippingReference = {
      recipientName: 'Customer One',
      zone: 'Zone-A',
      addressLine: '42 Green Ave, Chennai',
      fulfilmentLocation: 'CHN-HUB-01',
    };

    // 1. Transaction failure mid-allocation rolls back Order & Package completely (zero orphans)
    h.store.injectPostReserveError = true;
    const failedOrderRes = await request(h.app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cust1.token}`)
      .set('Idempotency-Key', 'ord-fail-key')
      .send({
        merchantId: bizId,
        items: [{ productId, quantity: 1 }],
        shippingReference,
        autoAllocate: true,
      });
    expect(failedOrderRes.status).toBe(500);
    expect(h.store.orders.size).toBe(0);
    expect(h.store.packages.get('RBX-TX-001')!.status).toBe('AVAILABLE');
    expect(h.store.packages.get('RBX-TX-001')!.currentOrderId).toBeUndefined();
    expect(h.store.packageEvents.filter((e) => e.type === 'PACKAGE_RESERVED')).toHaveLength(0);
    h.store.injectPostReserveError = false;

    // 2. Successful transactional order creation + allocation + linking
    const okRes = await request(h.app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cust1.token}`)
      .set('Idempotency-Key', 'ord-ok-1')
      .send({
        merchantId: bizId,
        items: [{ productId, quantity: 1 }],
        shippingReference,
        autoAllocate: true,
      });
    expect(okRes.status).toBe(201);
    expect(okRes.body.order.status).toBe('ALLOCATED');
    expect(okRes.body.order.allocatedPackages).toHaveLength(1);
    expect(okRes.body.order.allocatedPackages[0].packageId).toBe('RBX-TX-001');

    const pkgAfter = h.store.packages.get('RBX-TX-001')!;
    expect(pkgAfter.status).toBe('RESERVED');
    expect(pkgAfter.currentOrderId).toBe(okRes.body.order.id);
    expect(pkgAfter.currentCustodian.custodianType).toBe('MERCHANT');
    expect(h.store.packageEvents.some((e) => e.type === 'PACKAGE_RESERVED' && e.orderId === okRes.body.order.id)).toBe(true);
    expect(h.store.searchOutbox.some((o) => o.entityType === 'passport' && o.entityId === 'RBX-TX-001')).toBe(true);
    expect(h.store.auditEntries.some((a) => a.action === 'ORDER_CREATED' && a.entityId === okRes.body.order.id)).toBe(true);

    // 3. Repeated submission with same Idempotency-Key returns same order without creating duplicates
    const retryRes = await request(h.app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cust1.token}`)
      .set('Idempotency-Key', 'ord-ok-1')
      .send({
        merchantId: bizId,
        items: [{ productId, quantity: 1 }],
        shippingReference,
        autoAllocate: true,
      });
    expect(retryRes.status).toBe(201);
    expect(retryRes.body.order.id).toBe(okRes.body.order.id);
    expect(h.store.orders.size).toBe(1);

    // Same Idempotency-Key with altered payload is rejected cleanly
    const conflictKeyRes = await request(h.app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cust1.token}`)
      .set('Idempotency-Key', 'ord-ok-1')
      .send({
        merchantId: bizId,
        items: [{ productId, quantity: 2 }],
        shippingReference,
        autoAllocate: true,
      });
    expect(conflictKeyRes.status).toBe(409);

    // 4. Register ONE second package and verify two concurrent orders cannot allocate it twice
    await request(h.app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${merchToken}`)
      .send({
        packageId: 'RBX-TX-002',
        ownerType: 'MERCHANT',
        packageClass: 'M',
        fulfilmentLocation: 'CHN-HUB-01',
      });

    h.store.concurrentRaceBarrier = true;
    const [raceA, raceB] = await Promise.all([
      request(h.app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${cust1.token}`)
        .set('Idempotency-Key', 'race-cust-1')
        .send({ merchantId: bizId, items: [{ productId, quantity: 1 }], shippingReference, autoAllocate: true }),
      request(h.app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${cust2.token}`)
        .set('Idempotency-Key', 'race-cust-2')
        .send({ merchantId: bizId, items: [{ productId, quantity: 1 }], shippingReference, autoAllocate: true }),
    ]);

    const statuses = [raceA.status, raceB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    // Only 1 additional order committed cleanly; loser rolled back with zero orphaned order!
    expect(h.store.orders.size).toBe(2);
    expect(h.store.packages.get('RBX-TX-002')!.status).toBe('RESERVED');
  });
});

