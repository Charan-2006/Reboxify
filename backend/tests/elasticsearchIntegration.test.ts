import crypto from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import {
  OrderModel,
  PackageEventModel,
  PackageModel,
  ReturnModel,
  SearchOutboxModel,
  SearchReindexJobModel,
  TransactionModel,
} from '../src/models/index.js';
import {
  BusinessDto,
  BusinessRepository,
  OrderDto,
  OrderRepository,
  PackageDto,
  PackageRepository,
  PaginatedResult,
} from '../src/repositories/phase2Repositories.js';
import { TransactionDto, TransactionRepository } from '../src/repositories/phase3Repositories.js';
import { ReturnDto, ReturnRepository } from '../src/repositories/phase5Repositories.js';
import { signAuthToken } from '../src/middleware/auth.js';
import { AuthService, StoredUserRecord, UserRepository } from '../src/services/authService.js';
import {
  BulkSearchOperation,
  BulkSearchResult,
  SearchEngineClient,
  SearchHealthReport,
  SearchIdsQuery,
  SearchIdsResult,
  SearchIndexKey,
} from '../src/services/elasticsearchClient.js';
import { SearchService } from '../src/services/searchService.js';
import {
  SearchSyncService,
  buildOrderSearchDoc,
  buildPackageSearchDoc,
  buildReturnSearchDoc,
  buildTransactionSearchDoc,
} from '../src/services/searchSyncService.js';
import { WorkerLeaseStore, WorkerRunner } from '../src/services/workerRunner.js';

function oid() {
  return new mongoose.Types.ObjectId().toString();
}

class InMemorySearchEngine implements SearchEngineClient {
  public configured = true;
  public outage = false;
  public bulkFailIds = new Set<string>();
  public indices = new Map<string, Map<string, Record<string, unknown>>>();

  isConfigured(): boolean {
    return this.configured;
  }

  getIndexName(key: SearchIndexKey): string {
    return `reboxify_test_${key}`;
  }

  async checkHealth(): Promise<SearchHealthReport> {
    if (!this.configured) {
      return { configured: false, status: 'NOT_CONFIGURED', checkedAt: new Date().toISOString() };
    }
    if (this.outage) {
      return {
        configured: true,
        status: 'DEGRADED',
        message: 'Simulated ES cluster unreachable',
        checkedAt: new Date().toISOString(),
      };
    }
    return {
      configured: true,
      status: 'CONNECTED',
      clusterName: 'reboxify-test-es',
      version: '8.15.0',
      checkedAt: new Date().toISOString(),
    };
  }

  async ensureIndices(): Promise<void> {
    if (!this.configured) throw new Error('ES not configured');
    if (this.outage) throw new Error('ECONNREFUSED es:9200');
    for (const k of ['orders', 'packages', 'returns', 'transactions', 'package_events'] as const) {
      const idx = this.getIndexName(k);
      if (!this.indices.has(idx)) {
        this.indices.set(idx, new Map());
      }
    }
  }

  async bulkIndex(operations: BulkSearchOperation[]): Promise<BulkSearchResult> {
    if (this.outage) throw new Error('ETIMEDOUT es bulk');
    const succeededIds: string[] = [];
    const failedItems: Array<{ id: string; reason: string }> = [];
    for (const op of operations) {
      if (this.bulkFailIds.has(op.id)) {
        failedItems.push({ id: op.id, reason: 'Simulated shard write failure' });
        continue;
      }
      if (!this.indices.has(op.index)) this.indices.set(op.index, new Map());
      const store = this.indices.get(op.index)!;
      if (op.action === 'delete') {
        store.delete(op.id);
      } else {
        store.set(op.id, op.document ?? {});
      }
      succeededIds.push(op.id);
    }
    return { succeededIds, failedItems };
  }

  private matchesClause(doc: Record<string, unknown>, clause: Record<string, unknown>): boolean {
    if ('match_all' in clause) return true;
    if ('term' in clause) {
      const term = clause.term as Record<string, unknown>;
      for (const [k, v] of Object.entries(term)) {
        const val = doc[k];
        if (Array.isArray(val)) {
          if (!val.includes(v)) return false;
        } else if (val !== v) {
          return false;
        }
      }
      return true;
    }
    if ('multi_match' in clause) {
      const mm = clause.multi_match as { query: string; fields?: string[] };
      const needle = mm.query.toLowerCase();
      return Object.values(doc).some((v) => {
        if (typeof v === 'string') return v.toLowerCase().includes(needle);
        if (Array.isArray(v)) return v.some((x) => String(x).toLowerCase().includes(needle));
        return false;
      });
    }
    if ('bool' in clause) {
      const b = clause.bool as {
        filter?: Record<string, unknown>[];
        must?: Record<string, unknown>[];
        should?: Record<string, unknown>[];
      };
      if (b.filter && !b.filter.every((c) => this.matchesClause(doc, c))) return false;
      if (b.must && !b.must.every((c) => this.matchesClause(doc, c))) return false;
      if (b.should && b.should.length > 0 && !b.should.some((c) => this.matchesClause(doc, c))) {
        return false;
      }
      return true;
    }
    return true;
  }

  async searchIds(params: SearchIdsQuery): Promise<SearchIdsResult> {
    if (this.outage) throw new Error('Elasticsearch cluster unreachable');
    const store = this.indices.get(params.index) ?? new Map();
    const matched = Array.from(store.values()).filter((d) => this.matchesClause(d, params.query));
    const sortSpec = params.sort[0] ?? {};
    const sortField = Object.keys(sortSpec)[0] ?? 'createdAt';
    const sortDir = (sortSpec[sortField] as { order?: string })?.order === 'asc' ? 1 : -1;

    matched.sort((a, b) => {
      const av = String(a[sortField] ?? '');
      const bv = String(b[sortField] ?? '');
      return av.localeCompare(bv) * sortDir;
    });

    const sliced = matched.slice(params.from, params.from + params.size);
    return {
      ids: sliced.map((d) => String(d.id)),
      total: matched.length,
    };
  }

  async countIndex(index: string): Promise<number | null> {
    return this.indices.get(index)?.size ?? 0;
  }
}

describe('Workstream B — Elasticsearch Indexing, Outbox Consumer, Search API & Reindex', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('strips all PII/secrets from derived search documents and supports multi-tenant search + pagination + fallback', async () => {
    const merchantA = oid();
    const merchantB = oid();
    const customer1 = oid();
    const customer2 = oid();
    const partner1 = oid();
    const order1Id = oid();
    const order2Id = oid();
    const pkg1ObjId = oid();
    const pkg2ObjId = oid();
    const ret1Id = oid();
    const tx1Id = oid();

    // 1. Verify PII / Secret stripping
    const orderDoc = buildOrderSearchDoc({
      _id: new mongoose.Types.ObjectId(order1Id),
      orderNumber: 'ORD-ALPHA-1001',
      merchantId: new mongoose.Types.ObjectId(merchantA),
      customerId: new mongoose.Types.ObjectId(customer1),
      status: 'ALLOCATED',
      shippingReference: {
        recipientName: 'Secret Customer Name',
        zone: 'Chennai-North',
        addressLine: '99 Secret Street Apt 4B',
        fulfilmentLocation: 'CHN-HUB-01',
      },
      allocatedPackages: [{ packageRef: new mongoose.Types.ObjectId(), packageId: 'RBX-CHN-111', packageClass: 'M', ownerType: 'MERCHANT', depositAmount: 5 }],
      totals: { productSubtotal: 50, depositTotal: 5, shippingTotal: 0, taxTotal: 0, grandTotal: 55 },
      currency: 'USD',
      createdAt: new Date('2026-11-10T10:00:00Z'),
      updatedAt: new Date('2026-11-10T10:00:00Z'),
    } as never);

    expect(JSON.stringify(orderDoc)).not.toContain('Secret Street');
    expect(JSON.stringify(orderDoc)).not.toContain('Secret Customer Name');
    expect(orderDoc.orderNumber).toBe('ORD-ALPHA-1001');
    expect(orderDoc.packageIds).toEqual(['RBX-CHN-111']);

    const pkgDoc = buildPackageSearchDoc({
      _id: new mongoose.Types.ObjectId(pkg1ObjId),
      packageId: 'RBX-CHN-111',
      ownerType: 'MERCHANT',
      ownerId: new mongoose.Types.ObjectId(merchantA),
      packageClass: 'M',
      status: 'AVAILABLE',
      condition: 'GOOD',
      reuseCount: 3,
      fulfilmentLocation: 'CHN-HUB-01',
      currentCustodian: { custodianType: 'MERCHANT', custodianId: merchantA, label: 'Alpha Warehouse', assignedAt: new Date() },
      qrRevoked: false,
      depositAmount: 5,
      currency: 'USD',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    expect(JSON.stringify(pkgDoc)).not.toContain('qrTokenHash');

    const retDoc = buildReturnSearchDoc({
      _id: new mongoose.Types.ObjectId(ret1Id),
      returnNumber: 'RET-ALPHA-901',
      orderId: new mongoose.Types.ObjectId(order1Id),
      packageId: 'RBX-CHN-111',
      merchantId: new mongoose.Types.ObjectId(merchantA),
      customerId: new mongoose.Types.ObjectId(customer1),
      mode: 'PICKUP',
      status: 'PICKUP_SCHEDULED',
      returnMethodDetails: { serviceZone: 'Chennai-North', addressSummary: 'Private Home Addr' },
      assignedPartnerUserId: new mongoose.Types.ObjectId(partner1),
      assignedPartnerName: 'Partner Alpha',
      refundEligibility: { eligible: true, originalDeposit: 5, totalDeductions: 0, calculatedAmount: 5, currency: 'USD', deductionBreakdown: [] },
      isLateReturn: false,
      disputed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    expect(JSON.stringify(retDoc)).not.toContain('Private Home Addr');

    const txDoc = buildTransactionSearchDoc({
      _id: new mongoose.Types.ObjectId(tx1Id),
      orderId: new mongoose.Types.ObjectId(order1Id),
      merchantId: new mongoose.Types.ObjectId(merchantA),
      customerId: new mongoose.Types.ObjectId(customer1),
      paypalOrderId: 'PAYPAL-ORD-XYZ',
      captureId: 'CAP-XYZ',
      depositAllocations: [{ packageId: 'RBX-CHN-111', allocatedDeposit: 5, refundedAmount: 0, pendingRefundAmount: 0 }],
      state: 'CAPTURED',
      amount: 55,
      currency: 'USD',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    expect(txDoc.paypalOrderId).toBe('PAYPAL-ORD-XYZ');

    // 2. Wire in-memory ES + authoritative stores into createApp()
    const es = new InMemorySearchEngine();
    await es.ensureIndices();
    await es.bulkIndex([
      { action: 'upsert', index: es.getIndexName('orders'), id: order1Id, document: orderDoc },
      {
        action: 'upsert',
        index: es.getIndexName('orders'),
        id: order2Id,
        document: {
          ...orderDoc,
          id: order2Id,
          orderNumber: 'ORD-BETA-2002',
          merchantId: merchantB,
          customerId: customer2,
          status: 'DELIVERED',
        },
      },
      { action: 'upsert', index: es.getIndexName('packages'), id: pkg1ObjId, document: pkgDoc },
      {
        action: 'upsert',
        index: es.getIndexName('packages'),
        id: pkg2ObjId,
        document: { ...pkgDoc, id: pkg2ObjId, packageId: 'RBX-BETA-222', ownerId: merchantB, custodianId: merchantB },
      },
      { action: 'upsert', index: es.getIndexName('returns'), id: ret1Id, document: retDoc },
      { action: 'upsert', index: es.getIndexName('transactions'), id: tx1Id, document: txDoc },
    ]);

    const orderDto1: OrderDto = {
      id: order1Id,
      orderNumber: 'ORD-ALPHA-1001',
      merchantId: merchantA,
      customerId: customer1,
      items: [],
      shippingReference: { recipientName: 'R1', zone: 'Chennai-North', addressLine: 'A1', fulfilmentLocation: 'CHN-HUB-01' },
      allocatedPackages: [{ packageRef: pkg1ObjId, packageId: 'RBX-CHN-111', packageClass: 'M', ownerType: 'MERCHANT', depositAmount: 5 }],
      totals: { productSubtotal: 50, depositTotal: 5, shippingTotal: 0, taxTotal: 0, grandTotal: 55 },
      currency: 'USD',
      status: 'ALLOCATED',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const orderDto2: OrderDto = {
      ...orderDto1,
      id: order2Id,
      orderNumber: 'ORD-BETA-2002',
      merchantId: merchantB,
      customerId: customer2,
      status: 'DELIVERED',
    };
    const orderMap = new Map<string, OrderDto>([
      [order1Id, orderDto1],
      [order2Id, orderDto2],
    ]);

    const users = new Map<string, StoredUserRecord>();
    const addUser = (id: string, email: string, role: StoredUserRecord['role'], businessId?: string): StoredUserRecord => {
      const u: StoredUserRecord = { id, name: email, email, passwordHash: 'x', role, status: 'ACTIVE', businessId };
      users.set(id, u);
      return u;
    };
    const admin = addUser(oid(), 'admin@es.test', 'ADMIN');
    const merchAdminA = addUser(oid(), 'ma@es.test', 'MERCHANT_ADMIN', merchantA);
    const cust1 = addUser(customer1, 'c1@es.test', 'CUSTOMER');

    const authService = new AuthService({
      async findByEmail(e) { return Array.from(users.values()).find((u) => u.email === e) ?? null; },
      async findById(id) { return users.get(id) ?? null; },
      async create() { throw new Error('unused'); },
    } as UserRepository);

    const orderRepo: Partial<OrderRepository> = {
      async findById(id) { return orderMap.get(id) ?? null; },
      async list(f): Promise<PaginatedResult<OrderDto>> {
        const all = Array.from(orderMap.values()).filter((o) => {
          if (f.merchantId && o.merchantId !== f.merchantId) return false;
          if (f.customerId && o.customerId !== f.customerId) return false;
          if (f.search && !o.orderNumber.toLowerCase().includes(f.search.toLowerCase())) return false;
          return true;
        });
        return { items: all.slice((f.page - 1) * f.pageSize, f.page * f.pageSize), total: all.length, page: f.page, pageSize: f.pageSize };
      },
    };
    const bizRepo: Partial<BusinessRepository> = {
      async findById(id): Promise<BusinessDto | null> {
        return { id, ownerUserId: merchAdminA.id, name: 'Alpha', legalName: 'Alpha', slug: 'alpha', currency: 'USD', packagingModel: 'MERCHANT_OWNED', allowCrossMerchantPool: false, policies: { returnWindowDays: 14, autoApproveOnPass: false, depositMultiplier: 1, allowedReturnApprovers: ['ADMIN'] }, status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date() };
      },
    };
    const searchService = new SearchService(
      es,
      new SearchSyncService({ esClient: es }),
      orderRepo as OrderRepository,
      {} as PackageRepository,
      bizRepo as BusinessRepository,
      {} as ReturnRepository,
      {} as TransactionRepository
    );

    const app = createApp({ authService, searchService, esClient: es });
    const toTok = (u: StoredUserRecord) =>
      signAuthToken({ userId: u.id, email: u.email, name: u.name, role: u.role, businessId: u.businessId });
    const adminToken = toTok(admin);
    const merchAToken = toTok(merchAdminA);
    const cust1Token = toTok(cust1);

    // Merchant A querying Merchant B is rejected cleanly with 403 cross-tenant forbidden;
    // querying without merchantId returns only Merchant A orders!
    const merchCross = await request(app)
      .get(`/api/search/orders?q=ORD-&merchantId=${merchantB}`)
      .set('Authorization', `Bearer ${merchAToken}`);
    expect(merchCross.status).toBe(403);

    const merchRes = await request(app)
      .get('/api/search/orders?q=ORD-')
      .set('Authorization', `Bearer ${merchAToken}`);
    expect(merchRes.status).toBe(200);
    expect(merchRes.body.searchEngine).toBe('ELASTICSEARCH');
    expect(merchRes.body.items).toHaveLength(1);
    expect(merchRes.body.items[0].orderNumber).toBe('ORD-ALPHA-1001');

    // Customer 1 sees only own order
    const custRes = await request(app)
      .get('/api/search/orders?q=ORD-')
      .set('Authorization', `Bearer ${cust1Token}`);
    expect(custRes.status).toBe(200);
    expect(custRes.body.items).toHaveLength(1);
    expect(custRes.body.items[0].orderNumber).toBe('ORD-ALPHA-1001');

    // Admin sees both + pagination works
    const adminPage1 = await request(app)
      .get('/api/search/orders?q=ORD-&page=1&pageSize=1&sortBy=orderNumber&sortDir=asc')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminPage1.status).toBe(200);
    expect(adminPage1.body.total).toBe(2);
    expect(adminPage1.body.items[0].orderNumber).toBe('ORD-ALPHA-1001');

    // Truthful CONNECTED health
    const healthOk = await request(app).get('/api/health');
    expect(healthOk.status).toBe(200);
    expect(healthOk.body.integrations.statuses.elasticsearch).toBe('CONNECTED');

    // 3. Elasticsearch outage falls back seamlessly to MONGODB_FALLBACK without breaking API + health becomes DEGRADED
    es.outage = true;
    const fallbackRes = await request(app)
      .get('/api/search/orders?q=ALPHA')
      .set('Authorization', `Bearer ${merchAToken}`);
    expect(fallbackRes.status).toBe(200);
    expect(fallbackRes.body.searchEngine).toBe('MONGODB_FALLBACK');
    expect(fallbackRes.body.items).toHaveLength(1);

    const healthDeg = await request(app).get('/api/health');
    expect(healthDeg.status).toBe(200);
    expect(healthDeg.body.integrations.statuses.elasticsearch).toBe('DEGRADED');

    // Customer blocked from /api/search/inventory
    const custInv = await request(app)
      .get('/api/search/inventory?q=RBX')
      .set('Authorization', `Bearer ${cust1Token}`);
    expect(custInv.status).toBe(403);
  });

  it('processes SearchOutbox idempotently, deletes missing entities, retries failures with bounded backoff, and keeps worker reconciliation isolated from ES outage', async () => {
    const es = new InMemorySearchEngine();
    const orderId = oid();
    const deletedOrderId = oid();
    const batchOutbox = [
      { _id: new mongoose.Types.ObjectId(), entityType: 'order' as const, entityId: orderId, operation: 'UPSERT' as const, attemptCount: 0, status: 'PENDING' as const },
      { _id: new mongoose.Types.ObjectId(), entityType: 'order' as const, entityId: orderId, operation: 'UPSERT' as const, attemptCount: 0, status: 'PENDING' as const },
      { _id: new mongoose.Types.ObjectId(), entityType: 'order' as const, entityId: deletedOrderId, operation: 'UPSERT' as const, attemptCount: 0, status: 'PENDING' as const },
    ];
    const states = new Map<string, { status: string; attemptCount: number; nextRetryAt?: Date; lastError?: string }>();
    for (const o of batchOutbox) states.set(o._id.toString(), { status: 'PENDING', attemptCount: 0 });

    let claimIdx = 0;
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    vi.spyOn(SearchOutboxModel, 'findOneAndUpdate').mockImplementation((() => ({
      lean: async () => {
        const next = batchOutbox[claimIdx++];
        if (!next) return null;
        states.get(next._id.toString())!.status = 'PROCESSING';
        return next;
      },
    })) as never);
    vi.spyOn(SearchOutboxModel, 'updateMany').mockImplementation((async (filter: any, update: any) => {
      const ids: mongoose.Types.ObjectId[] = filter._id.$in;
      for (const id of ids) {
        const st = states.get(id.toString())!;
        st.status = update.$set.status;
      }
      return { modifiedCount: ids.length };
    }) as never);
    vi.spyOn(SearchOutboxModel, 'updateOne').mockImplementation((async (filter: any, update: any) => {
      const st = states.get(filter._id.toString())!;
      st.status = update.$set.status;
      st.attemptCount = update.$set.attemptCount;
      st.nextRetryAt = update.$set.nextRetryAt;
      st.lastError = update.$set.lastError;
      return { modifiedCount: 1 };
    }) as never);

    vi.spyOn(OrderModel, 'findById').mockImplementation(((id: string) => ({
      lean: async () =>
        id === orderId
          ? {
              _id: new mongoose.Types.ObjectId(orderId),
              orderNumber: 'ORD-OUTBOX-1',
              merchantId: new mongoose.Types.ObjectId(),
              customerId: new mongoose.Types.ObjectId(),
              status: 'PAID',
              shippingReference: { zone: 'South', fulfilmentLocation: 'HUB-1' },
              allocatedPackages: [],
              totals: { depositTotal: 5, grandTotal: 50 },
              currency: 'USD',
              createdAt: new Date(),
              updatedAt: new Date(),
            }
          : null,
    })) as never);

    const sync = new SearchSyncService({ esClient: es, maxBackoffMs: 60_000 });
    const summary1 = await sync.processPendingOutbox(10);
    expect(summary1.checked).toBe(3);
    // 2 duplicate events coalesced into 1 upsert + 1 deleted entity -> 1 indexed, 1 deleted
    expect(summary1.indexed).toBe(1);
    expect(summary1.deleted).toBe(1);
    expect(summary1.failed).toBe(0);
    expect(states.get(batchOutbox[0]._id.toString())?.status).toBe('COMPLETED');
    expect(states.get(batchOutbox[1]._id.toString())?.status).toBe('COMPLETED');
    expect(states.get(batchOutbox[2]._id.toString())?.status).toBe('COMPLETED');

    // Simulate outage retry backoff
    claimIdx = 0;
    es.outage = true;
    const summaryFail = await sync.processPendingOutbox(10);
    expect(summaryFail.failed).toBe(3);
    expect(states.get(batchOutbox[0]._id.toString())?.status).toBe('FAILED');
    expect(states.get(batchOutbox[0]._id.toString())?.attemptCount).toBe(1);
    expect(states.get(batchOutbox[0]._id.toString())?.lastError).toContain('ECONNREFUSED');
    expect(sync.computeNextRetryAt(10, new Date(0)).getTime()).toBeLessThanOrEqual(60_000);

    // WorkerRunner remains OK on PayPal cycle even if ES throws
    const leaseStore: WorkerLeaseStore = {
      async tryAcquire() { return true; },
      async recordOutcome() {},
      async release() {},
    };
    const runner = new WorkerRunner({
      leaseStore,
      paymentService: { async reconcileStuckPendingCaptures() { return { checked: 1, resolved: 1, failed: 0 }; } },
      returnService: { async reconcileStuckPendingRefunds() { return { checked: 0, resolved: 0, failed: 0 }; } },
      webhookService: { async retryFailedWebhooks() { return { checked: 0, processed: 0, ignored: 0, failed: 0 }; } },
      searchSyncService: { async processPendingOutbox() { throw new Error('ES cluster down'); } },
    });
    const cycle = await runner.runOnce();
    expect(cycle.skipped).toBe(false);
    expect(cycle.captures?.resolved).toBe(1);
    expect(cycle.search?.failed).toBe(1);
    await runner.stop();
  });

  it('supports resumable cursor-batched reindex after failure without loading entire collections into memory', async () => {
    const es = new InMemorySearchEngine();
    const ord1 = { _id: new mongoose.Types.ObjectId(), orderNumber: 'ORD-R1', merchantId: new mongoose.Types.ObjectId(), customerId: new mongoose.Types.ObjectId(), status: 'PAID', shippingReference: { zone: 'Z1', fulfilmentLocation: 'H1' }, allocatedPackages: [], totals: { depositTotal: 5, grandTotal: 55 }, currency: 'USD', createdAt: new Date(), updatedAt: new Date() };
    const jobs = new Map<string, any>();

    vi.spyOn(SearchReindexJobModel, 'create').mockImplementation((async (doc: any) => {
      const saved = { ...doc, save: async () => saved };
      jobs.set(doc.jobId, saved);
      return saved;
    }) as never);
    vi.spyOn(SearchReindexJobModel, 'findOne').mockImplementation((async (q: any) => jobs.get(q.jobId) ?? null) as never);

    vi.spyOn(OrderModel, 'find').mockImplementation(((q: any) => ({
      sort: () => ({
        limit: () => ({
          lean: async () => (q._id ? [] : [ord1]),
        }),
      }),
    })) as never);
    vi.spyOn(PackageModel, 'find').mockImplementation((() => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) })) as never);
    vi.spyOn(ReturnModel, 'find').mockImplementation((() => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) })) as never);
    vi.spyOn(TransactionModel, 'find').mockImplementation((() => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) })) as never);

    const sync = new SearchSyncService({ esClient: es });
    // Fail first attempt during ES outage
    es.outage = true;
    const failedJob = await sync.reindexAll({ requestedBy: 'admin-1', batchSize: 10 });
    expect(failedJob.status).toBe('FAILED');

    // Recover ES and resume the exact job
    es.outage = false;
    const resumed = await sync.reindexAll({ requestedBy: 'admin-1', resumeJobId: failedJob.jobId, batchSize: 10 });
    expect(resumed.jobId).toBe(failedJob.jobId);
    expect(resumed.status).toBe('COMPLETED');
    expect(resumed.processedCounts.orders).toBe(1);
    expect(await es.countIndex(es.getIndexName('orders'))).toBe(1);
  });
});
