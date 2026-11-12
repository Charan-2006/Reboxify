import mongoose from 'mongoose';
import { resolveMerchantScope } from '../middleware/rbac.js';
import {
  BusinessModel,
  OrderModel,
  PackageModel,
  ReindexEntityScope,
  ReturnModel,
  SearchOutboxModel,
  SearchReindexJobModel,
  TransactionModel,
} from '../models/index.js';
import { OrderDto, OrderRepository, PackageDto, PackageRepository, PaginatedResult, MongooseBusinessRepository, MongooseOrderRepository, MongoosePackageRepository, BusinessRepository, mapPackageDto } from '../repositories/phase2Repositories.js';
import { MongooseTransactionRepository, TransactionDto, TransactionRepository } from '../repositories/phase3Repositories.js';
import { MongooseReturnRepository, ReturnDto, ReturnRepository } from '../repositories/phase5Repositories.js';
import { AuthPrincipal, InspectionCondition, OrderStatus, PackageClass, PackageOwnerType, PackageStatus, PaymentStatus, ReturnMode, ReturnStatus } from '../types/domain.js';
import { forbidden } from '../utils/errors.js';
import { SearchEngineClient, SearchHealthReport, defaultSearchEngineClient } from './elasticsearchClient.js';
import { ReindexResultSummary, SearchSyncService, defaultSearchSyncService } from './searchSyncService.js';

export type SearchEntityParam = 'orders' | 'packages' | 'inventory' | 'returns' | 'transactions';

export interface SearchQueryInput {
  q?: string;
  merchantId?: string;
  status?: string;
  mode?: ReturnMode;
  condition?: string;
  packageClass?: PackageClass;
  ownerType?: PackageOwnerType;
  refundStatus?: PaymentStatus;
  page: number;
  pageSize: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

export interface SearchResponse<T> extends PaginatedResult<T> {
  searchEngine: 'ELASTICSEARCH' | 'MONGODB_FALLBACK';
  degradedReason?: string;
}

export interface SearchStatusSnapshot {
  elasticsearch: SearchHealthReport;
  outbox: {
    pending: number;
    processing: number;
    failed: number;
    completed: number;
  };
  indices: Record<string, number | null>;
  latestReindexJob?: {
    jobId: string;
    status: string;
    currentEntity?: string;
    processedCounts: Record<string, number>;
    failedCount: number;
    lastError?: string;
    startedAt: string;
    finishedAt?: string;
  };
}

export class SearchService {
  constructor(
    private readonly es: SearchEngineClient = defaultSearchEngineClient,
    private readonly syncService: SearchSyncService = defaultSearchSyncService,
    private readonly orders: OrderRepository = new MongooseOrderRepository(),
    private readonly packages: PackageRepository = new MongoosePackageRepository(),
    private readonly businesses: BusinessRepository = new MongooseBusinessRepository(),
    private readonly returns: ReturnRepository = new MongooseReturnRepository(),
    private readonly transactions: TransactionRepository = new MongooseTransactionRepository()
  ) {}

  async searchOrders(
    input: SearchQueryInput,
    caller: AuthPrincipal
  ): Promise<SearchResponse<OrderDto>> {
    if (!['CUSTOMER', 'MERCHANT_ADMIN', 'MERCHANT_STAFF', 'ADMIN'].includes(caller.role)) {
      throw forbidden('Order search is restricted to customers, merchants, and admins.');
    }

    const tenantFilters: Array<Record<string, unknown>> = [];
    let scopedMerchantId = input.merchantId;
    let scopedCustomerId: string | undefined;

    if (caller.role === 'CUSTOMER') {
      scopedCustomerId = caller.userId;
      scopedMerchantId = undefined;
      tenantFilters.push({ term: { customerId: caller.userId } });
    } else if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      scopedMerchantId = resolveMerchantScope(caller, input.merchantId);
      tenantFilters.push({ term: { merchantId: scopedMerchantId } });
    } else if (scopedMerchantId) {
      tenantFilters.push({ term: { merchantId: scopedMerchantId } });
    }

    if (input.status) {
      tenantFilters.push({ term: { status: input.status } });
    }

    const fallback = async (reason?: string): Promise<SearchResponse<OrderDto>> => {
      const res = await this.orders.list({
        merchantId: scopedMerchantId,
        customerId: scopedCustomerId,
        status: input.status as OrderStatus | undefined,
        search: input.q,
        page: input.page,
        pageSize: input.pageSize,
        sortBy: input.sortBy,
        sortDir: input.sortDir,
      });
      return { ...res, searchEngine: 'MONGODB_FALLBACK', ...(reason ? { degradedReason: reason } : {}) };
    };

    if (!this.es.isConfigured()) {
      return fallback();
    }

    try {
      const must: Array<Record<string, unknown>> = [];
      if (input.q?.trim()) {
        must.push({
          multi_match: {
            query: input.q.trim(),
            fields: ['orderNumber^3', 'orderNumber.text^2', 'packageIds.text^2', 'zone', 'fulfilmentLocation'],
            type: 'best_fields',
            fuzziness: 'AUTO',
          },
        });
      }

      const sortFieldMap: Record<string, string> = {
        orderNumber: 'orderNumber',
        status: 'status',
        grandTotal: 'grandTotal',
        depositTotal: 'depositTotal',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      };
      const sortField = (input.sortBy && sortFieldMap[input.sortBy]) || 'createdAt';
      const sortDir = input.sortDir === 'asc' ? 'asc' : 'desc';

      const esRes = await this.es.searchIds({
        index: this.es.getIndexName('orders'),
        query: { bool: { filter: tenantFilters, must: must.length > 0 ? must : [{ match_all: {} }] } },
        sort: [{ [sortField]: { order: sortDir } }],
        from: (input.page - 1) * input.pageSize,
        size: input.pageSize,
      });

      const items = await this.hydrateOrdersByIds(esRes.ids, caller);
      return {
        items,
        total: esRes.total,
        page: input.page,
        pageSize: input.pageSize,
        searchEngine: 'ELASTICSEARCH',
      };
    } catch (err) {
      return fallback(err instanceof Error ? err.message : 'Elasticsearch unavailable');
    }
  }

  async searchInventoryOrPackages(
    input: SearchQueryInput,
    caller: AuthPrincipal
  ): Promise<SearchResponse<PackageDto>> {
    if (!['MERCHANT_ADMIN', 'MERCHANT_STAFF', 'COLLECTION_CENTRE', 'ADMIN'].includes(caller.role)) {
      throw forbidden('Inventory search requires merchant, collection centre, or admin access.');
    }

    let scopedMerchantId = input.merchantId;
    let includeSharedPool = false;

    const tenantFilters: Array<Record<string, unknown>> = [];
    if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      scopedMerchantId = resolveMerchantScope(caller, input.merchantId);
      const business = scopedMerchantId ? await this.businesses.findById(scopedMerchantId) : null;
      includeSharedPool = business ? business.packagingModel !== 'MERCHANT_OWNED' : false;

      if (scopedMerchantId) {
        const should: Array<Record<string, unknown>> = [
          { term: { ownerId: scopedMerchantId } },
          { term: { custodianId: scopedMerchantId } },
        ];
        if (includeSharedPool) {
          should.push({ term: { ownerType: 'REBOXIFY_POOL' } });
        }
        tenantFilters.push({ bool: { should, minimum_should_match: 1 } });
      }
    } else if (scopedMerchantId) {
      tenantFilters.push({
        bool: {
          should: [
            { term: { ownerId: scopedMerchantId } },
            { term: { custodianId: scopedMerchantId } },
          ],
          minimum_should_match: 1,
        },
      });
    }

    if (input.status) tenantFilters.push({ term: { status: input.status } });
    if (input.packageClass) tenantFilters.push({ term: { packageClass: input.packageClass } });
    if (input.ownerType) tenantFilters.push({ term: { ownerType: input.ownerType } });
    if (input.condition) tenantFilters.push({ term: { condition: input.condition } });

    const fallback = async (reason?: string): Promise<SearchResponse<PackageDto>> => {
      const res = await this.packages.list({
        merchantId: scopedMerchantId,
        includeSharedPool,
        status: input.status as PackageStatus | undefined,
        packageClass: input.packageClass,
        ownerType: input.ownerType,
        condition: input.condition as PackageDto['condition'] | undefined,
        search: input.q,
        page: input.page,
        pageSize: input.pageSize,
        sortBy: input.sortBy,
        sortDir: input.sortDir,
      });
      return { ...res, searchEngine: 'MONGODB_FALLBACK', ...(reason ? { degradedReason: reason } : {}) };
    };

    if (!this.es.isConfigured()) {
      return fallback();
    }

    try {
      const must: Array<Record<string, unknown>> = [];
      if (input.q?.trim()) {
        must.push({
          multi_match: {
            query: input.q.trim(),
            fields: ['packageId^3', 'packageId.text^2', 'fulfilmentLocation^2', 'custodianLabel', 'assignedPartnerName'],
            fuzziness: 'AUTO',
          },
        });
      }

      const sortFieldMap: Record<string, string> = {
        packageId: 'packageId',
        packageClass: 'packageClass',
        status: 'status',
        condition: 'condition',
        reuseCount: 'reuseCount',
        updatedAt: 'updatedAt',
      };
      const sortField = (input.sortBy && sortFieldMap[input.sortBy]) || 'updatedAt';
      const sortDir = input.sortDir === 'asc' ? 'asc' : 'desc';

      const esRes = await this.es.searchIds({
        index: this.es.getIndexName('packages'),
        query: { bool: { filter: tenantFilters, must: must.length > 0 ? must : [{ match_all: {} }] } },
        sort: [{ [sortField]: { order: sortDir } }],
        from: (input.page - 1) * input.pageSize,
        size: input.pageSize,
      });

      const items = await this.hydratePackagesByIds(esRes.ids, caller, scopedMerchantId, includeSharedPool);
      return {
        items,
        total: esRes.total,
        page: input.page,
        pageSize: input.pageSize,
        searchEngine: 'ELASTICSEARCH',
      };
    } catch (err) {
      return fallback(err instanceof Error ? err.message : 'Elasticsearch unavailable');
    }
  }

  async searchReturns(
    input: SearchQueryInput,
    caller: AuthPrincipal
  ): Promise<SearchResponse<ReturnDto>> {
    const tenantFilters: Array<Record<string, unknown>> = [];
    let scopedMerchantId = input.merchantId;
    let scopedCustomerId: string | undefined;
    let scopedPartnerId: string | undefined;

    if (caller.role === 'CUSTOMER') {
      scopedCustomerId = caller.userId;
      scopedMerchantId = undefined;
      tenantFilters.push({ term: { customerId: caller.userId } });
    } else if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      scopedMerchantId = resolveMerchantScope(caller, input.merchantId);
      tenantFilters.push({ term: { merchantId: scopedMerchantId } });
    } else if (caller.role === 'DELIVERY_PARTNER') {
      scopedPartnerId = caller.userId;
      scopedMerchantId = undefined;
      tenantFilters.push({ term: { assignedPartnerUserId: caller.userId } });
    } else if (caller.role !== 'ADMIN' && caller.role !== 'COLLECTION_CENTRE') {
      throw forbidden('Unauthorized role for return search.');
    } else if (scopedMerchantId) {
      tenantFilters.push({ term: { merchantId: scopedMerchantId } });
    }

    if (input.status) tenantFilters.push({ term: { status: input.status } });
    if (input.mode) tenantFilters.push({ term: { mode: input.mode } });
    if (input.condition) tenantFilters.push({ term: { inspectionCondition: input.condition } });

    const fallback = async (reason?: string): Promise<SearchResponse<ReturnDto>> => {
      const res = await this.returns.list({
        merchantId: scopedMerchantId,
        customerId: scopedCustomerId,
        assignedPartnerUserId: scopedPartnerId,
        status: input.status as ReturnStatus | undefined,
        mode: input.mode,
        condition: input.condition as InspectionCondition | undefined,
        refundStatus: input.refundStatus,
        search: input.q,
        page: input.page,
        pageSize: input.pageSize,
        sortBy: input.sortBy,
        sortDir: input.sortDir,
      });
      return { ...res, searchEngine: 'MONGODB_FALLBACK', ...(reason ? { degradedReason: reason } : {}) };
    };

    if (!this.es.isConfigured() || input.refundStatus) {
      return fallback();
    }

    try {
      const must: Array<Record<string, unknown>> = [];
      if (input.q?.trim()) {
        must.push({
          multi_match: {
            query: input.q.trim(),
            fields: ['returnNumber^3', 'returnNumber.text^2', 'packageId^2', 'packageId.text^2', 'serviceZone', 'assignedPartnerName'],
            fuzziness: 'AUTO',
          },
        });
      }

      const sortFieldMap: Record<string, string> = {
        returnNumber: 'returnNumber',
        status: 'status',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      };
      const sortField = (input.sortBy && sortFieldMap[input.sortBy]) || 'updatedAt';
      const sortDir = input.sortDir === 'asc' ? 'asc' : 'desc';

      const esRes = await this.es.searchIds({
        index: this.es.getIndexName('returns'),
        query: { bool: { filter: tenantFilters, must: must.length > 0 ? must : [{ match_all: {} }] } },
        sort: [{ [sortField]: { order: sortDir } }],
        from: (input.page - 1) * input.pageSize,
        size: input.pageSize,
      });

      const items = await this.hydrateReturnsByIds(esRes.ids, caller);
      return {
        items,
        total: esRes.total,
        page: input.page,
        pageSize: input.pageSize,
        searchEngine: 'ELASTICSEARCH',
      };
    } catch (err) {
      return fallback(err instanceof Error ? err.message : 'Elasticsearch unavailable');
    }
  }

  async searchTransactions(
    input: SearchQueryInput,
    caller: AuthPrincipal
  ): Promise<SearchResponse<TransactionDto>> {
    if (!['CUSTOMER', 'MERCHANT_ADMIN', 'MERCHANT_STAFF', 'ADMIN'].includes(caller.role)) {
      throw forbidden('Transaction search is restricted to customers, merchants, and admins.');
    }

    const tenantFilters: Array<Record<string, unknown>> = [];
    let scopedMerchantId = input.merchantId;
    let scopedCustomerId: string | undefined;

    if (caller.role === 'CUSTOMER') {
      scopedCustomerId = caller.userId;
      scopedMerchantId = undefined;
      tenantFilters.push({ term: { customerId: caller.userId } });
    } else if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      scopedMerchantId = resolveMerchantScope(caller, input.merchantId);
      tenantFilters.push({ term: { merchantId: scopedMerchantId } });
    } else if (scopedMerchantId) {
      tenantFilters.push({ term: { merchantId: scopedMerchantId } });
    }

    if (input.status) tenantFilters.push({ term: { state: input.status } });

    const fallback = async (reason?: string): Promise<SearchResponse<TransactionDto>> => {
      const res = await this.transactions.list({
        merchantId: scopedMerchantId,
        customerId: scopedCustomerId,
        state: input.status as PaymentStatus | undefined,
        search: input.q,
        page: input.page,
        pageSize: input.pageSize,
        sortBy: input.sortBy,
        sortDir: input.sortDir,
      });
      return { ...res, searchEngine: 'MONGODB_FALLBACK', ...(reason ? { degradedReason: reason } : {}) };
    };

    if (!this.es.isConfigured()) {
      return fallback();
    }

    try {
      const must: Array<Record<string, unknown>> = [];
      if (input.q?.trim()) {
        must.push({
          multi_match: {
            query: input.q.trim(),
            fields: ['paypalOrderId^3', 'paypalOrderId.text^2', 'captureId^3', 'captureId.text^2', 'packageIds.text'],
            fuzziness: 'AUTO',
          },
        });
      }

      const sortFieldMap: Record<string, string> = {
        amount: 'amount',
        state: 'state',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      };
      const sortField = (input.sortBy && sortFieldMap[input.sortBy]) || 'updatedAt';
      const sortDir = input.sortDir === 'asc' ? 'asc' : 'desc';

      const esRes = await this.es.searchIds({
        index: this.es.getIndexName('transactions'),
        query: { bool: { filter: tenantFilters, must: must.length > 0 ? must : [{ match_all: {} }] } },
        sort: [{ [sortField]: { order: sortDir } }],
        from: (input.page - 1) * input.pageSize,
        size: input.pageSize,
      });

      const items = await this.hydrateTransactionsByIds(esRes.ids, caller);
      return {
        items,
        total: esRes.total,
        page: input.page,
        pageSize: input.pageSize,
        searchEngine: 'ELASTICSEARCH',
      };
    } catch (err) {
      return fallback(err instanceof Error ? err.message : 'Elasticsearch unavailable');
    }
  }

  async getStatus(): Promise<SearchStatusSnapshot> {
    const esHealth = await this.es.checkHealth(true);
    let outbox = { pending: 0, processing: 0, failed: 0, completed: 0 };
    let latestReindexJob: SearchStatusSnapshot['latestReindexJob'];

    if (mongoose.connection.readyState === 1) {
      const [pending, processing, failed, completed, latestJob] = await Promise.all([
        SearchOutboxModel.countDocuments({ status: 'PENDING' }),
        SearchOutboxModel.countDocuments({ status: 'PROCESSING' }),
        SearchOutboxModel.countDocuments({ status: 'FAILED' }),
        SearchOutboxModel.countDocuments({ status: 'COMPLETED' }),
        SearchReindexJobModel.findOne({}).sort({ createdAt: -1 }).lean(),
      ]);
      outbox = { pending, processing, failed, completed };
      if (latestJob) {
        latestReindexJob = {
          jobId: latestJob.jobId,
          status: latestJob.status,
          ...(latestJob.currentEntity ? { currentEntity: latestJob.currentEntity } : {}),
          processedCounts: {
            orders: latestJob.processedCounts?.orders ?? 0,
            packages: latestJob.processedCounts?.packages ?? 0,
            returns: latestJob.processedCounts?.returns ?? 0,
            transactions: latestJob.processedCounts?.transactions ?? 0,
          },
          failedCount: latestJob.failedCount ?? 0,
          ...(latestJob.lastError ? { lastError: latestJob.lastError } : {}),
          startedAt: new Date(latestJob.startedAt).toISOString(),
          ...(latestJob.finishedAt
            ? { finishedAt: new Date(latestJob.finishedAt).toISOString() }
            : {}),
        };
      }
    }

    const indices: Record<string, number | null> = {};
    if (esHealth.status === 'CONNECTED') {
      for (const k of ['orders', 'packages', 'returns', 'transactions', 'package_events'] as const) {
        const idxName = this.es.getIndexName(k);
        indices[idxName] = await this.es.countIndex(idxName);
      }
    }

    return {
      elasticsearch: esHealth,
      outbox,
      indices,
      ...(latestReindexJob ? { latestReindexJob } : {}),
    };
  }

  async triggerReindex(
    params: {
      entities?: ReindexEntityScope[];
      merchantId?: string;
      batchSize?: number;
      resumeJobId?: string;
    },
    caller: AuthPrincipal
  ): Promise<ReindexResultSummary> {
    if (caller.role !== 'ADMIN') {
      throw forbidden('Only ADMIN may trigger Elasticsearch index rebuilds.');
    }
    if (params.merchantId) {
      const biz = await BusinessModel.findById(params.merchantId).lean();
      if (!biz) throw forbidden('Target merchant business does not exist.');
    }
    return this.syncService.reindexAll({
      requestedBy: caller.userId,
      entities: params.entities,
      merchantId: params.merchantId,
      batchSize: params.batchSize,
      resumeJobId: params.resumeJobId,
    });
  }

  private async hydrateOrdersByIds(ids: string[], caller: AuthPrincipal): Promise<OrderDto[]> {
    const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) return [];
    const results = await Promise.all(validIds.map((id) => this.orders.findById(id)));
    const map = new Map<string, OrderDto>();
    for (const o of results) {
      if (!o) continue;
      if (caller.role === 'CUSTOMER' && o.customerId !== caller.userId) continue;
      if (
        (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') &&
        o.merchantId !== caller.businessId
      ) {
        continue;
      }
      map.set(o.id, o);
    }
    return validIds.map((id) => map.get(id)).filter((x): x is OrderDto => Boolean(x));
  }

  private async hydratePackagesByIds(
    ids: string[],
    caller: AuthPrincipal,
    scopedMerchantId: string | undefined,
    includeSharedPool: boolean
  ): Promise<PackageDto[]> {
    const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) return [];
    const docs = await PackageModel.find({
      _id: { $in: validIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).lean();
    const byId = new Map(docs.map((d) => [d._id.toString(), d]));
    const ordered: PackageDto[] = [];
    for (const id of validIds) {
      const d = byId.get(id);
      if (!d) continue;
      if (
        (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') &&
        scopedMerchantId
      ) {
        const owns = d.ownerId?.toString() === scopedMerchantId;
        const holds = d.currentCustodian?.custodianId === scopedMerchantId;
        const poolAllowed = includeSharedPool && d.ownerType === 'REBOXIFY_POOL';
        if (!owns && !holds && !poolAllowed) continue;
      }
      ordered.push(mapPackageDto(d));
    }
    return ordered;
  }

  private async hydrateReturnsByIds(ids: string[], caller: AuthPrincipal): Promise<ReturnDto[]> {
    const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) return [];
    const results = await Promise.all(validIds.map((id) => this.returns.findById(id)));
    const map = new Map<string, ReturnDto>();
    for (const r of results) {
      if (!r) continue;
      if (caller.role === 'CUSTOMER' && r.customerId !== caller.userId) continue;
      if (
        (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') &&
        r.merchantId !== caller.businessId
      ) {
        continue;
      }
      if (caller.role === 'DELIVERY_PARTNER' && r.assignedPartnerUserId !== caller.userId) continue;
      map.set(r.id, r);
    }
    return validIds.map((id) => map.get(id)).filter((x): x is ReturnDto => Boolean(x));
  }

  private async hydrateTransactionsByIds(
    ids: string[],
    caller: AuthPrincipal
  ): Promise<TransactionDto[]> {
    const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) return [];
    const results = await Promise.all(validIds.map((id) => this.transactions.findById(id)));
    const map = new Map<string, TransactionDto>();
    for (const tx of results) {
      if (!tx) continue;
      if (caller.role === 'CUSTOMER' && tx.customerId !== caller.userId) continue;
      if (
        (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') &&
        tx.merchantId !== caller.businessId
      ) {
        continue;
      }
      map.set(tx.id, tx);
    }
    return validIds.map((id) => map.get(id)).filter((x): x is TransactionDto => Boolean(x));
  }
}

export const defaultSearchService = new SearchService();
