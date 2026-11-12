import crypto from 'node:crypto';
import { ClientSession } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  BusinessDto,
  BusinessRepository,
  OrderAllocatedPackageDto,
  OrderDto,
  OrderRepository,
  PackageDto,
  PackageRepository,
  PaginatedResult,
  ProductDto,
  ProductRepository,
} from '../src/repositories/phase2Repositories.js';
import { AuditWriter } from '../src/services/auditService.js';
import { AuthService, StoredUserRecord, UserRepository } from '../src/services/authService.js';
import { BusinessService, TransactionRunner } from '../src/services/businessService.js';
import { OrderService } from '../src/services/orderService.js';
import { PackagingService } from '../src/services/packagingService.js';
import { ProductService } from '../src/services/productService.js';
import { OrderStatus, PackageClass, PackageOwnerType, PackageStatus, UserRole } from '../src/types/domain.js';

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

class MemoryStore {
  users = new Map<string, StoredUserRecord>();
  businesses = new Map<string, BusinessDto>();
  products = new Map<string, ProductDto>();
  packages = new Map<string, PackageDto>();
  orders = new Map<string, OrderDto>();
  packageEvents: Array<{ packageId: string; type: string; orderId?: string }> = [];
  searchOutbox: Array<{ entityType: string; entityId: string }> = [];
  auditEntries: Array<{ action: string; entityId: string }> = [];
}

function buildPhase2TestApp() {
  const store = new MemoryStore();

  const runTx: TransactionRunner = async <T>(work: (session: ClientSession | null) => Promise<T>) => {
    return work(null);
  };

  const audit: AuditWriter = {
    async record(entry) {
      store.auditEntries.push({ action: entry.action, entityId: entry.entityId });
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
      const dto: ProductDto = { id, ...input, createdAt: now, updatedAt: now };
      store.products.set(id, dto);
      return dto;
    },
    async findByMerchantAndIds(merchantId, productIds) {
      return Array.from(store.products.values()).filter(
        (p) => p.merchantId === merchantId && productIds.includes(p.id)
      );
    },
    async listByMerchant(filters) {
      let items = Array.from(store.products.values());
      if (filters.merchantId) items = items.filter((p) => p.merchantId === filters.merchantId);
      if (filters.activeOnly) items = items.filter((p) => p.active);
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
    },
  };

  const packageRepo: PackageRepository = {
    async create(input) {
      const id = newId();
      const now = new Date();
      const dto: PackageDto = { id, ...input, createdAt: now, updatedAt: now };
      store.packages.set(id, dto);
      store.packageEvents.push({ packageId: dto.packageId, type: 'PACKAGE_CREATED' });
      store.searchOutbox.push({ entityType: 'passport', entityId: dto.packageId });
      return dto;
    },
    async findByPackageId(packageId) {
      for (const p of store.packages.values()) {
        if (p.packageId === packageId) return p;
      }
      return null;
    },
    async list(filters): Promise<PaginatedResult<PackageDto>> {
      let items = Array.from(store.packages.values());
      if (filters.merchantId) {
        items = items.filter(
          (p) =>
            p.ownerId === filters.merchantId ||
            (filters.includeSharedPool && p.ownerType === 'REBOXIFY_POOL') ||
            p.currentCustodian.custodianId === filters.merchantId
        );
      }
      if (filters.status) items = items.filter((p) => p.status === filters.status);
      if (filters.packageClass) items = items.filter((p) => p.packageClass === filters.packageClass);
      if (filters.ownerType) items = items.filter((p) => p.ownerType === filters.ownerType);
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
    },
    async findCandidatesForAllocation(merchantId, allowSharedPool, allowCrossHybrid) {
      return Array.from(store.packages.values()).filter((p) => {
        if (p.status !== 'AVAILABLE') return false;
        if (p.ownerId === merchantId) return true;
        if (allowSharedPool && p.ownerType === 'REBOXIFY_POOL') return true;
        if (allowCrossHybrid && p.ownerType === 'HYBRID') return true;
        return false;
      });
    },
    async reservePackagesAtomically(reservations) {
      const reserved: PackageDto[] = [];
      for (const r of reservations) {
        const pkg = store.packages.get(r.packageRefId);
        if (!pkg || pkg.status !== 'AVAILABLE') return null;
        pkg.status = 'RESERVED';
        pkg.currentOrderId = r.orderId;
        pkg.currentCustodian = {
          custodianType: 'MERCHANT',
          custodianId: r.merchantId,
          label: r.merchantCustodianLabel,
          assignedAt: new Date(),
        };
        store.packageEvents.push({
          packageId: pkg.packageId,
          type: 'PACKAGE_RESERVED',
          orderId: r.orderId,
        });
        store.searchOutbox.push({ entityType: 'passport', entityId: pkg.packageId });
        reserved.push(pkg);
      }
      return reserved;
    },
  };

  const orderRepo: OrderRepository = {
    async create(input) {
      const id = newId();
      const now = new Date();
      const dto: OrderDto = { id, ...input, createdAt: now, updatedAt: now };
      store.orders.set(id, dto);
      return dto;
    },
    async findById(id) {
      return store.orders.get(id) ?? null;
    },
    async list(filters) {
      let items = Array.from(store.orders.values());
      if (filters.merchantId) items = items.filter((o) => o.merchantId === filters.merchantId);
      if (filters.customerId) items = items.filter((o) => o.customerId === filters.customerId);
      if (filters.status) items = items.filter((o) => o.status === filters.status);
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
  const orderService = new OrderService(
    orderRepo,
    productRepo,
    businessRepo,
    packageRepo,
    audit,
    runTx
  );

  const app = createApp({
    authService,
    businessService,
    productService,
    packagingService,
    orderService,
  });

  return { app, store, authService };
}

describe('Phase 2 HTTP API Integration: Businesses, Products, Inventory, Orders & Allocation', () => {
  it('enforces admin business approval, merchant tenant isolation, ownership vs custody, and idempotent order allocation', async () => {
    const { app, store, authService } = buildPhase2TestApp();

    const adminAuth = await authService.register(
      { name: 'Admin User', email: 'admin@reboxify.test', password: 'Password123!', role: 'ADMIN' },
      { userId: 'seed', email: 'seed', name: 'Seed', role: 'ADMIN' }
    );
    const applicantRes = await request(app).post('/api/auth/register').send({
      name: 'Merchant A Applicant',
      email: 'merch-a@test.com',
      password: 'Password123!',
    });
    expect(applicantRes.status).toBe(201);

    // Non-admin applies to onboard business -> starts in ONBOARDING
    const applyRes = await request(app)
      .post('/api/businesses')
      .set('Authorization', `Bearer ${applicantRes.body.token}`)
      .send({
        name: 'EcoBrand A',
        legalName: 'EcoBrand A Pvt Ltd',
        slug: 'ecobrand-a',
        packagingModel: 'HYBRID',
      });
    expect(applyRes.status).toBe(201);
    expect(applyRes.body.business.status).toBe('ONBOARDING');
    const bizAId = applyRes.body.business.id;

    // Non-admin cannot approve their own business
    const selfApprove = await request(app)
      .patch(`/api/businesses/${bizAId}/status`)
      .set('Authorization', `Bearer ${applicantRes.body.token}`)
      .send({ status: 'ACTIVE' });
    expect(selfApprove.status).toBe(403);

    // Admin approves Business A -> upgrades owner user to MERCHANT_ADMIN + links businessId
    const approveRes = await request(app)
      .patch(`/api/businesses/${bizAId}/status`)
      .set('Authorization', `Bearer ${adminAuth.token}`)
      .send({ status: 'ACTIVE' });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.business.status).toBe('ACTIVE');

    // Re-login Merchant A to get fresh JWT with MERCHANT_ADMIN & businessId
    const merchALogin = await request(app).post('/api/auth/login').send({
      email: 'merch-a@test.com',
      password: 'Password123!',
      expectedRole: 'MERCHANT_ADMIN',
    });
    expect(merchALogin.status).toBe(200);
    const merchAToken = merchALogin.body.token;

    // Admin creates Business B & Merchant B user
    const bizBRes = await request(app)
      .post('/api/businesses')
      .set('Authorization', `Bearer ${adminAuth.token}`)
      .send({
        name: 'Brand B',
        legalName: 'Brand B Inc',
        slug: 'brand-b',
        packagingModel: 'MERCHANT_OWNED',
      });
    const bizBId = bizBRes.body.business.id;
    const merchBAuth = await authService.register(
      {
        name: 'Merchant B',
        email: 'merch-b@test.com',
        password: 'Password123!',
        role: 'MERCHANT_ADMIN',
        businessId: bizBId,
      },
      { userId: adminAuth.user.userId, email: adminAuth.user.email, name: 'Admin', role: 'ADMIN' }
    );

    // Merchant A creates a SKU; Merchant B cannot create product under Merchant A's tenant
    const crossProd = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${merchBAuth.token}`)
      .send({
        merchantId: bizAId,
        sku: 'HACK-01',
        name: 'Forbidden',
        dimensionsCm: { length: 10, width: 10, height: 5 },
        weightKg: 0.5,
        unitPrice: 10,
      });
    expect(crossProd.status).toBe(403);

    const prodARes = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${merchAToken}`)
      .send({
        sku: 'MUG-01',
        name: 'Ceramic Mug',
        dimensionsCm: { length: 14, width: 11, height: 9 },
        weightKg: 0.7,
        fragility: 'MEDIUM',
        rotatable: true,
        unitPrice: 20,
      });
    expect(prodARes.status).toBe(201);
    const prodAId = prodARes.body.product.id;

    // Merchant A cannot register REBOXIFY_POOL packages (only ADMIN can)
    const forbidPoolMint = await request(app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${merchAToken}`)
      .send({
        ownerType: 'REBOXIFY_POOL',
        packageClass: 'M',
        fulfilmentLocation: 'CHN-HUB-01',
      });
    expect(forbidPoolMint.status).toBe(403);

    // Admin registers a shared REBOXIFY_POOL Class M box; Merchant B registers a private MERCHANT Class S box
    const poolPkgRes = await request(app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${adminAuth.token}`)
      .send({
        packageId: 'RBX-CHN-POOL01',
        ownerType: 'REBOXIFY_POOL',
        packageClass: 'M',
        fulfilmentLocation: 'CHN-HUB-01',
      });
    expect(poolPkgRes.status).toBe(201);
    expect(poolPkgRes.body.package.currentCustodian.custodianType).toBe('REBOXIFY_CENTRE');

    const merchBPkgRes = await request(app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${merchBAuth.token}`)
      .send({
        packageId: 'RBX-CHN-PRIVB1',
        ownerType: 'MERCHANT',
        packageClass: 'S',
        fulfilmentLocation: 'CHN-HUB-01',
      });
    expect(merchBPkgRes.status).toBe(201);

    // Merchant A's inventory listing shows REBOXIFY_POOL box (HYBRID) and NEVER Merchant B's private box
    const merchAInv = await request(app)
      .get('/api/inventory')
      .set('Authorization', `Bearer ${merchAToken}`);
    expect(merchAInv.status).toBe(200);
    const visibleIds = merchAInv.body.items.map((p: PackageDto) => p.packageId);
    expect(visibleIds).toContain('RBX-CHN-POOL01');
    expect(visibleIds).not.toContain('RBX-CHN-PRIVB1');

    // Customer registers & creates order on EcoBrand A (HYBRID)
    const custRes = await request(app).post('/api/auth/register').send({
      name: 'Bob Buyer',
      email: 'bob@example.com',
      password: 'Password123!',
    });
    expect(custRes.status).toBe(201);

    const orderRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${custRes.body.token}`)
      .send({
        merchantId: bizAId,
        items: [{ productId: prodAId, quantity: 1 }],
        shippingReference: {
          recipientName: 'Bob Buyer',
          zone: 'South-1',
          addressLine: '12 Eco Lane',
          fulfilmentLocation: 'CHN-HUB-01',
        },
        shippingTotal: 4,
      });
    expect(orderRes.status).toBe(201);
    expect(orderRes.body.order.totals.productSubtotal).toBe(20);
    expect(orderRes.body.order.totals.depositTotal).toBe(0);
    expect(orderRes.body.order.totals.grandTotal).toBe(24);
    const orderId = orderRes.body.order.id;

    // Merchant B cannot view or allocate Merchant A's order
    const crossOrder = await request(app)
      .post(`/api/orders/${orderId}/allocate-package`)
      .set('Authorization', `Bearer ${merchBAuth.token}`)
      .send({});
    expect(crossOrder.status).toBe(403);

    // Merchant A allocates package: picks shared pool M box, keeps ownerType REBOXIFY_POOL, updates custody to MERCHANT
    const alloc1 = await request(app)
      .post(`/api/orders/${orderId}/allocate-package`)
      .set('Authorization', `Bearer ${merchAToken}`)
      .send({});
    expect(alloc1.status).toBe(200);
    expect(alloc1.body.alreadyAllocated).toBe(false);
    expect(alloc1.body.order.status).toBe('ALLOCATED');
    expect(alloc1.body.order.allocatedPackages[0].packageId).toBe('RBX-CHN-POOL01');
    expect(alloc1.body.order.allocatedPackages[0].ownerType).toBe('REBOXIFY_POOL');
    expect(alloc1.body.order.totals.depositTotal).toBe(5);
    expect(alloc1.body.order.totals.grandTotal).toBe(29);

    const reservedPkg = Array.from(store.packages.values()).find(
      (p) => p.packageId === 'RBX-CHN-POOL01'
    )!;
    expect(reservedPkg.status).toBe('RESERVED');
    expect(reservedPkg.ownerType).toBe('REBOXIFY_POOL');
    expect(reservedPkg.currentCustodian.custodianType).toBe('MERCHANT');
    expect(reservedPkg.currentCustodian.custodianId).toBe(bizAId);

    // Repeated allocation is idempotent and does NOT allocate another package
    const alloc2 = await request(app)
      .post(`/api/orders/${orderId}/allocate-package`)
      .set('Authorization', `Bearer ${merchAToken}`)
      .send({});
    expect(alloc2.status).toBe(200);
    expect(alloc2.body.alreadyAllocated).toBe(true);
    expect(store.packageEvents.filter((e) => e.type === 'PACKAGE_RESERVED')).toHaveLength(1);
  });

  it('rejects insufficient stock and supports split shipment recommendations cleanly', async () => {
    const { app, authService } = buildPhase2TestApp();
    const adminAuth = await authService.register(
      { name: 'Admin', email: 'admin2@reboxify.test', password: 'Password123!', role: 'ADMIN' },
      { userId: 'seed', email: 'seed', name: 'Seed', role: 'ADMIN' }
    );

    const bizRes = await request(app)
      .post('/api/businesses')
      .set('Authorization', `Bearer ${adminAuth.token}`)
      .send({
        name: 'SplitBrand',
        legalName: 'SplitBrand Ltd',
        slug: 'split-brand',
        packagingModel: 'SHARED_POOL',
      });
    const bizId = bizRes.body.business.id;

    const prodRes = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${adminAuth.token}`)
      .send({
        merchantId: bizId,
        sku: 'SHOE-01',
        name: 'Running Shoes',
        dimensionsCm: { length: 26, width: 20, height: 12 },
        weightKg: 1.5,
        fragility: 'LOW',
        unitPrice: 60,
      });
    const prodId = prodRes.body.product.id;

    const cust = await request(app).post('/api/auth/register').send({
      name: 'Carol',
      email: 'carol@example.com',
      password: 'Password123!',
    });

    const ordRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${cust.body.token}`)
      .send({
        merchantId: bizId,
        items: [{ productId: prodId, quantity: 2 }],
        shippingReference: {
          recipientName: 'Carol',
          zone: 'Zone-1',
          addressLine: '55 Oak Rd',
          fulfilmentLocation: 'CHN-HUB-01',
        },
      });
    const orderId = ordRes.body.order.id;

    // 1. With zero inventory -> 422 INSUFFICIENT_INVENTORY
    const noStockRes = await request(app)
      .post(`/api/orders/${orderId}/allocate-package`)
      .set('Authorization', `Bearer ${adminAuth.token}`)
      .send({});
    expect(noStockRes.status).toBe(422);
    expect(noStockRes.body.error.code).toBe('INSUFFICIENT_INVENTORY');

    // 2. Register two M boxes -> 409 SPLIT_RECOMMENDED, then allowSplit=true -> 200 ALLOCATED_SPLIT
    await request(app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${adminAuth.token}`)
      .send({ packageId: 'RBX-SPL-001', ownerType: 'REBOXIFY_POOL', packageClass: 'M', fulfilmentLocation: 'CHN-HUB-01' });
    await request(app)
      .post('/api/inventory')
      .set('Authorization', `Bearer ${adminAuth.token}`)
      .send({ packageId: 'RBX-SPL-002', ownerType: 'REBOXIFY_POOL', packageClass: 'M', fulfilmentLocation: 'CHN-HUB-01' });

    const splitPrompt = await request(app)
      .post(`/api/orders/${orderId}/allocate-package`)
      .set('Authorization', `Bearer ${adminAuth.token}`)
      .send({ allowSplit: false });
    expect(splitPrompt.status).toBe(409);
    expect(splitPrompt.body.error.code).toBe('SPLIT_RECOMMENDED');

    const splitDone = await request(app)
      .post(`/api/orders/${orderId}/allocate-package`)
      .set('Authorization', `Bearer ${adminAuth.token}`)
      .send({ allowSplit: true });
    expect(splitDone.status).toBe(200);
    expect(splitDone.body.order.allocatedPackages).toHaveLength(2);
    expect(splitDone.body.order.totals.depositTotal).toBe(10);
    expect(splitDone.body.order.totals.grandTotal).toBe(130);
  });
});

