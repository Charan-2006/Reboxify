import { Client as ElasticSdkClient } from '@elastic/elasticsearch';
import { config } from '../config/env.js';

export type SearchIndexKey =
  | 'orders'
  | 'packages'
  | 'returns'
  | 'transactions'
  | 'package_events';

export type ElasticsearchHealthState = 'NOT_CONFIGURED' | 'CONNECTED' | 'DEGRADED';

export interface SearchHealthReport {
  configured: boolean;
  status: ElasticsearchHealthState;
  clusterName?: string;
  version?: string;
  message?: string;
  checkedAt: string;
}

export interface BulkSearchOperation {
  action: 'upsert' | 'delete';
  index: string;
  id: string;
  document?: Record<string, unknown>;
}

export interface BulkSearchResult {
  succeededIds: string[];
  failedItems: Array<{ id: string; reason: string }>;
}

export interface SearchIdsQuery {
  index: string;
  query: Record<string, unknown>;
  sort: Array<Record<string, unknown>>;
  from: number;
  size: number;
}

export interface SearchIdsResult {
  ids: string[];
  total: number;
}

export interface SearchEngineClient {
  isConfigured(): boolean;
  getIndexName(key: SearchIndexKey): string;
  checkHealth(forceProbe?: boolean): Promise<SearchHealthReport>;
  ensureIndices(): Promise<void>;
  bulkIndex(operations: BulkSearchOperation[]): Promise<BulkSearchResult>;
  searchIds(params: SearchIdsQuery): Promise<SearchIdsResult>;
  countIndex(index: string): Promise<number | null>;
}

const INDEX_MAPPINGS: Record<SearchIndexKey, Record<string, unknown>> = {
  orders: {
    properties: {
      id: { type: 'keyword' },
      orderNumber: { type: 'keyword', normalizer: undefined, fields: { text: { type: 'text' } } },
      merchantId: { type: 'keyword' },
      customerId: { type: 'keyword' },
      status: { type: 'keyword' },
      packageIds: { type: 'keyword', fields: { text: { type: 'text' } } },
      zone: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      fulfilmentLocation: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      currency: { type: 'keyword' },
      grandTotal: { type: 'double' },
      depositTotal: { type: 'double' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
    },
  },
  packages: {
    properties: {
      id: { type: 'keyword' },
      packageId: { type: 'keyword', fields: { text: { type: 'text' } } },
      ownerType: { type: 'keyword' },
      ownerId: { type: 'keyword' },
      packageClass: { type: 'keyword' },
      status: { type: 'keyword' },
      condition: { type: 'keyword' },
      reuseCount: { type: 'integer' },
      fulfilmentLocation: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      custodianType: { type: 'keyword' },
      custodianId: { type: 'keyword' },
      custodianLabel: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      assignedPartnerUserId: { type: 'keyword' },
      assignedPartnerName: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      qrRevoked: { type: 'boolean' },
      depositAmount: { type: 'double' },
      currency: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
    },
  },
  returns: {
    properties: {
      id: { type: 'keyword' },
      returnNumber: { type: 'keyword', fields: { text: { type: 'text' } } },
      orderId: { type: 'keyword' },
      packageId: { type: 'keyword', fields: { text: { type: 'text' } } },
      merchantId: { type: 'keyword' },
      customerId: { type: 'keyword' },
      mode: { type: 'keyword' },
      status: { type: 'keyword' },
      serviceZone: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      assignedPartnerUserId: { type: 'keyword' },
      assignedPartnerName: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      inspectionCondition: { type: 'keyword' },
      inspectionOutcome: { type: 'keyword' },
      refundStatus: { type: 'keyword' },
      calculatedAmount: { type: 'double' },
      currency: { type: 'keyword' },
      isLateReturn: { type: 'boolean' },
      disputed: { type: 'boolean' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
    },
  },
  transactions: {
    properties: {
      id: { type: 'keyword' },
      orderId: { type: 'keyword' },
      merchantId: { type: 'keyword' },
      customerId: { type: 'keyword' },
      paypalOrderId: { type: 'keyword', fields: { text: { type: 'text' } } },
      captureId: { type: 'keyword', fields: { text: { type: 'text' } } },
      packageIds: { type: 'keyword', fields: { text: { type: 'text' } } },
      state: { type: 'keyword' },
      providerStatus: { type: 'keyword' },
      amount: { type: 'double' },
      currency: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
    },
  },
  package_events: {
    properties: {
      id: { type: 'keyword' },
      eventId: { type: 'keyword' },
      packageId: { type: 'keyword', fields: { text: { type: 'text' } } },
      merchantId: { type: 'keyword' },
      type: { type: 'keyword' },
      outcome: { type: 'keyword' },
      locationRef: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      actorRole: { type: 'keyword' },
      occurredAt: { type: 'date' },
    },
  },
};

function sanitizeEsErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : 'Elasticsearch request failed';
  return raw.replace(/https?:\/\/[^@\s]+@/gi, 'https://***@').slice(0, 220);
}

export class OfficialElasticsearchClient implements SearchEngineClient {
  private readonly sdkClient: ElasticSdkClient | null;
  private readonly indexPrefix: string;
  private indicesReady = false;
  private cachedHealth: { report: SearchHealthReport; expiresAt: number } | null = null;

  constructor(options?: {
    url?: string;
    apiKey?: string;
    username?: string;
    password?: string;
    indexPrefix?: string;
    requestTimeoutMs?: number;
  }) {
    const url = (options?.url ?? config.elasticsearchUrl)?.trim();
    const apiKey = (options?.apiKey ?? config.elasticsearchApiKey)?.trim();
    const username = (options?.username ?? config.elasticsearchUsername)?.trim();
    const password = (options?.password ?? config.elasticsearchPassword)?.trim();
    this.indexPrefix = (options?.indexPrefix ?? config.elasticsearchIndexPrefix)
      .trim()
      .toLowerCase();

    if (!url) {
      this.sdkClient = null;
      return;
    }

    this.sdkClient = new ElasticSdkClient({
      node: url,
      ...(apiKey
        ? { auth: { apiKey } }
        : username && password
          ? { auth: { username, password } }
          : {}),
      requestTimeout: options?.requestTimeoutMs ?? config.elasticsearchRequestTimeoutMs,
    });
  }

  isConfigured(): boolean {
    return this.sdkClient !== null;
  }

  getIndexName(key: SearchIndexKey): string {
    return `${this.indexPrefix}_${key}`;
  }

  async checkHealth(forceProbe = false): Promise<SearchHealthReport> {
    if (!this.sdkClient) {
      return {
        configured: false,
        status: 'NOT_CONFIGURED',
        checkedAt: new Date().toISOString(),
      };
    }

    const now = Date.now();
    if (!forceProbe && this.cachedHealth && now < this.cachedHealth.expiresAt) {
      return this.cachedHealth.report;
    }

    try {
      const info = await this.sdkClient.info({}, { requestTimeout: 2500 });
      const report: SearchHealthReport = {
        configured: true,
        status: 'CONNECTED',
        clusterName: info.cluster_name,
        version: info.version?.number,
        checkedAt: new Date().toISOString(),
      };
      this.cachedHealth = { report, expiresAt: now + 20_000 };
      return report;
    } catch (err) {
      const report: SearchHealthReport = {
        configured: true,
        status: 'DEGRADED',
        message: sanitizeEsErrorMessage(err),
        checkedAt: new Date().toISOString(),
      };
      this.cachedHealth = { report, expiresAt: now + 10_000 };
      return report;
    }
  }

  async ensureIndices(): Promise<void> {
    if (!this.sdkClient) {
      throw new Error('Elasticsearch client is not configured.');
    }
    if (this.indicesReady) return;

    const keys: SearchIndexKey[] = ['orders', 'packages', 'returns', 'transactions', 'package_events'];
    for (const key of keys) {
      const index = this.getIndexName(key);
      const exists = await this.sdkClient.indices.exists({ index });
      if (!exists) {
        await this.sdkClient.indices.create({
          index,
          mappings: INDEX_MAPPINGS[key] as never,
        });
      }
    }
    this.indicesReady = true;
  }

  async bulkIndex(operations: BulkSearchOperation[]): Promise<BulkSearchResult> {
    if (!this.sdkClient) {
      throw new Error('Elasticsearch client is not configured.');
    }
    if (operations.length === 0) {
      return { succeededIds: [], failedItems: [] };
    }

    const flatOps: Array<Record<string, unknown>> = [];
    for (const op of operations) {
      if (op.action === 'delete') {
        flatOps.push({ delete: { _index: op.index, _id: op.id } });
      } else {
        flatOps.push({ index: { _index: op.index, _id: op.id } });
        flatOps.push(op.document ?? {});
      }
    }

    const res = await this.sdkClient.bulk({
      operations: flatOps,
      refresh: false,
    });

    const succeededIds: string[] = [];
    const failedItems: Array<{ id: string; reason: string }> = [];

    for (const item of res.items ?? []) {
      const outcome = item.index ?? item.delete;
      if (!outcome) continue;
      const id = String(outcome._id ?? '');
      const status = outcome.status ?? 500;
      const okDeleteNotFound = Boolean(item.delete && status === 404);
      if ((status >= 200 && status < 300) || okDeleteNotFound) {
        succeededIds.push(id);
      } else {
        failedItems.push({
          id,
          reason: outcome.error?.reason ?? `Elasticsearch bulk status ${status}`,
        });
      }
    }

    return { succeededIds, failedItems };
  }

  async searchIds(params: SearchIdsQuery): Promise<SearchIdsResult> {
    if (!this.sdkClient) {
      throw new Error('Elasticsearch client is not configured.');
    }

    const res = await this.sdkClient.search({
      index: params.index,
      query: params.query as never,
      sort: params.sort as never,
      from: params.from,
      size: params.size,
      _source: false,
    });

    const rawTotal = res.hits?.total;
    const total = typeof rawTotal === 'number' ? rawTotal : Number(rawTotal?.value ?? 0);
    const ids = (res.hits?.hits ?? [])
      .map((hit) => hit._id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    return { ids, total };
  }

  async countIndex(index: string): Promise<number | null> {
    if (!this.sdkClient) return null;
    try {
      const exists = await this.sdkClient.indices.exists({ index });
      if (!exists) return 0;
      const res = await this.sdkClient.count({ index });
      return res.count;
    } catch {
      return null;
    }
  }
}

export const defaultSearchEngineClient = new OfficialElasticsearchClient();

