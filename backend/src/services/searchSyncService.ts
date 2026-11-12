import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {
  IOrder,
  IPackage,
  IPackageEvent,
  IReturn,
  ITransaction,
  OrderModel,
  PackageEventModel,
  PackageModel,
  ReindexEntityScope,
  ReturnModel,
  SearchOutboxModel,
  SearchReindexJobModel,
  TransactionModel,
} from '../models/index.js';
import {
  BulkSearchOperation,
  SearchEngineClient,
  defaultSearchEngineClient,
} from './elasticsearchClient.js';

export interface OutboxProcessSummary {
  skipped: boolean;
  reason?: 'NOT_CONFIGURED' | 'DB_NOT_CONNECTED' | 'NO_PENDING_EVENTS';
  checked: number;
  indexed: number;
  deleted: number;
  failed: number;
}

export interface ReindexResultSummary {
  jobId: string;
  status: 'COMPLETED' | 'FAILED';
  processedCounts: {
    orders: number;
    packages: number;
    returns: number;
    transactions: number;
  };
  failedCount: number;
  lastError?: string;
}

/**
 * Pure operational mappers stripping ALL PII (street addresses, emails, phone numbers),
 * QR secrets, payment credentials, and binary evidence before indexing to Elasticsearch.
 */
export function buildOrderSearchDoc(doc: Pick<IOrder, '_id' | 'orderNumber' | 'merchantId' | 'customerId' | 'status' | 'shippingReference' | 'allocatedPackages' | 'totals' | 'currency' | 'createdAt' | 'updatedAt'>): Record<string, unknown> {
  return {
    id: doc._id.toString(),
    orderNumber: doc.orderNumber,
    merchantId: doc.merchantId.toString(),
    customerId: doc.customerId.toString(),
    status: doc.status,
    packageIds: (doc.allocatedPackages ?? []).map((p) => p.packageId),
    zone: doc.shippingReference?.zone ?? '',
    fulfilmentLocation: doc.shippingReference?.fulfilmentLocation ?? '',
    currency: doc.currency,
    grandTotal: Number(doc.totals?.grandTotal ?? 0),
    depositTotal: Number(doc.totals?.depositTotal ?? 0),
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt,
  };
}

export function buildPackageSearchDoc(doc: Pick<IPackage, '_id' | 'packageId' | 'ownerType' | 'ownerId' | 'packageClass' | 'status' | 'condition' | 'reuseCount' | 'fulfilmentLocation' | 'currentCustodian' | 'assignedPartnerUserId' | 'assignedPartnerName' | 'qrRevoked' | 'depositAmount' | 'currency' | 'createdAt' | 'updatedAt'>): Record<string, unknown> {
  return {
    id: doc._id.toString(),
    packageId: doc.packageId,
    ownerType: doc.ownerType,
    ...(doc.ownerId ? { ownerId: doc.ownerId.toString() } : {}),
    packageClass: doc.packageClass,
    status: doc.status,
    condition: doc.condition,
    reuseCount: doc.reuseCount ?? 0,
    fulfilmentLocation: doc.fulfilmentLocation,
    custodianType: doc.currentCustodian?.custodianType ?? '',
    custodianId: doc.currentCustodian?.custodianId ?? '',
    custodianLabel: doc.currentCustodian?.label ?? '',
    ...(doc.assignedPartnerUserId
      ? { assignedPartnerUserId: doc.assignedPartnerUserId.toString() }
      : {}),
    ...(doc.assignedPartnerName ? { assignedPartnerName: doc.assignedPartnerName } : {}),
    qrRevoked: Boolean(doc.qrRevoked),
    depositAmount: Number(doc.depositAmount ?? 0),
    currency: doc.currency,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt,
  };
}

export function buildReturnSearchDoc(
  doc: Pick<
    IReturn,
    | '_id'
    | 'returnNumber'
    | 'orderId'
    | 'packageId'
    | 'merchantId'
    | 'customerId'
    | 'mode'
    | 'status'
    | 'returnMethodDetails'
    | 'assignedPartnerUserId'
    | 'assignedPartnerName'
    | 'inspection'
    | 'refundEligibility'
    | 'isLateReturn'
    | 'disputed'
    | 'createdAt'
    | 'updatedAt'
  >,
  refundStatus?: string
): Record<string, unknown> {
  return {
    id: doc._id.toString(),
    returnNumber: doc.returnNumber,
    orderId: doc.orderId.toString(),
    packageId: doc.packageId,
    merchantId: doc.merchantId.toString(),
    customerId: doc.customerId.toString(),
    mode: doc.mode,
    status: doc.status,
    serviceZone: doc.returnMethodDetails?.serviceZone ?? '',
    ...(doc.assignedPartnerUserId
      ? { assignedPartnerUserId: doc.assignedPartnerUserId.toString() }
      : {}),
    ...(doc.assignedPartnerName ? { assignedPartnerName: doc.assignedPartnerName } : {}),
    ...(doc.inspection?.condition ? { inspectionCondition: doc.inspection.condition } : {}),
    ...(doc.inspection?.outcome ? { inspectionOutcome: doc.inspection.outcome } : {}),
    ...(refundStatus ? { refundStatus } : {}),
    calculatedAmount: Number(doc.refundEligibility?.calculatedAmount ?? 0),
    currency: doc.refundEligibility?.currency ?? 'USD',
    isLateReturn: Boolean(doc.isLateReturn),
    disputed: Boolean(doc.disputed),
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt,
  };
}

export function buildTransactionSearchDoc(doc: Pick<ITransaction, '_id' | 'orderId' | 'merchantId' | 'customerId' | 'paypalOrderId' | 'captureId' | 'depositAllocations' | 'state' | 'providerStatus' | 'amount' | 'currency' | 'createdAt' | 'updatedAt'>): Record<string, unknown> {
  return {
    id: doc._id.toString(),
    orderId: doc.orderId.toString(),
    merchantId: doc.merchantId.toString(),
    customerId: doc.customerId.toString(),
    paypalOrderId: doc.paypalOrderId,
    ...(doc.captureId ? { captureId: doc.captureId } : {}),
    packageIds: (doc.depositAllocations ?? []).map((a) => a.packageId),
    state: doc.state,
    ...(doc.providerStatus ? { providerStatus: doc.providerStatus } : {}),
    amount: Number(doc.amount ?? 0),
    currency: doc.currency,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt,
  };
}

export function buildPackageEventSearchDoc(doc: Pick<IPackageEvent, '_id' | 'eventId' | 'packageId' | 'merchantId' | 'type' | 'outcome' | 'locationRef' | 'actor' | 'occurredAt'>): Record<string, unknown> {
  return {
    id: doc._id.toString(),
    eventId: doc.eventId,
    packageId: doc.packageId,
    ...(doc.merchantId ? { merchantId: doc.merchantId.toString() } : {}),
    type: doc.type,
    outcome: doc.outcome,
    ...(doc.locationRef ? { locationRef: doc.locationRef } : {}),
    actorRole: doc.actor?.role ?? 'SYSTEM',
    occurredAt: doc.occurredAt instanceof Date ? doc.occurredAt.toISOString() : doc.occurredAt,
  };
}

function sanitizeSyncError(err: unknown): string {
  const msg = err instanceof Error ? err.message : 'Elasticsearch indexing failed';
  return msg.replace(/https?:\/\/[^@\s]+@/gi, 'https://***@').slice(0, 300);
}

export class SearchSyncService {
  private readonly es: SearchEngineClient;
  private readonly maxBackoffMs: number;

  constructor(options?: { esClient?: SearchEngineClient; maxBackoffMs?: number }) {
    this.es = options?.esClient ?? defaultSearchEngineClient;
    this.maxBackoffMs = options?.maxBackoffMs ?? 300_000;
  }

  computeNextRetryAt(attemptCount: number, now = new Date()): Date {
    const exp = Math.min(Math.max(1, attemptCount), 6);
    const delayMs = Math.min(this.maxBackoffMs, 5000 * Math.pow(2, exp - 1));
    return new Date(now.getTime() + delayMs);
  }

  /**
   * Claims eligible SearchOutbox entries atomically, deduplicates per entity, builds
   * PII-stripped derived documents from authoritative MongoDB collections, and persists
   * retry backoff metadata on transient failures without affecting MongoDB writes.
   */
  async processPendingOutbox(batchSize = 50, now = new Date()): Promise<OutboxProcessSummary> {
    if (!this.es.isConfigured()) {
      return {
        skipped: true,
        reason: 'NOT_CONFIGURED',
        checked: 0,
        indexed: 0,
        deleted: 0,
        failed: 0,
      };
    }

    if (mongoose.connection.readyState !== 1) {
      return {
        skipped: true,
        reason: 'DB_NOT_CONNECTED',
        checked: 0,
        indexed: 0,
        deleted: 0,
        failed: 0,
      };
    }

    const staleProcessingCutoff = new Date(now.getTime() - 120_000);
    const claimed: Array<{
      _id: mongoose.Types.ObjectId;
      entityType: 'order' | 'passport' | 'package_event' | 'return' | 'payment';
      entityId: string;
      operation: 'UPSERT' | 'DELETE';
      attemptCount: number;
    }> = [];

    for (let i = 0; i < batchSize; i += 1) {
      const entry = await SearchOutboxModel.findOneAndUpdate(
        {
          $or: [
            { status: 'PENDING', nextRetryAt: { $lte: now } },
            { status: 'FAILED', nextRetryAt: { $lte: now }, attemptCount: { $lt: 12 } },
            { status: 'PROCESSING', updatedAt: { $lte: staleProcessingCutoff } },
          ],
        },
        { $set: { status: 'PROCESSING' } },
        { sort: { nextRetryAt: 1, createdAt: 1 }, new: true }
      ).lean();

      if (!entry) break;
      claimed.push({
        _id: entry._id as mongoose.Types.ObjectId,
        entityType: entry.entityType,
        entityId: entry.entityId,
        operation: entry.operation,
        attemptCount: entry.attemptCount ?? 0,
      });
    }

    if (claimed.length === 0) {
      return {
        skipped: true,
        reason: 'NO_PENDING_EVENTS',
        checked: 0,
        indexed: 0,
        deleted: 0,
        failed: 0,
      };
    }

    try {
      await this.es.ensureIndices();
    } catch (err) {
      const message = sanitizeSyncError(err);
      await this.markFailedEntries(claimed, message, now);
      return {
        skipped: false,
        checked: claimed.length,
        indexed: 0,
        deleted: 0,
        failed: claimed.length,
      };
    }

    // Group claimed records by (entityType, entityId) so rapid updates coalesce cleanly.
    const groups = new Map<
      string,
      {
        entityType: 'order' | 'passport' | 'package_event' | 'return' | 'payment';
        entityId: string;
        operation: 'UPSERT' | 'DELETE';
        entries: typeof claimed;
      }
    >();

    for (const item of claimed) {
      const key = `${item.entityType}:${item.entityId}`;
      const existing = groups.get(key);
      if (existing) {
        existing.entries.push(item);
        existing.operation = item.operation;
      } else {
        groups.set(key, {
          entityType: item.entityType,
          entityId: item.entityId,
          operation: item.operation,
          entries: [item],
        });
      }
    }

    const bulkOps: BulkSearchOperation[] = [];
    const docIdToGroup = new Map<string, (typeof groups extends Map<string, infer V> ? V : never)>();
    let indexedCount = 0;
    let deletedCount = 0;

    for (const group of groups.values()) {
      const op = await this.buildOperationForGroup(group.entityType, group.entityId, group.operation);
      if (op) {
        bulkOps.push(op);
        docIdToGroup.set(`${op.index}:${op.id}`, group);
      } else {
        // Complete gracefully if ID is malformed and unrecoverable.
        await this.markCompletedEntries(group.entries.map((e) => e._id));
      }
    }

    if (bulkOps.length === 0) {
      return {
        skipped: false,
        checked: claimed.length,
        indexed: 0,
        deleted: 0,
        failed: 0,
      };
    }

    try {
      const result = await this.es.bulkIndex(bulkOps);
      const failedIdSet = new Set(result.failedItems.map((f) => f.id));
      const failedReasonMap = new Map(result.failedItems.map((f) => [f.id, f.reason]));

      let failedCount = 0;
      for (const op of bulkOps) {
        const group = docIdToGroup.get(`${op.index}:${op.id}`);
        if (!group) continue;
        if (failedIdSet.has(op.id)) {
          failedCount += group.entries.length;
          await this.markFailedEntries(
            group.entries,
            failedReasonMap.get(op.id) ?? 'Bulk indexing error',
            now
          );
        } else {
          await this.markCompletedEntries(group.entries.map((e) => e._id));
          if (op.action === 'delete') deletedCount += 1;
          else indexedCount += 1;
        }
      }

      return {
        skipped: false,
        checked: claimed.length,
        indexed: indexedCount,
        deleted: deletedCount,
        failed: failedCount,
      };
    } catch (err) {
      const message = sanitizeSyncError(err);
      await this.markFailedEntries(claimed, message, now);
      return {
        skipped: false,
        checked: claimed.length,
        indexed: 0,
        deleted: 0,
        failed: claimed.length,
      };
    }
  }

  private async markCompletedEntries(ids: mongoose.Types.ObjectId[]): Promise<void> {
    if (ids.length === 0) return;
    await SearchOutboxModel.updateMany(
      { _id: { $in: ids } },
      {
        $set: { status: 'COMPLETED', processedAt: new Date() },
        $unset: { lastError: 1 },
      }
    );
  }

  private async markFailedEntries(
    entries: Array<{ _id: mongoose.Types.ObjectId; attemptCount: number }>,
    reason: string,
    now: Date
  ): Promise<void> {
    for (const entry of entries) {
      const nextAttempt = (entry.attemptCount ?? 0) + 1;
      await SearchOutboxModel.updateOne(
        { _id: entry._id },
        {
          $set: {
            status: 'FAILED',
            attemptCount: nextAttempt,
            lastError: reason.slice(0, 300),
            nextRetryAt: this.computeNextRetryAt(nextAttempt, now),
          },
        }
      );
    }
  }

  private async buildOperationForGroup(
    entityType: 'order' | 'passport' | 'package_event' | 'return' | 'payment',
    entityId: string,
    requestedOp: 'UPSERT' | 'DELETE'
  ): Promise<BulkSearchOperation | null> {
    if (entityType === 'order') {
      if (!mongoose.Types.ObjectId.isValid(entityId)) return null;
      const index = this.es.getIndexName('orders');
      if (requestedOp === 'DELETE') {
        return { action: 'delete', index, id: entityId };
      }
      const doc = await OrderModel.findById(entityId).lean();
      if (!doc) return { action: 'delete', index, id: entityId };
      return {
        action: 'upsert',
        index,
        id: doc._id.toString(),
        document: buildOrderSearchDoc(doc),
      };
    }

    if (entityType === 'passport') {
      const normalizedPkgId = entityId.trim().toUpperCase();
      const index = this.es.getIndexName('packages');
      if (requestedOp === 'DELETE') {
        return { action: 'delete', index, id: normalizedPkgId };
      }
      const doc = await PackageModel.findOne({ packageId: normalizedPkgId }).lean();
      if (!doc) return { action: 'delete', index, id: normalizedPkgId };
      return {
        action: 'upsert',
        index,
        id: doc._id.toString(),
        document: buildPackageSearchDoc(doc),
      };
    }

    if (entityType === 'return') {
      if (!mongoose.Types.ObjectId.isValid(entityId)) return null;
      const index = this.es.getIndexName('returns');
      if (requestedOp === 'DELETE') {
        return { action: 'delete', index, id: entityId };
      }
      const doc = await ReturnModel.findById(entityId).lean();
      if (!doc) return { action: 'delete', index, id: entityId };
      return {
        action: 'upsert',
        index,
        id: doc._id.toString(),
        document: buildReturnSearchDoc(doc),
      };
    }

    if (entityType === 'payment') {
      if (!mongoose.Types.ObjectId.isValid(entityId)) return null;
      const index = this.es.getIndexName('transactions');
      if (requestedOp === 'DELETE') {
        return { action: 'delete', index, id: entityId };
      }
      const doc = await TransactionModel.findById(entityId).lean();
      if (!doc) return { action: 'delete', index, id: entityId };
      return {
        action: 'upsert',
        index,
        id: doc._id.toString(),
        document: buildTransactionSearchDoc(doc),
      };
    }

    const index = this.es.getIndexName('package_events');
    if (requestedOp === 'DELETE') {
      return { action: 'delete', index, id: entityId };
    }
    const evt = await PackageEventModel.findOne({ eventId: entityId }).lean();
    if (!evt) return { action: 'delete', index, id: entityId };
    return {
      action: 'upsert',
      index,
      id: evt._id.toString(),
      document: buildPackageEventSearchDoc(evt),
    };
  }

  /**
   * Resumable cursor-batched full/scoped reindex from MongoDB into Elasticsearch.
   * Never loads an entire collection into memory at once.
   */
  async reindexAll(params: {
    requestedBy: string;
    entities?: ReindexEntityScope[];
    merchantId?: string;
    batchSize?: number;
    resumeJobId?: string;
  }): Promise<ReindexResultSummary> {
    if (!this.es.isConfigured()) {
      throw new Error('Elasticsearch is not configured (ELASTICSEARCH_URL missing).');
    }

    const entities: ReindexEntityScope[] =
      params.entities && params.entities.length > 0
        ? params.entities
        : ['orders', 'packages', 'returns', 'transactions'];
    const batchSize = Math.min(Math.max(params.batchSize ?? 100, 10), 250);

    let job = params.resumeJobId
      ? await SearchReindexJobModel.findOne({ jobId: params.resumeJobId })
      : null;

    if (!job) {
      job = await SearchReindexJobModel.create({
        jobId: `reidx_${crypto.randomUUID().slice(0, 12)}`,
        requestedBy: params.requestedBy,
        ...(params.merchantId ? { merchantId: params.merchantId } : {}),
        entities,
        status: 'RUNNING',
        cursors: {},
        processedCounts: { orders: 0, packages: 0, returns: 0, transactions: 0 },
        failedCount: 0,
        startedAt: new Date(),
      });
    } else {
      job.status = 'RUNNING';
      job.lastError = undefined;
      await job.save();
    }

    try {
      await this.es.ensureIndices();

      for (const scope of job.entities) {
        job.currentEntity = scope;
        await job.save();

        let lastId = job.cursors?.[scope];
        while (true) {
          const batch = await this.fetchReindexBatch(
            scope,
            lastId,
            batchSize,
            job.merchantId
          );
          if (batch.ops.length === 0) break;

          const res = await this.es.bulkIndex(batch.ops);
          job.processedCounts[scope] += res.succeededIds.length;
          job.failedCount += res.failedItems.length;
          if (res.failedItems.length > 0) {
            job.lastError = res.failedItems[0].reason.slice(0, 300);
          }

          lastId = batch.lastId;
          job.cursors[scope] = lastId;
          await job.save();

          if (batch.ops.length < batchSize) break;
        }
      }

      job.status = job.failedCount > 0 && Object.values(job.processedCounts).every((n) => n === 0)
        ? 'FAILED'
        : 'COMPLETED';
      job.finishedAt = new Date();
      await job.save();

      return {
        jobId: job.jobId,
        status: job.status === 'FAILED' ? 'FAILED' : 'COMPLETED',
        processedCounts: { ...job.processedCounts },
        failedCount: job.failedCount,
        ...(job.lastError ? { lastError: job.lastError } : {}),
      };
    } catch (err) {
      const msg = sanitizeSyncError(err);
      job.status = 'FAILED';
      job.lastError = msg;
      job.finishedAt = new Date();
      await job.save();
      return {
        jobId: job.jobId,
        status: 'FAILED',
        processedCounts: { ...job.processedCounts },
        failedCount: job.failedCount + 1,
        lastError: msg,
      };
    }
  }

  private async fetchReindexBatch(
    scope: ReindexEntityScope,
    afterId: string | undefined,
    limit: number,
    merchantId?: string
  ): Promise<{ ops: BulkSearchOperation[]; lastId?: string }> {
    const idFilter: Record<string, unknown> =
      afterId && mongoose.Types.ObjectId.isValid(afterId)
        ? { _id: { $gt: new mongoose.Types.ObjectId(afterId) } }
        : {};
    const validMerchant =
      merchantId && mongoose.Types.ObjectId.isValid(merchantId)
        ? new mongoose.Types.ObjectId(merchantId)
        : null;

    if (scope === 'orders') {
      const docs = await OrderModel.find({
        ...idFilter,
        ...(validMerchant ? { merchantId: validMerchant } : {}),
      })
        .sort({ _id: 1 })
        .limit(limit)
        .lean();
      return {
        ops: docs.map((d) => ({
          action: 'upsert',
          index: this.es.getIndexName('orders'),
          id: d._id.toString(),
          document: buildOrderSearchDoc(d),
        })),
        lastId: docs.at(-1)?._id.toString(),
      };
    }

    if (scope === 'packages') {
      const docs = await PackageModel.find({
        ...idFilter,
        ...(validMerchant ? { ownerId: validMerchant } : {}),
      })
        .sort({ _id: 1 })
        .limit(limit)
        .lean();
      return {
        ops: docs.map((d) => ({
          action: 'upsert',
          index: this.es.getIndexName('packages'),
          id: d._id.toString(),
          document: buildPackageSearchDoc(d),
        })),
        lastId: docs.at(-1)?._id.toString(),
      };
    }

    if (scope === 'returns') {
      const docs = await ReturnModel.find({
        ...idFilter,
        ...(validMerchant ? { merchantId: validMerchant } : {}),
      })
        .sort({ _id: 1 })
        .limit(limit)
        .lean();
      return {
        ops: docs.map((d) => ({
          action: 'upsert',
          index: this.es.getIndexName('returns'),
          id: d._id.toString(),
          document: buildReturnSearchDoc(d),
        })),
        lastId: docs.at(-1)?._id.toString(),
      };
    }

    const docs = await TransactionModel.find({
      ...idFilter,
      ...(validMerchant ? { merchantId: validMerchant } : {}),
    })
      .sort({ _id: 1 })
      .limit(limit)
      .lean();
    return {
      ops: docs.map((d) => ({
        action: 'upsert',
        index: this.es.getIndexName('transactions'),
        id: d._id.toString(),
        document: buildTransactionSearchDoc(d),
      })),
      lastId: docs.at(-1)?._id.toString(),
    };
  }
}

export const defaultSearchSyncService = new SearchSyncService();

