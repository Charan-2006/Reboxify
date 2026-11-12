import crypto from 'node:crypto';
import { ClientSession } from 'mongoose';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
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
import { AuditWriter } from '../src/services/auditService.js';
import { AuthService, StoredUserRecord, UserRepository } from '../src/services/authService.js';
import { BusinessService, TransactionRunner } from '../src/services/businessService.js';
import { OrderService } from '../src/services/orderService.js';
import { PackagingService } from '../src/services/packagingService.js';
import { PaymentService } from '../src/services/paymentService.js';
import {
  PayPalClient,
  PayPalClientError,
  PayPalCreateOrderParams,
  PayPalOrderResponse,
} from '../src/services/paypalClient.js';
import { ProductService } from '../src/services/productService.js';
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

function buildPhase3Harness(paypalMock: PayPalClient) {
  const users = new Map<string, StoredUserRecord>();
  const businesses = new Map<string, BusinessDto>();
  const products = new Map<string, ProductDto>();
  const packages = new Map<string, PackageDto>();
  const orders = new Map<string, OrderDto>();
  const transactions = new Map<string, TransactionDto>();
  const auditEntries: Array<{ action: string; entityId: string }> = [];

  const runTx: TransactionRunner = async <T>(work: (s: ClientSession | null) => Promise<T>) =>
    work(null);

  const audit: AuditWriter = {
    async record(entry) {
      auditEntries.push({ action: entry.action, entityId: entry.entityId });
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
      const items = Array.from(businesses.values()).filter(
        (b) => (!filters.status || b.status === filters.status) && (!filters.businessId || b.id === filters.businessId)
      );
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
    },
    async updateStatus(id, status) {
      const b = businesses.get(id);
      if (!b) return null;
      b.status = status;
      return b;
    },
    async updatePolicies() {
      return null;
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
      const id = newId();
      const now = new Date();
      const dto: ProductDto = { id, ...input, createdAt: now, updatedAt: now };
      products.set(id, dto);
      return dto;
    },
    async findByMerchantAndIds(merchantId, ids) {
      return Array.from(products.values()).filter(
        (p) => p.merchantId === merchantId && ids.includes(p.id)
      );
    },
    async listByMerchant(filters) {
      const items = Array.from(products.values()).filter(
        (p) => !filters.merchantId || p.merchantId === filters.merchantId
      );
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
    },
  };

  const packageRepo: PackageRepository = {
    async create(input) {
      const id = newId();
      const now = new Date();
      const dto: PackageDto = { id, ...input, createdAt: now, updatedAt: now };
      packages.set(id, dto);
      return dto;
    },
    async findByPackageId(packageId) {
      for (const p of packages.values()) if (p.packageId === packageId) return p;
      return null;
    },
    async list(filters) {
      const items = Array.from(packages.values());
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
    },
    async findCandidatesForAllocation() {
      return Array.from(packages.values()).filter((p) => p.status === 'AVAILABLE');
    },
    async reservePackagesAtomically(reservations) {
      const res: PackageDto[] = [];
      for (const r of reservations) {
        const p = packages.get(r.packageRefId);
        if (!p || p.status !== 'AVAILABLE') return null;
        p.status = 'RESERVED';
        p.currentOrderId = r.orderId;
        res.push(p);
      }
      return res;
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
      let items = Array.from(orders.values());
      if (filters.merchantId) items = items.filter((o) => o.merchantId === filters.merchantId);
      if (filters.customerId) items = items.filter((o) => o.customerId === filters.customerId);
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
    },
    async applyAllocationAtomically(orderId, update) {
      const ord = orders.get(orderId);
      if (!ord || ord.allocatedPackages.length > 0) return null;
      ord.allocatedPackages = update.allocatedPackages;
      ord.allocationMetadata = update.allocationMetadata;
      ord.totals.depositTotal = update.depositTotal;
      ord.totals.grandTotal = update.grandTotal;
      ord.status = update.status;
      return ord;
    },
  };

  const txRepo: TransactionRepository = {
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
    async findByPayPalOrderId(ppId) {
      for (const t of transactions.values()) {
        if (t.paypalOrderId === ppId) return t;
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
      let items = Array.from(transactions.values());
      if (filters.merchantId) items = items.filter((t) => t.merchantId === filters.merchantId);
      if (filters.customerId) items = items.filter((t) => t.customerId === filters.customerId);
      if (filters.state) items = items.filter((t) => t.state === filters.state);
      return { items, total: items.length, page: filters.page, pageSize: filters.pageSize };
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
  const paymentService = new PaymentService(txRepo, orderRepo, paypalMock, audit, runTx);
  const idempotencyStore = new InMemoryIdempotencyStore();

  const app = createApp({
    authService,
    businessService,
    productService,
    packagingService,
    orderService,
    paymentService,
    idempotencyStore,
  });

  return { app, authService, orders, transactions, auditEntries };
}

async function seedOrderScenario(harness: ReturnType<typeof buildPhase3Harness>) {
  const { app, authService } = harness;
  const admin = await authService.register(
    { name: 'Admin', email: 'admin@test.com', password: 'Password123!', role: 'ADMIN' },
    { userId: 'seed', email: 'seed', name: 'Seed', role: 'ADMIN' }
  );

  const bizA = await request(app)
    .post('/api/businesses')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ name: 'Merchant A', legalName: 'A Corp', slug: 'merchant-a', packagingModel: 'SHARED_POOL' });
  const bizB = await request(app)
    .post('/api/businesses')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ name: 'Merchant B', legalName: 'B Corp', slug: 'merchant-b', packagingModel: 'SHARED_POOL' });

  const merchA = await authService.register(
    { name: 'MA', email: 'ma@test.com', password: 'Password123!', role: 'MERCHANT_ADMIN', businessId: bizA.body.business.id },
    { userId: admin.user.userId, email: admin.user.email, name: 'Admin', role: 'ADMIN' }
  );
  const merchB = await authService.register(
    { name: 'MB', email: 'mb@test.com', password: 'Password123!', role: 'MERCHANT_ADMIN', businessId: bizB.body.business.id },
    { userId: admin.user.userId, email: admin.user.email, name: 'Admin', role: 'ADMIN' }
  );

  const prod = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${merchA.token}`)
    .send({
      sku: 'ITEM-1',
      name: 'Glass Jar',
      dimensionsCm: { length: 12, width: 10, height: 8 },
      weightKg: 0.8,
      unitPrice: 25,
    });

  await request(app)
    .post('/api/inventory')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({
      packageId: 'RBX-PAY-001',
      ownerType: 'REBOXIFY_POOL',
      packageClass: 'S',
      fulfilmentLocation: 'CHN-HUB-01',
    });

  const custA = await request(app).post('/api/auth/register').send({
    name: 'Alice',
    email: 'alice@test.com',
    password: 'Password123!',
  });
  const custB = await request(app).post('/api/auth/register').send({
    name: 'Bob',
    email: 'bob@test.com',
    password: 'Password123!',
  });

  // Order total = $25 product + $3 S-box deposit + $2 shipping = $30.00 USD
  const orderRes = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${custA.body.token}`)
    .send({
      merchantId: bizA.body.business.id,
      items: [{ productId: prod.body.product.id, quantity: 1 }],
      shippingReference: {
        recipientName: 'Alice',
        zone: 'Z1',
        addressLine: '10 Eco St',
        fulfilmentLocation: 'CHN-HUB-01',
      },
      shippingTotal: 2,
      autoAllocate: true,
    });

  return {
    adminToken: admin.token,
    merchAToken: merchA.token,
    merchBToken: merchB.token,
    custAToken: custA.body.token,
    custBToken: custB.body.token,
    order: orderRes.body.order as OrderDto,
  };
}

describe('Phase 3 PayPal Sandbox Checkout & Capture (Mocked PayPal Client)', () => {
  it('creates PayPal order using backend totals, enforces authorization, captures cleanly, and rejects duplicate capture', async () => {
    const createSpy = vi.fn(async (params: PayPalCreateOrderParams): Promise<PayPalOrderResponse> => {
      // Ensure backend used real persisted $30.00 USD total
      expect(params.grandTotal).toBe(30);
      expect(params.currency).toBe('USD');
      return { id: 'PP-ORD-1001', status: 'CREATED' };
    });

    const captureSpy = vi.fn(async (ppId: string): Promise<PayPalOrderResponse> => ({
      id: ppId,
      status: 'COMPLETED',
      purchase_units: [
        {
          reference_id: seeded.order.id,
          payments: {
            captures: [
              {
                id: 'CAP-9001',
                status: 'COMPLETED',
                amount: { currency_code: 'USD', value: '30.00' },
              },
            ],
          },
        },
      ],
    }));

    const paypalMock: PayPalClient = {
      isConfigured: () => true,
      createOrder: createSpy,
      captureOrder: captureSpy,
      getOrder: vi.fn(),
    };

    const harness = buildPhase3Harness(paypalMock);
    const seeded = await seedOrderScenario(harness);
    const { app, orders, transactions } = harness;

    // Public PayPal config never leaks secrets
    const pubCfg = await request(app).get('/api/payments/config');
    expect(pubCfg.status).toBe(200);
    expect(JSON.stringify(pubCfg.body)).not.toContain('CLIENT_SECRET');
    expect(pubCfg.body.currency).toBe('USD');

    // Customer B cannot create PayPal order for Customer A's order
    const crossCreate = await request(app)
      .post('/api/payments/paypal/create-order')
      .set('Authorization', `Bearer ${seeded.custBToken}`)
      .send({ orderId: seeded.order.id });
    expect(crossCreate.status).toBe(403);

    // Customer A creates PayPal order (any extra client amount field is ignored by Zod/backend)
    const createRes = await request(app)
      .post('/api/payments/paypal/create-order')
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .set('Idempotency-Key', 'idem-create-1')
      .send({ orderId: seeded.order.id, amount: 0.01 });
    expect(createRes.status).toBe(201);
    expect(createRes.body.paypalOrderId).toBe('PP-ORD-1001');
    expect(createRes.body.transaction.amount).toBe(30);
    expect(createRes.body.transaction.depositAllocations).toEqual([
      { packageId: 'RBX-PAY-001', allocatedDeposit: 3, refundedAmount: 0, pendingRefundAmount: 0 },
    ]);
    expect(orders.get(seeded.order.id)?.status).toBe('PAYMENT_PENDING');

    // Idempotency-Key conflict check with different payload
    const conflictIdem = await request(app)
      .post('/api/payments/paypal/create-order')
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .set('Idempotency-Key', 'idem-create-1')
      .send({ orderId: 'different-order-id' });
    expect(conflictIdem.status).toBe(409);

    // Customer B & Merchant B cannot read or capture Customer A's payment
    expect(
      (
        await request(app)
          .get('/api/payments/PP-ORD-1001')
          .set('Authorization', `Bearer ${seeded.custBToken}`)
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .get('/api/payments/PP-ORD-1001')
          .set('Authorization', `Bearer ${seeded.merchBToken}`)
      ).status
    ).toBe(403);

    // Invalid PayPal order ID -> 404
    const badIdRes = await request(app)
      .post('/api/payments/paypal/capture/PP-UNKNOWN')
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .send({});
    expect(badIdRes.status).toBe(404);

    // Capture succeeds and verifies amount & currency
    const capRes = await request(app)
      .post('/api/payments/paypal/capture/PP-ORD-1001')
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .send({});
    expect(capRes.status).toBe(200);
    expect(capRes.body.alreadyCaptured).toBe(false);
    expect(capRes.body.transaction.state).toBe('CAPTURED');
    expect(capRes.body.transaction.captureId).toBe('CAP-9001');
    expect(orders.get(seeded.order.id)?.status).toBe('PAID');

    // Duplicate capture attempt -> idempotent 200 without calling PayPal capture a second time
    const dupCap = await request(app)
      .post('/api/payments/paypal/capture/PP-ORD-1001')
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .send({});
    expect(dupCap.status).toBe(200);
    expect(dupCap.body.alreadyCaptured).toBe(true);
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(transactions.size).toBe(1);

    // Cannot cancel an already CAPTURED payment
    const cancelCaptured = await request(app)
      .post('/api/payments/paypal/cancel/PP-ORD-1001')
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .send({});
    expect(cancelCaptured.status).toBe(409);

    // Merchant A sees transaction via /api/transactions; Merchant B sees 0
    const txA = await request(app)
      .get('/api/transactions')
      .set('Authorization', `Bearer ${seeded.merchAToken}`);
    expect(txA.status).toBe(200);
    expect(txA.body.items).toHaveLength(1);

    const txB = await request(app)
      .get('/api/transactions')
      .set('Authorization', `Bearer ${seeded.merchBToken}`);
    expect(txB.status).toBe(200);
    expect(txB.body.items).toHaveLength(0);
  });

  it('rejects amount or currency mismatches, failed captures, and supports checkout cancellation', async () => {
    let mode: 'MISMATCH_AMT' | 'MISMATCH_CURR' | 'DECLINED' = 'MISMATCH_AMT';
    let counter = 1;

    const paypalMock: PayPalClient = {
      isConfigured: () => true,
      createOrder: async () => ({ id: `PP-ERR-${counter++}`, status: 'CREATED' }),
      captureOrder: async (ppId) => {
        if (mode === 'DECLINED') {
          throw new PayPalClientError('PAYPAL_API_ERROR', 'INSTRUMENT_DECLINED', 422);
        }
        return {
          id: ppId,
          status: 'COMPLETED',
          purchase_units: [
            {
              payments: {
                captures: [
                  {
                    id: `CAP-${ppId}`,
                    status: 'COMPLETED',
                    amount:
                      mode === 'MISMATCH_CURR'
                        ? { currency_code: 'EUR', value: '30.00' }
                        : { currency_code: 'USD', value: '10.00' },
                  },
                ],
              },
            },
          ],
        };
      },
      getOrder: vi.fn(),
    };

    const harness = buildPhase3Harness(paypalMock);
    const seeded = await seedOrderScenario(harness);
    const { app, orders } = harness;

    // 1. Cancel checkout restores order back to ALLOCATED
    const cr1 = await request(app)
      .post('/api/payments/paypal/create-order')
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .send({ orderId: seeded.order.id });
    const cancelRes = await request(app)
      .post(`/api/payments/paypal/cancel/${cr1.body.paypalOrderId}`)
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .send({});
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.orderStatus).toBe('ALLOCATED');
    expect(cancelRes.body.transaction.state).toBe('CAPTURE_FAILED');

    // 2. Amount mismatch marks CAPTURE_FAILED and keeps order un-PAID
    mode = 'MISMATCH_AMT';
    const cr2 = await request(app)
      .post('/api/payments/paypal/create-order')
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .send({ orderId: seeded.order.id });
    const capMismatch = await request(app)
      .post(`/api/payments/paypal/capture/${cr2.body.paypalOrderId}`)
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .send({});
    expect(capMismatch.status).toBe(422);
    expect(capMismatch.body.error.code).toBe('PAYMENT_MISMATCH');
    expect(orders.get(seeded.order.id)?.status).toBe('PAYMENT_PENDING');

    // 3. Currency mismatch
    mode = 'MISMATCH_CURR';
    const cr3 = await request(app)
      .post('/api/payments/paypal/create-order')
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .send({ orderId: seeded.order.id });
    const currMismatch = await request(app)
      .post(`/api/payments/paypal/capture/${cr3.body.paypalOrderId}`)
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .send({});
    expect(currMismatch.status).toBe(422);
    expect(currMismatch.body.error.code).toBe('PAYMENT_MISMATCH');

    // 4. Provider declined capture
    mode = 'DECLINED';
    const cr4 = await request(app)
      .post('/api/payments/paypal/create-order')
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .send({ orderId: seeded.order.id });
    const declinedRes = await request(app)
      .post(`/api/payments/paypal/capture/${cr4.body.paypalOrderId}`)
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .send({});
    expect(declinedRes.status).toBe(422);
    expect(declinedRes.body.error.code).toBe('PAYMENT_CAPTURE_FAILED');

    // State-machine validation: capturing an already CAPTURE_FAILED transaction is rejected with 409
    const retryFailed = await request(app)
      .post(`/api/payments/paypal/capture/${cr4.body.paypalOrderId}`)
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .send({});
    expect(retryFailed.status).toBe(409);
    expect(retryFailed.body.error.code).toBe('PAYMENT_NOT_CAPTURABLE');
  });

  it('reconciles uncertain capture timeouts safely with PayPal getOrder and keeps pending states safe', async () => {
    let reconcileOutcome: 'STILL_PENDING' | 'COMPLETED' = 'STILL_PENDING';

    const paypalMock: PayPalClient = {
      isConfigured: () => true,
      createOrder: async () => ({ id: 'PP-TIMEOUT-1', status: 'CREATED' }),
      captureOrder: async () => {
        throw new PayPalClientError('PAYPAL_TIMEOUT', 'Gateway timeout');
      },
      getOrder: async (ppId) => {
        if (reconcileOutcome === 'STILL_PENDING') {
          throw new PayPalClientError('PAYPAL_TIMEOUT', 'Still unreachable');
        }
        return {
          id: ppId,
          status: 'COMPLETED',
          purchase_units: [
            {
              payments: {
                captures: [
                  {
                    id: 'CAP-REC-1',
                    status: 'COMPLETED',
                    amount: { currency_code: 'USD', value: '30.00' },
                  },
                ],
              },
            },
          ],
        };
      },
    };

    const harness = buildPhase3Harness(paypalMock);
    const seeded = await seedOrderScenario(harness);
    const { app, orders } = harness;

    await request(app)
      .post('/api/payments/paypal/create-order')
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .send({ orderId: seeded.order.id });

    // Timeout during capture -> returns 202 CAPTURE_PENDING (never claims PAID!)
    const pendingRes = await request(app)
      .post('/api/payments/paypal/capture/PP-TIMEOUT-1')
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .send({});
    expect(pendingRes.status).toBe(202);
    expect(pendingRes.body.pending).toBe(true);
    expect(pendingRes.body.transaction.state).toBe('CAPTURE_PENDING');
    expect(orders.get(seeded.order.id)?.status).toBe('PAYMENT_PENDING');

    // Subsequent retry reconciles via getOrder without double-capturing -> settles CAPTURED & PAID
    reconcileOutcome = 'COMPLETED';
    const reconciledRes = await request(app)
      .post('/api/payments/paypal/capture/PP-TIMEOUT-1')
      .set('Authorization', `Bearer ${seeded.custAToken}`)
      .send({});
    expect(reconciledRes.status).toBe(200);
    expect(reconciledRes.body.pending).toBe(false);
    expect(reconciledRes.body.transaction.state).toBe('CAPTURED');
    expect(reconciledRes.body.transaction.captureId).toBe('CAP-REC-1');
    expect(orders.get(seeded.order.id)?.status).toBe('PAID');
  });
});
