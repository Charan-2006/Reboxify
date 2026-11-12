import crypto from 'node:crypto';
import { ClientSession } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { IdempotencyRecord, IdempotencyStore } from '../src/middleware/idempotency.js';
import {
  BusinessDto,
  BusinessRepository,
  OrderDto,
  OrderRepository,
  PackageDto,
  PackageRepository,
  ProductDto,
  ProductRepository,
} from '../src/repositories/phase2Repositories.js';
import { TransactionDto, TransactionRepository } from '../src/repositories/phase3Repositories.js';
import {
  CreatePackageEventInput,
  PackageEventDto,
  PassportRepository,
} from '../src/repositories/phase4Repositories.js';
import { AuditWriter } from '../src/services/auditService.js';
import { AuthService, StoredUserRecord, UserRepository } from '../src/services/authService.js';
import { BusinessService, TransactionRunner } from '../src/services/businessService.js';
import { OrderService } from '../src/services/orderService.js';
import { PackagingService } from '../src/services/packagingService.js';
import { PassportService } from '../src/services/passportService.js';
import { PaymentService } from '../src/services/paymentService.js';
import { PayPalClient, PayPalCreateOrderParams, PayPalOrderResponse } from '../src/services/paypalClient.js';
import { ProductService } from '../src/services/productService.js';
import { QrService } from '../src/services/qrService.js';
import { OrderStatus, PaymentStatus } from '../src/types/domain.js';

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

class InMemoryIdempotencyStore implements IdempotencyStore {
  private map = new Map<string, IdempotencyRecord>();
  async findByKey(key: string) {
    return this.map.get(key) ?? null;
  }
  async save(record: IdempotencyRecord) {
    this.map.set(record.key, record);
  }
}

function buildPhase4Harness(options?: { qrService?: QrService }) {
  const users = new Map<string, StoredUserRecord>();
  const businesses = new Map<string, BusinessDto>();
  const products = new Map<string, ProductDto>();
  const packages = new Map<string, PackageDto>();
  const orders = new Map<string, OrderDto>();
  const transactions = new Map<string, TransactionDto>();
  const packageEvents: PackageEventDto[] = [];
  const partialScanIndexKeys = new Set<string>();
  const pushPackageEvent = (evt: PackageEventDto) => {
    const normalizedScanId = typeof evt.scanId === 'string' && evt.scanId.trim() ? evt.scanId.trim() : undefined;
    if (normalizedScanId) {
      const idxKey = `${evt.packageId}::${normalizedScanId}`;
      if (partialScanIndexKeys.has(idxKey)) {
        const err = new Error(`E11000 duplicate key error on { packageId: 1, scanId: 1 }: ${idxKey}`) as Error & { code?: number };
        err.code = 11000;
        throw err;
      }
      partialScanIndexKeys.add(idxKey);
    }
    packageEvents.push({
      ...evt,
      ...(normalizedScanId ? { scanId: normalizedScanId } : { scanId: undefined }),
    });
  };
  const outboxEntries: Array<{ entityType: string; entityId: string; operation: string }> = [];
  const auditEntries: Array<{ action: string; entityId: string; afterSummary?: unknown }> = [];

  const qrService =
    options?.qrService ??
    new QrService({
      currentKeyId: 'k1',
      currentSecret: 'phase4-test-secret-key-current-32-chars!!',
      previousKeys: [{ keyId: 'k0', secret: 'phase4-test-secret-key-previous-32-chars!' }],
      defaultTtlSeconds: 86400,
    });

  const runTx: TransactionRunner = async <T>(work: (s: ClientSession | null) => Promise<T>) =>
    work(null);

  const audit: AuditWriter = {
    async record(entry) {
      auditEntries.push({
        action: entry.action,
        entityId: entry.entityId,
        afterSummary: entry.afterSummary,
      });
    },
  };

  const userRepo: UserRepository = {
    async findByEmail(email) {
      for (const u of users.values()) if (u.email === email.toLowerCase().trim()) return u;
      return null;
    },
    async findById(id) {
      return users.get(id) ?? null;
    },
    async create(input) {
      const id = newId();
      const rec: StoredUserRecord = { id, ...input };
      users.set(id, rec);
      return rec;
    },
  };

  const businessRepo: BusinessRepository = {
    async create(input) {
      const id = newId();
      const now = new Date();
      const dto: BusinessDto = { id, ...input, createdAt: now, updatedAt: now };
      businesses.set(id, dto);
      return dto;
    },
    async findById(id) {
      return businesses.get(id) ?? null;
    },
    async findBySlug(slug) {
      for (const b of businesses.values()) if (b.slug === slug) return b;
      return null;
    },
    async list(filters) {
      let arr = Array.from(businesses.values());
      if (filters.businessId) arr = arr.filter((b) => b.id === filters.businessId);
      if (filters.status) arr = arr.filter((b) => b.status === filters.status);
      return { items: arr, total: arr.length, page: filters.page, pageSize: filters.pageSize };
    },
    async updateStatus(id, status) {
      const b = businesses.get(id);
      if (!b) return null;
      const updated = { ...b, status, updatedAt: new Date() };
      businesses.set(id, updated);
      return updated;
    },
    async updatePolicies(id, update) {
      const b = businesses.get(id);
      if (!b) return null;
      const updated = { ...b, ...update, updatedAt: new Date() };
      businesses.set(id, updated);
      return updated;
    },
    async linkOwnerUser(userId, businessId) {
      const u = users.get(userId);
      if (u) {
        u.businessId = businessId;
        if (u.role === 'CUSTOMER') u.role = 'MERCHANT_ADMIN';
      }
    },
  };

  const productRepo: ProductRepository = {
    async upsertBySku(input) {
      for (const p of products.values()) {
        if (p.merchantId === input.merchantId && p.sku === input.sku.toUpperCase()) {
          const upd = { ...p, ...input, updatedAt: new Date() };
          products.set(p.id, upd);
          return upd;
        }
      }
      const id = newId();
      const now = new Date();
      const created: ProductDto = { id, ...input, createdAt: now, updatedAt: now };
      products.set(id, created);
      return created;
    },
    async findByMerchantAndIds(merchantId, ids) {
      return ids
        .map((id) => products.get(id))
        .filter((p): p is ProductDto => Boolean(p && p.merchantId === merchantId));
    },
    async listByMerchant(filters) {
      const arr = Array.from(products.values()).filter(
        (p) => !filters.merchantId || p.merchantId === filters.merchantId
      );
      return { items: arr, total: arr.length, page: filters.page, pageSize: filters.pageSize };
    },
  };

  const packageRepo: PackageRepository = {
    async create(input) {
      const id = newId();
      const now = new Date();
      const dto: PackageDto = {
        id,
        ...input,
        qrTokenVersion: input.qrTokenVersion ?? 1,
        qrRevoked: input.qrRevoked ?? false,
        createdAt: now,
        updatedAt: now,
      };
      packages.set(id, dto);
      pushPackageEvent({
        eventId: `evt_${crypto.randomUUID()}`,
        packageId: dto.packageId,
        merchantId: dto.ownerId,
        type: 'PACKAGE_CREATED',
        actor: { userId: 'system', role: 'ADMIN' },
        occurredAt: now,
        sourceSystem: 'REBOXIFY_API',
        outcome: 'ACCEPTED',
        evidence: [],
        metadata: { packageClass: dto.packageClass, ownerType: dto.ownerType },
      });
      outboxEntries.push({ entityType: 'passport', entityId: dto.packageId, operation: 'UPSERT' });
      return dto;
    },
    async findByPackageId(packageId) {
      for (const p of packages.values()) {
        if (p.packageId === packageId.toUpperCase()) return p;
      }
      return null;
    },
    async list(filters) {
      let arr = Array.from(packages.values());
      if (filters.merchantId) {
        arr = arr.filter((p) => {
          const owned = p.ownerId === filters.merchantId;
          const custodied = p.currentCustodian.custodianId === filters.merchantId;
          const pool = filters.includeSharedPool && p.ownerType === 'REBOXIFY_POOL';
          return owned || custodied || pool;
        });
      }
      return { items: arr, total: arr.length, page: filters.page, pageSize: filters.pageSize };
    },
    async findCandidatesForAllocation(merchantId, allowSharedPool, allowCrossMerchantHybrid) {
      return Array.from(packages.values()).filter((p) => {
        if (p.status !== 'AVAILABLE') return false;
        if (p.ownerId === merchantId) return true;
        if (allowSharedPool && p.ownerType === 'REBOXIFY_POOL') return true;
        if (allowCrossMerchantHybrid && p.ownerType === 'HYBRID') return true;
        return false;
      });
    },
    async reservePackagesAtomically(reservations) {
      const out: PackageDto[] = [];
      for (const r of reservations) {
        const existing = packages.get(r.packageRefId);
        if (!existing || existing.status !== 'AVAILABLE') return null;
        const updated: PackageDto = {
          ...existing,
          status: 'RESERVED',
          currentOrderId: r.orderId,
          currentCustodian: {
            custodianType: 'MERCHANT',
            custodianId: r.merchantId,
            label: r.merchantCustodianLabel,
            assignedAt: new Date(),
          },
          updatedAt: new Date(),
        };
        packages.set(existing.id, updated);
        pushPackageEvent({
          eventId: `evt_${crypto.randomUUID()}`,
          packageId: updated.packageId,
          merchantId: r.merchantId,
          type: 'PACKAGE_RESERVED',
          actor: r.actor,
          occurredAt: new Date(),
          sourceSystem: 'REBOXIFY_API',
          outcome: 'ACCEPTED',
          evidence: [],
          metadata: { orderId: r.orderId },
        });
        outboxEntries.push({ entityType: 'passport', entityId: updated.packageId, operation: 'UPSERT' });
        out.push(updated);
      }
      return out;
    },
  };

  const orderRepo: OrderRepository = {
    async create(input) {
      const id = newId();
      const now = new Date();
      const dto: OrderDto = { id, ...input, createdAt: now, updatedAt: now };
      orders.set(id, dto);
      return dto;
    },
    async findById(id) {
      return orders.get(id) ?? null;
    },
    async list(filters) {
      let arr = Array.from(orders.values());
      if (filters.merchantId) arr = arr.filter((o) => o.merchantId === filters.merchantId);
      if (filters.customerId) arr = arr.filter((o) => o.customerId === filters.customerId);
      return { items: arr, total: arr.length, page: filters.page, pageSize: filters.pageSize };
    },
    async applyAllocationAtomically(orderId, update) {
      const ord = orders.get(orderId);
      if (!ord || ord.allocatedPackages.length > 0) return null;
      const updated: OrderDto = {
        ...ord,
        allocatedPackages: update.allocatedPackages,
        allocationMetadata: update.allocationMetadata,
        totals: {
          ...ord.totals,
          depositTotal: update.depositTotal,
          grandTotal: update.grandTotal,
        },
        status: update.status,
        updatedAt: new Date(),
      };
      orders.set(orderId, updated);
      return updated;
    },
  };

  const transactionRepo: TransactionRepository = {
    async create(input) {
      const id = newId();
      const now = new Date();
      const dto: TransactionDto = { id, ...input, createdAt: now, updatedAt: now };
      transactions.set(id, dto);
      return dto;
    },
    async findById(id) {
      return transactions.get(id) ?? null;
    },
    async findByPayPalOrderId(paypalOrderId) {
      for (const t of transactions.values()) {
        if (t.paypalOrderId === paypalOrderId) return t;
      }
      return null;
    },
    async findActiveByOrderId(orderId) {
      for (const t of transactions.values()) {
        if (
          t.orderId === orderId &&
          !['CAPTURE_FAILED', 'REFUND_FAILED', 'REVERSED'].includes(t.state)
        ) {
          return t;
        }
      }
      return null;
    },
    async findLatestByOrderId(orderId) {
      const matches = Array.from(transactions.values()).filter((t) => t.orderId === orderId);
      return matches[matches.length - 1] ?? null;
    },
    async list(filters) {
      let arr = Array.from(transactions.values());
      if (filters.merchantId) arr = arr.filter((t) => t.merchantId === filters.merchantId);
      if (filters.customerId) arr = arr.filter((t) => t.customerId === filters.customerId);
      if (filters.state) arr = arr.filter((t) => t.state === filters.state);
      return { items: arr, total: arr.length, page: filters.page, pageSize: filters.pageSize };
    },
    async transitionState(txId, fromStates, update) {
      const t = transactions.get(txId);
      if (!t || !fromStates.includes(t.state)) return null;
      Object.assign(t, update, { updatedAt: new Date() });
      return t;
    },
    async updateOrderPaymentStatus(orderId, nextStatus: OrderStatus) {
      const ord = orders.get(orderId);
      if (ord) ord.status = nextStatus;
    },
  };

  const passportRepo: PassportRepository = {
    async findPackageById(packageId) {
      for (const p of packages.values()) {
        if (p.packageId === packageId.trim().toUpperCase()) return p;
      }
      return null;
    },
    async findPackagesByIds(packageIds) {
      const set = new Set(packageIds.map((id) => id.trim().toUpperCase()));
      return Array.from(packages.values()).filter((p) => set.has(p.packageId));
    },
    async findAssignedToPartner({ partnerUserId, status, page, pageSize }) {
      const arr = Array.from(packages.values()).filter(
        (p) => p.assignedPartnerUserId === partnerUserId && (!status || p.status === status)
      );
      return { items: arr, total: arr.length, page, pageSize };
    },
    async findEventsByPackageId(packageId, limit = 100) {
      return packageEvents
        .filter((e) => e.packageId === packageId.trim().toUpperCase())
        .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
        .slice(0, limit);
    },
    async findEventByScanId(packageId, scanId) {
      return (
        packageEvents.find(
          (e) => e.packageId === packageId.trim().toUpperCase() && e.scanId === scanId.trim()
        ) ?? null
      );
    },
    async recordEvent(input: CreatePackageEventInput) {
      const evt: PackageEventDto = {
        eventId: input.eventId ?? `evt_${crypto.randomUUID()}`,
        packageId: input.packageId.trim().toUpperCase(),
        merchantId: input.merchantId,
        ...(input.scanId?.trim() ? { scanId: input.scanId.trim() } : {}),
        type: input.type,
        actor: input.actor,
        occurredAt: input.occurredAt ?? new Date(),
        sourceSystem: input.sourceSystem ?? 'REBOXIFY_API',
        correlationId: input.correlationId,
        locationRef: input.locationRef,
        outcome: input.outcome,
        evidence: input.evidence ?? [],
        metadata: input.metadata,
      };
      pushPackageEvent(evt);
      outboxEntries.push({ entityType: 'package_event', entityId: evt.eventId, operation: 'UPSERT' });
      return evt;
    },
    async applyScanTransitionAtomically(params) {
      let target: PackageDto | null = null;
      for (const p of packages.values()) {
        if (p.packageId === params.packageId.trim().toUpperCase()) {
          target = p;
          break;
        }
      }
      if (!target || target.status !== params.expectedFromStatus) return null;

      const updatedPkg: PackageDto = {
        ...target,
        status: params.toStatus,
        currentCustodian: params.newCustodian ?? target.currentCustodian,
        currentOrderId: params.clearOrderAndPartner ? undefined : target.currentOrderId,
        assignedPartnerUserId: params.clearOrderAndPartner
          ? undefined
          : params.assignedPartnerUserId ?? target.assignedPartnerUserId,
        assignedPartnerName: params.clearOrderAndPartner
          ? undefined
          : params.assignedPartnerName ?? target.assignedPartnerName,
        reuseCount: params.incrementReuseCount ? target.reuseCount + 1 : target.reuseCount,
        lastInspectionAt: params.lastInspectionAt ?? target.lastInspectionAt,
        lastInspectionOutcome: params.lastInspectionOutcome ?? target.lastInspectionOutcome,
        lastCleanedAt: params.lastCleanedAt ?? target.lastCleanedAt,
        updatedAt: new Date(),
      };
      packages.set(target.id, updatedPkg);

      const event = await this.recordEvent(params.event);
      outboxEntries.push({ entityType: 'passport', entityId: updatedPkg.packageId, operation: 'UPSERT' });

      let orderUpdated = false;
      if (params.orderUpdate) {
        const ord = orders.get(params.orderUpdate.orderId);
        if (ord && params.orderUpdate.expectedStatuses.includes(ord.status)) {
          orders.set(ord.id, {
            ...ord,
            status: params.orderUpdate.toStatus,
            returnDeadlineAt: params.orderUpdate.returnDeadlineAt ?? ord.returnDeadlineAt,
            updatedAt: new Date(),
          });
          orderUpdated = true;
        }
      }

      return { package: updatedPkg, event, orderUpdated };
    },
    async updateQrCredentials(params) {
      let target: PackageDto | null = null;
      for (const p of packages.values()) {
        if (p.packageId === params.packageId.trim().toUpperCase()) {
          target = p;
          break;
        }
      }
      if (!target) return null;

      const updated: PackageDto = {
        ...target,
        qrTokenHash: params.qrTokenHash,
        qrTokenVersion: params.qrTokenVersion,
        qrRevoked: params.qrRevoked,
        qrRevokedAt: params.qrRevokedAt === null ? undefined : params.qrRevokedAt ?? target.qrRevokedAt,
        qrRevokedReason:
          params.qrRevokedReason === null ? undefined : params.qrRevokedReason ?? target.qrRevokedReason,
        updatedAt: new Date(),
      };
      packages.set(target.id, updated);
      const event = await this.recordEvent(params.event);
      outboxEntries.push({ entityType: 'passport', entityId: updated.packageId, operation: 'UPSERT' });
      return { package: updated, event };
    },
    async assignDeliveryPartner(params) {
      let target: PackageDto | null = null;
      for (const p of packages.values()) {
        if (p.packageId === params.packageId.trim().toUpperCase()) {
          target = p;
          break;
        }
      }
      if (!target) return null;

      const updated: PackageDto = {
        ...target,
        assignedPartnerUserId: params.partnerUserId,
        assignedPartnerName: params.partnerName,
        updatedAt: new Date(),
      };
      packages.set(target.id, updated);
      const event = await this.recordEvent(params.event);
      outboxEntries.push({ entityType: 'passport', entityId: updated.packageId, operation: 'UPSERT' });
      return { package: updated, event };
    },
    async findUserSummary(userId) {
      const u = users.get(userId);
      if (!u) return null;
      return { id: u.id, name: u.name, email: u.email, role: u.role, status: u.status };
    },
    async listActiveDeliveryPartners() {
      return Array.from(users.values())
        .filter((u) => u.role === 'DELIVERY_PARTNER' && u.status === 'ACTIVE')
        .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status }));
    },
  };

  const expectedAmountsByPpOrderId = new Map<string, string>();
  const paypalMock: PayPalClient = {
    isConfigured: () => true,
    async createOrder(params: PayPalCreateOrderParams): Promise<PayPalOrderResponse> {
      const ppId = `PAYPAL-ORD-${params.internalOrderId.slice(0, 8)}`;
      expectedAmountsByPpOrderId.set(ppId, params.grandTotal.toFixed(2));
      return {
        id: ppId,
        status: 'CREATED',
      };
    },
    async captureOrder(paypalOrderId: string): Promise<PayPalOrderResponse> {
      const value = expectedAmountsByPpOrderId.get(paypalOrderId) ?? '40.00';
      return {
        id: paypalOrderId,
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [
                {
                  id: `CAP-${crypto.randomBytes(4).toString('hex')}`,
                  status: 'COMPLETED',
                  amount: { currency_code: 'USD', value },
                },
              ],
            },
          },
        ],
      };
    },
    async getOrder(paypalOrderId: string): Promise<PayPalOrderResponse> {
      return { id: paypalOrderId, status: 'COMPLETED' };
    },
  };

  const authService = new AuthService(userRepo, audit);
  const businessService = new BusinessService(businessRepo, audit, runTx);
  const productService = new ProductService(productRepo, businessRepo, audit);
  const packagingService = new PackagingService(packageRepo, businessRepo, audit, qrService);
  const orderService = new OrderService(
    orderRepo,
    productRepo,
    businessRepo,
    packageRepo,
    audit,
    runTx
  );
  const paymentService = new PaymentService(transactionRepo, orderRepo, paypalMock, audit, runTx);
  const passportService = new PassportService(
    passportRepo,
    businessRepo,
    orderRepo,
    transactionRepo,
    qrService,
    audit,
    runTx
  );

  const app = createApp({
    authService,
    businessService,
    productService,
    packagingService,
    orderService,
    paymentService,
    passportService,
    idempotencyStore: new InMemoryIdempotencyStore(),
  });

  return {
    app,
    authService,
    users,
    businesses,
    products,
    packages,
    orders,
    transactions,
    packageEvents,
    outboxEntries,
    auditEntries,
    qrService,
  };
}

async function seedStandardPhase4Scenario() {
  const harness = buildPhase4Harness();
  const { app, authService, users } = harness;
  const seedAdminCaller = {
    userId: 'seed-admin',
    email: 'seed@reboxify.test',
    name: 'Seed Admin',
    role: 'ADMIN' as const,
  };

  const regPrivileged = async (
    name: string,
    email: string,
    role: StoredUserRecord['role'],
    extra?: { businessId?: string; collectionCenterId?: string }
  ) => {
    const res = await authService.register(
      {
        name,
        email,
        password: 'Password123!',
        role,
        businessId: extra?.businessId,
        collectionCenterId: extra?.collectionCenterId,
      },
      seedAdminCaller
    );
    return { userId: res.user.userId, token: res.token };
  };

  const regCustomer = async (name: string, email: string) => {
    const res = await request(app).post('/api/auth/register').send({
      name,
      email,
      password: 'Password123!',
    });
    expect(res.status).toBe(201);
    return { userId: res.body.user.userId as string, token: res.body.token as string };
  };

  const admin = await regPrivileged('Admin One', 'admin@reboxify.test', 'ADMIN');
  const merchA = await regPrivileged('Merchant A', 'ma@reboxify.test', 'MERCHANT_ADMIN');
  const merchB = await regPrivileged('Merchant B', 'mb@reboxify.test', 'MERCHANT_ADMIN');
  const customerA = await regCustomer('Alice Customer', 'alice@reboxify.test');
  const customerB = await regCustomer('Bob Customer', 'bob@reboxify.test');
  const partner1 = await regPrivileged('Partner One', 'p1@reboxify.test', 'DELIVERY_PARTNER');
  const partner2 = await regPrivileged('Partner Two', 'p2@reboxify.test', 'DELIVERY_PARTNER');
  const centre = await regPrivileged('Hub Operator', 'hub@reboxify.test', 'COLLECTION_CENTRE', {
    collectionCenterId: 'CENTRE-CHN-01',
  });

  const bizARes = await request(app)
    .post('/api/businesses')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      name: 'GreenStore Alpha',
      legalName: 'GreenStore Alpha LLC',
      slug: 'greenstore-alpha',
      ownerUserId: merchA.userId,
      packagingModel: 'MERCHANT_OWNED',
      currency: 'USD',
    });
  expect(bizARes.status).toBe(201);
  const bizAId = bizARes.body.business.id as string;
  users.get(merchA.userId)!.businessId = bizAId;
  const merchALogin = await request(app)
    .post('/api/auth/login')
    .send({ email: 'ma@reboxify.test', password: 'Password123!' });
  merchA.token = merchALogin.body.token;

  const bizBRes = await request(app)
    .post('/api/businesses')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      name: 'OtherStore Beta',
      legalName: 'OtherStore Beta LLC',
      slug: 'otherstore-beta',
      ownerUserId: merchB.userId,
      packagingModel: 'MERCHANT_OWNED',
      currency: 'USD',
    });
  const bizBId = bizBRes.body.business.id as string;
  users.get(merchB.userId)!.businessId = bizBId;
  const merchBLogin = await request(app)
    .post('/api/auth/login')
    .send({ email: 'mb@reboxify.test', password: 'Password123!' });
  merchB.token = merchBLogin.body.token;

  const prodRes = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${merchA.token}`)
    .send({
      sku: 'BOTTLE-500',
      name: 'Glass Tonic Bottle',
      dimensionsCm: { length: 18, width: 12, height: 10 },
      weightKg: 1.5,
      rotatable: true,
      fragility: 'LOW',
      unitPrice: 17.5,
    });
  expect(prodRes.status).toBe(201);

  const pkgARes = await request(app)
    .post('/api/inventory')
    .set('Authorization', `Bearer ${merchA.token}`)
    .send({
      packageId: 'RBX-CHN-PKG001',
      ownerType: 'MERCHANT',
      packageClass: 'M',
      fulfilmentLocation: 'CHN-HUB-01',
    });
  expect(pkgARes.status).toBe(201);

  const pkgBRes = await request(app)
    .post('/api/inventory')
    .set('Authorization', `Bearer ${merchB.token}`)
    .send({
      packageId: 'RBX-CHN-PKGB02',
      ownerType: 'MERCHANT',
      packageClass: 'M',
      fulfilmentLocation: 'CHN-HUB-01',
    });
  expect(pkgBRes.status).toBe(201);

  // Order total: 2 * 17.5 = 35.00 + M deposit 15.00 = 50.00 (matches mock capture response!)
  const ordRes = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${customerA.token}`)
    .send({
      merchantId: bizAId,
      items: [{ productId: prodRes.body.product.id, quantity: 2 }],
      shippingReference: {
        recipientName: 'Alice Sensitive Name',
        zone: 'Zone-A',
        addressLine: '42 Secret Residential Street',
        fulfilmentLocation: 'CHN-HUB-01',
      },
      autoAllocate: true,
    });
  expect(ordRes.status).toBe(201);

  return {
    ...harness,
    admin,
    merchA,
    merchB,
    customerA,
    customerB,
    partner1,
    partner2,
    centre,
    bizAId,
    bizBId,
    orderId: ordRes.body.order.id as string,
    packageIdA: pkgARes.body.package.packageId as string,
    qrTokenA: pkgARes.body.qrPayload.token as string,
    labelA: pkgARes.body.label,
    packageIdB: pkgBRes.body.package.packageId as string,
    qrTokenB: pkgBRes.body.qrPayload.token as string,
  };
}

describe('Phase 4 — Digital Packaging Passport, Signed QR Security & Authorised Scans', () => {
  it('completes end-to-end signed QR lifecycle (register -> pack -> payment-gated dispatch -> partner delivery -> customer passport -> return recirculation + reuse increment)', async () => {
    const s = await seedStandardPhase4Scenario();

    // Verify QR payload & printable label never leak customer PII or payment secrets
    expect(s.qrTokenA.startsWith('RBXQR:v1.k1.')).toBe(true);
    const decodedPayloadJson = Buffer.from(s.qrTokenA.split('.')[2], 'base64url').toString('utf8');
    expect(decodedPayloadJson).not.toContain('Alice');
    expect(decodedPayloadJson).not.toContain('Secret Residential');
    expect(JSON.stringify(s.labelA)).not.toContain('Alice');
    expect(s.labelA.handlingInstructions.length).toBeGreaterThanOrEqual(2);

    // 1. Merchant scans PACK (RESERVED -> PACKED)
    const packRes = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({
        action: 'PACK',
        scanMode: 'QR_TOKEN',
        qrToken: s.qrTokenA,
        scanId: 'scan-pack-001',
        assignedPartnerUserId: s.partner1.userId,
        locationRef: 'CHN-BAY-1',
      });
    expect(packRes.status).toBe(200);
    expect(packRes.body.package.status).toBe('PACKED');
    expect(packRes.body.verifiedKeyId).toBe('k1');

    // 2. Capture PayPal payment so Gate 1 allows DISPATCH
    const ppCreate = await request(s.app)
      .post('/api/payments/paypal/create-order')
      .set('Authorization', `Bearer ${s.customerA.token}`)
      .set('Idempotency-Key', 'p4-create-001')
      .send({ orderId: s.orderId });
    expect(ppCreate.status).toBe(201);

    const ppCap = await request(s.app)
      .post(`/api/payments/paypal/capture/${ppCreate.body.paypalOrderId}`)
      .set('Authorization', `Bearer ${s.customerA.token}`)
      .set('Idempotency-Key', 'p4-cap-001')
      .send({});
    expect(ppCap.status).toBe(200);
    expect(ppCap.body.transaction.state).toBe('CAPTURED');

    // 3. Payment-gated DISPATCH scan (PACKED -> DISPATCHED)
    const dispatchRes = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({
        action: 'DISPATCH',
        scanMode: 'QR_TOKEN',
        qrToken: s.qrTokenA,
        scanId: 'scan-dispatch-001',
      });
    expect(dispatchRes.status).toBe(200);
    expect(dispatchRes.body.package.status).toBe('DISPATCHED');
    expect(dispatchRes.body.package.currentCustodian.custodianType).toBe('DELIVERY_PARTNER');
    expect(dispatchRes.body.orderUpdated).toBe(true);
    expect(s.orders.get(s.orderId)!.status).toBe('DISPATCHED');

    // 4. Assigned partner scans DELIVER (DISPATCHED -> WITH_CUSTOMER)
    const deliverRes = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.partner1.token}`)
      .send({
        action: 'DELIVER',
        scanMode: 'QR_TOKEN',
        qrToken: s.qrTokenA,
        scanId: 'scan-deliver-001',
      });
    expect(deliverRes.status).toBe(200);
    expect(deliverRes.body.package.status).toBe('WITH_CUSTOMER');
    expect(deliverRes.body.orderUpdated).toBe(true);
    expect(s.orders.get(s.orderId)!.status).toBe('DELIVERED');
    expect(deliverRes.body.passport.reuseCount).toBe(0);
    expect(deliverRes.body.passport.sustainability.verified).toBe(false);

    // Customer inspects PII-free passport on own delivered order
    const custPassport = await request(s.app)
      .get(`/api/packages/${s.packageIdA}/passport`)
      .set('Authorization', `Bearer ${s.customerA.token}`);
    expect(custPassport.status).toBe(200);
    expect(custPassport.body.passport.packageId).toBe(s.packageIdA);
    expect(custPassport.body.passport.ownership.ownerId).toBeUndefined();
    expect(custPassport.body.passport.currentCustodian.label).toBe('Delivered to Recipient');

    // Other customer cannot view Customer A's passport
    const custBPassport = await request(s.app)
      .get(`/api/packages/${s.packageIdA}/passport`)
      .set('Authorization', `Bearer ${s.customerB.token}`);
    expect(custBPassport.status).toBe(403);

    // 5. Collection Centre intake -> inspect pass -> cleaning -> release -> reuseCount increments 0 -> 1!
    for (const [step, action] of [
      ['scan-rc-001', 'RECEIVE_CENTRE'],
      ['scan-ip-001', 'INSPECT_PASS'],
      ['scan-mc-001', 'MARK_CLEANING'],
      ['scan-ra-001', 'RELEASE_AVAILABLE'],
    ] as const) {
      const res = await request(s.app)
        .post(`/api/packages/${s.packageIdA}/scan`)
        .set('Authorization', `Bearer ${s.centre.token}`)
        .send({ action, scanMode: 'QR_TOKEN', qrToken: s.qrTokenA, scanId: step });
      expect(res.status).toBe(200);
    }

    const finalPassport = await request(s.app)
      .get(`/api/packages/${s.packageIdA}/passport`)
      .set('Authorization', `Bearer ${s.merchA.token}`);
    expect(finalPassport.status).toBe(200);
    expect(finalPassport.body.passport.status).toBe('AVAILABLE');
    expect(finalPassport.body.passport.reuseCount).toBe(1);
    expect(finalPassport.body.passport.sustainability.verified).toBe(true);
    expect(finalPassport.body.passport.sustainability.singleUsePackagingAvoided).toBe(1);
    expect(finalPassport.body.passport.lifecycleHistory.length).toBeGreaterThanOrEqual(9);
  });

  it('blocks DISPATCH when payment is NOT CAPTURED (Gate 1 enforcement) and logs REJECTED scan event', async () => {
    const s = await seedStandardPhase4Scenario();

    const packRes = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({
        action: 'PACK',
        scanMode: 'QR_TOKEN',
        qrToken: s.qrTokenA,
        assignedPartnerUserId: s.partner1.userId,
      });
    expect(packRes.status).toBe(200);

    // Attempt dispatch before payment capture
    const dispatchNoPay = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({
        action: 'DISPATCH',
        scanMode: 'QR_TOKEN',
        qrToken: s.qrTokenA,
      });
    expect(dispatchNoPay.status).toBe(409);
    expect(dispatchNoPay.body.error.code).toBe('DISPATCH_PAYMENT_GATE_BLOCKED');

    const rejectedEvents = s.packageEvents.filter((e) => e.outcome === 'REJECTED');
    expect(rejectedEvents.some((e) => e.metadata?.reasonCode === 'DISPATCH_PAYMENT_GATE_BLOCKED')).toBe(
      true
    );
  });

  it('rejects invalid HMAC signatures, tampered QR payloads, cross-package tokens, expired tokens, and unknown packages', async () => {
    const s = await seedStandardPhase4Scenario();

    // 1. Invalid signature
    const parts = s.qrTokenA.split('.');
    const badSigToken = `${parts[0]}.${parts[1]}.${parts[2]}.AAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const rBadSig = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({ action: 'PACK', scanMode: 'QR_TOKEN', qrToken: badSigToken });
    expect(rBadSig.status).toBe(401);
    expect(rBadSig.body.error.code).toBe('INVALID_QR_SIGNATURE');

    // 2. Tampered payload
    const fakePayloadB64 = Buffer.from(
      JSON.stringify({ v: 1, pkg: s.packageIdA, ver: 1, n: 'tamper', iat: 1000, exp: 9999999999 }),
      'utf8'
    ).toString('base64url');
    const tamperedToken = `${parts[0]}.${parts[1]}.${fakePayloadB64}.${parts[3]}`;
    const rTamper = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({ action: 'PACK', scanMode: 'QR_TOKEN', qrToken: tamperedToken });
    expect(rTamper.status).toBe(401);
    expect(rTamper.body.error.code).toBe('INVALID_QR_SIGNATURE');

    // 3. Cross-package token swap (Pkg B valid token scanned against Pkg A)
    const rSwap = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({ action: 'PACK', scanMode: 'QR_TOKEN', qrToken: s.qrTokenB });
    expect(rSwap.status).toBe(401);
    expect(rSwap.body.error.code).toBe('QR_PACKAGE_MISMATCH');

    // 4. Unknown package ID
    const rUnknown = await request(s.app)
      .post('/api/packages/RBX-UNKNOWN-999/scan')
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({ action: 'PACK', scanMode: 'QR_TOKEN', qrToken: s.qrTokenA });
    expect(rUnknown.status).toBe(404);
    expect(rUnknown.body.error.code).toBe('PACKAGE_NOT_FOUND');

    // 5. Expired token unit check
    const issuedPast = s.qrService.issuePackageToken(s.packageIdA, 1, {
      ttlSeconds: 60,
      nowMs: Date.now() - 120_000,
    });
    const pkgRec = await (await import('../src/repositories/phase2Repositories.js'));
    void pkgRec;
    const pkgObj = Array.from(s.packages.values()).find((p) => p.packageId === s.packageIdA)!;
    const expiredCheck = s.qrService.verifyPackageToken(issuedPast.token, {
      ...pkgObj,
      qrTokenHash: issuedPast.tokenHash,
    });
    expect(expiredCheck.valid).toBe(false);
    expect(expiredCheck.code).toBe('QR_TOKEN_EXPIRED');

    // 6. Verify all rejected scans wrote append-only REJECTED events
    expect(s.packageEvents.filter((e) => e.outcome === 'REJECTED').length).toBeGreaterThanOrEqual(4);
  });

  it('supports key rotation seamlessly while enforcing QR revocation, label reprinting, and replay protection', async () => {
    // Mint initial package using old key k0
    const oldKeyQr = new QrService({
      currentKeyId: 'k0',
      currentSecret: 'phase4-test-secret-key-previous-32-chars!',
      defaultTtlSeconds: 86400,
    });
    const s = await seedStandardPhase4Scenario();

    // Replace package A hash with a k0-signed token to simulate a label printed before key rotation
    const k0Issued = oldKeyQr.issuePackageToken(s.packageIdA, 1);
    const pkgEntity = Array.from(s.packages.values()).find((p) => p.packageId === s.packageIdA)!;
    pkgEntity.qrTokenHash = k0Issued.tokenHash;

    // App running current k1 (with k0 in previousKeys) accepts k0 token cleanly
    const rRotated = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({
        action: 'PACK',
        scanMode: 'QR_TOKEN',
        qrToken: k0Issued.token,
        scanId: 'scan-k0-001',
        assignedPartnerUserId: s.partner1.userId,
      });
    expect(rRotated.status).toBe(200);
    expect(rRotated.body.verifiedKeyId).toBe('k0');

    // Duplicate scanId replay MUST be rejected
    const rReplay = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({
        action: 'PACK',
        scanMode: 'QR_TOKEN',
        qrToken: k0Issued.token,
        scanId: 'scan-k0-001',
      });
    expect(rReplay.status).toBe(409);
    expect(rReplay.body.error.code).toBe('DUPLICATE_SCAN_REPLAY');

    // Post-transition invalid state replay (new scanId, still calling PACK when PACKED) MUST be rejected
    const rInvalidState = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({
        action: 'PACK',
        scanMode: 'QR_TOKEN',
        qrToken: k0Issued.token,
        scanId: 'scan-k0-002',
      });
    expect(rInvalidState.status).toBe(409);
    expect(rInvalidState.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Reprint label -> rotates version 1 -> 2 and issues k1 token; old k0 v1 token becomes SUPERSEDED
    const reprintRes = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/qr/reprint`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({ reason: 'Physical label scuffed at loading bay' });
    expect(reprintRes.status).toBe(200);
    expect(reprintRes.body.qrPayload.tokenVersion).toBe(2);
    expect(reprintRes.body.qrPayload.token.startsWith('RBXQR:v1.k1.')).toBe(true);

    const v2Token = reprintRes.body.qrPayload.token as string;
    const rOldSuperseded = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({
        action: 'QUARANTINE',
        scanMode: 'QR_TOKEN',
        qrToken: k0Issued.token,
      });
    expect(rOldSuperseded.status).toBe(401);
    expect(rOldSuperseded.body.error.code).toBe('QR_TOKEN_SUPERSEDED');

    // Revoke token -> even valid v2 token MUST be rejected with QR_REVOKED
    const revokeRes = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/qr/revoke`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({ reason: 'Suspected counterfeit tag duplication' });
    expect(revokeRes.status).toBe(200);

    const rAfterRevoke = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({
        action: 'QUARANTINE',
        scanMode: 'QR_TOKEN',
        qrToken: v2Token,
      });
    expect(rAfterRevoke.status).toBe(403);
    expect(rAfterRevoke.body.error.code).toBe('QR_REVOKED');
  });

  it('enforces auth, cross-merchant tenant isolation, unassigned partner rejection, role restrictions, and supervised manual fallback', async () => {
    const s = await seedStandardPhase4Scenario();

    // Unauthenticated scan & passport read rejected
    const rUnauthScan = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .send({ action: 'PACK', scanMode: 'QR_TOKEN', qrToken: s.qrTokenA });
    expect(rUnauthScan.status).toBe(401);

    const rUnauthPass = await request(s.app).get(`/api/packages/${s.packageIdA}/passport`);
    expect(rUnauthPass.status).toBe(401);

    // Cross-merchant scan & passport read rejected (Merchant B vs Merchant A package)
    const rCrossScan = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchB.token}`)
      .send({ action: 'PACK', scanMode: 'QR_TOKEN', qrToken: s.qrTokenA });
    expect(rCrossScan.status).toBe(403);
    expect(rCrossScan.body.error.code).toBe('CROSS_TENANT_SCAN_DENIED');

    const rCrossPass = await request(s.app)
      .get(`/api/packages/${s.packageIdA}/passport`)
      .set('Authorization', `Bearer ${s.merchB.token}`);
    expect(rCrossPass.status).toBe(403);

    // Customer denied both QR scan and manual fallback
    const rCustScan = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.customerA.token}`)
      .send({ action: 'PACK', scanMode: 'QR_TOKEN', qrToken: s.qrTokenA });
    expect(rCustScan.status).toBe(403);

    const rCustManual = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.customerA.token}`)
      .send({ action: 'PACK', scanMode: 'MANUAL_SUPERVISED', manualReason: 'Customer trying override' });
    expect(rCustManual.status).toBe(403);
    expect(rCustManual.body.error.code).toBe('MANUAL_FALLBACK_FORBIDDEN');

    // Manual supervised fallback by authorized merchant works only with clear reason, then capture & dispatch cleanly
    const rManualShort = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({ action: 'PACK', scanMode: 'MANUAL_SUPERVISED', manualReason: 'short' });
    expect(rManualShort.status).toBe(400);
    expect(rManualShort.body.error.code).toBe('MANUAL_REASON_REQUIRED');

    const rManualValid = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({
        action: 'PACK',
        scanMode: 'MANUAL_SUPERVISED',
        manualReason: 'Thermal label smudged prior to bay handover',
      });
    expect(rManualValid.status).toBe(200);
    expect(rManualValid.body.scanMode).toBe('MANUAL_SUPERVISED');

    // Assign Partner 1 via dedicated endpoint, capture PayPal payment, dispatch via Partner 1
    const assignRes = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/assign-partner`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({ partnerUserId: s.partner1.userId });
    expect(assignRes.status).toBe(200);

    const ppCreate = await request(s.app)
      .post('/api/payments/paypal/create-order')
      .set('Authorization', `Bearer ${s.customerA.token}`)
      .set('Idempotency-Key', 'p4-iso-c1')
      .send({ orderId: s.orderId });
    await request(s.app)
      .post(`/api/payments/paypal/capture/${ppCreate.body.paypalOrderId}`)
      .set('Authorization', `Bearer ${s.customerA.token}`)
      .set('Idempotency-Key', 'p4-iso-cap1')
      .send({});

    // Unassigned Partner 2 CANNOT dispatch or view Partner 1's assigned package
    const rP2Dispatch = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.partner2.token}`)
      .send({ action: 'DISPATCH', scanMode: 'QR_TOKEN', qrToken: s.qrTokenA });
    expect(rP2Dispatch.status).toBe(403);
    expect(rP2Dispatch.body.error.code).toBe('PARTNER_NOT_ASSIGNED');

    const rP2Pass = await request(s.app)
      .get(`/api/packages/${s.packageIdA}/passport`)
      .set('Authorization', `Bearer ${s.partner2.token}`);
    expect(rP2Pass.status).toBe(403);

    // Assigned Partner 1 dispatches, then Partner 2 STILL blocked from DELIVER
    const rP1Dispatch = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.partner1.token}`)
      .send({ action: 'DISPATCH', scanMode: 'QR_TOKEN', qrToken: s.qrTokenA });
    expect(rP1Dispatch.status).toBe(200);

    const rP2Deliver = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.partner2.token}`)
      .send({ action: 'DELIVER', scanMode: 'QR_TOKEN', qrToken: s.qrTokenA });
    expect(rP2Deliver.status).toBe(403);
    expect(rP2Deliver.body.error.code).toBe('PARTNER_NOT_ASSIGNED');

    // Outbox emitted atomic passport & package_event records throughout
    expect(s.outboxEntries.some((o) => o.entityType === 'passport' && o.entityId === s.packageIdA)).toBe(true);
    expect(s.outboxEntries.some((o) => o.entityType === 'package_event')).toBe(true);
  });

  it('permits multiple lifecycle events without scanId across same & different packages while enforcing unique non-null scanIds per package via partial index semantics', async () => {
    const s = await seedStandardPhase4Scenario();

    // At seed time, Package A already has PACKAGE_CREATED & PACKAGE_RESERVED without scanId,
    // and Package B has PACKAGE_CREATED without scanId.
    const initialNoScanEventsA = s.packageEvents.filter(
      (e) => e.packageId === s.packageIdA && e.scanId === undefined
    );
    expect(initialNoScanEventsA.length).toBeGreaterThanOrEqual(2);

    // Generate additional non-scanId lifecycle events for Package A:
    // rejected scan, partner assignment, label reprint, plus manual scan without scanId
    await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchB.token}`)
      .send({ action: 'PACK', scanMode: 'QR_TOKEN', qrToken: s.qrTokenA });

    const assignRes = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/assign-partner`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({ partnerUserId: s.partner1.userId });
    expect(assignRes.status).toBe(200);

    const reprintRes = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/qr/reprint`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({ reason: 'Verifying multiple events without scanId on same package' });
    expect(reprintRes.status).toBe(200);
    const v2Token = reprintRes.body.qrPayload.token as string;

    const packNoScanId = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.merchA.token}`)
      .send({ action: 'PACK', scanMode: 'QR_TOKEN', qrToken: v2Token });
    expect(packNoScanId.status).toBe(200);

    // Also create a second event without scanId on Package B (label reprint)
    const reprintBRes = await request(s.app)
      .post(`/api/packages/${s.packageIdB}/qr/reprint`)
      .set('Authorization', `Bearer ${s.merchB.token}`)
      .send({ reason: 'Package B non-scanId event' });
    expect(reprintBRes.status).toBe(200);

    const noScanEventsA = s.packageEvents.filter(
      (e) => e.packageId === s.packageIdA && e.scanId === undefined
    );
    const noScanEventsB = s.packageEvents.filter(
      (e) => e.packageId === s.packageIdB && e.scanId === undefined
    );
    expect(noScanEventsA.length).toBeGreaterThanOrEqual(6);
    expect(noScanEventsB.length).toBeGreaterThanOrEqual(2);

    // Capture payment, then test multiple distinct non-null scanIds vs duplicate scanId replay on Package A
    const ppCreate = await request(s.app)
      .post('/api/payments/paypal/create-order')
      .set('Authorization', `Bearer ${s.customerA.token}`)
      .set('Idempotency-Key', 'p4-idx-create')
      .send({ orderId: s.orderId });
    expect(ppCreate.status).toBe(201);
    await request(s.app)
      .post(`/api/payments/paypal/capture/${ppCreate.body.paypalOrderId}`)
      .set('Authorization', `Bearer ${s.customerA.token}`)
      .set('Idempotency-Key', 'p4-idx-cap')
      .send({});

    const dispatchRes = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.partner1.token}`)
      .send({
        action: 'DISPATCH',
        scanMode: 'QR_TOKEN',
        qrToken: v2Token,
        scanId: 'scan-unique-dispatch-1',
      });
    expect(dispatchRes.status).toBe(200);

    const replaySameScanId = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.partner1.token}`)
      .send({
        action: 'DELIVER',
        scanMode: 'QR_TOKEN',
        qrToken: v2Token,
        scanId: 'scan-unique-dispatch-1',
      });
    expect(replaySameScanId.status).toBe(409);
    expect(replaySameScanId.body.error.code).toBe('DUPLICATE_SCAN_REPLAY');

    const deliverDifferentScanId = await request(s.app)
      .post(`/api/packages/${s.packageIdA}/scan`)
      .set('Authorization', `Bearer ${s.partner1.token}`)
      .send({
        action: 'DELIVER',
        scanMode: 'QR_TOKEN',
        qrToken: v2Token,
        scanId: 'scan-unique-deliver-2',
      });
    expect(deliverDifferentScanId.status).toBe(200);
    expect(deliverDifferentScanId.body.package.status).toBe('WITH_CUSTOMER');
  });
});
