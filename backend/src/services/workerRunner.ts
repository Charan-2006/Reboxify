import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { WorkerLeaseModel } from '../models/WorkerLease.js';
import { PaymentService } from './paymentService.js';
import { ReturnService } from './returnService.js';
import {
  OutboxProcessSummary,
  SearchSyncService,
  defaultSearchSyncService,
} from './searchSyncService.js';
import { WebhookService } from './webhookService.js';

export interface WorkerLeaseStore {
  tryAcquire(jobName: string, ownerId: string, leaseTtlMs: number): Promise<boolean>;
  recordOutcome(
    jobName: string,
    ownerId: string,
    outcome: {
      status: 'OK' | 'ERROR';
      summary?: Record<string, unknown>;
      consecutiveFailures: number;
      error?: string;
    }
  ): Promise<void>;
  release(jobName: string, ownerId: string): Promise<void>;
}

export class MongooseWorkerLeaseStore implements WorkerLeaseStore {
  async tryAcquire(jobName: string, ownerId: string, leaseTtlMs: number): Promise<boolean> {
    if (mongoose.connection.readyState !== 1) return false;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseTtlMs);
    try {
      const doc = await WorkerLeaseModel.findOneAndUpdate(
        {
          _id: jobName,
          $or: [
            { leaseExpiresAt: { $lte: now } },
            { ownerId },
            { status: 'STOPPED' },
          ],
        },
        {
          $set: {
            ownerId,
            status: 'RUNNING',
            leaseExpiresAt: expiresAt,
            lastHeartbeatAt: now,
          },
        },
        { upsert: true, new: true }
      ).lean();
      return doc?.ownerId === ownerId;
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) {
        return false;
      }
      throw err;
    }
  }

  async recordOutcome(
    jobName: string,
    ownerId: string,
    outcome: {
      status: 'OK' | 'ERROR';
      summary?: Record<string, unknown>;
      consecutiveFailures: number;
      error?: string;
    }
  ): Promise<void> {
    if (mongoose.connection.readyState !== 1) return;
    const now = new Date();
    await WorkerLeaseModel.updateOne(
      { _id: jobName, ownerId },
      {
        $set: {
          status: outcome.status === 'OK' ? 'RUNNING' : 'ERROR',
          lastHeartbeatAt: now,
          lastCycleAt: now,
          lastCycleStatus: outcome.status,
          lastCycleSummary: outcome.summary,
          consecutiveFailures: outcome.consecutiveFailures,
          ...(outcome.error ? { lastError: outcome.error } : { lastError: undefined }),
        },
      }
    );
  }

  async release(jobName: string, ownerId: string): Promise<void> {
    if (mongoose.connection.readyState !== 1) return;
    const now = new Date();
    await WorkerLeaseModel.updateOne(
      { _id: jobName, ownerId },
      {
        $set: {
          status: 'STOPPED',
          leaseExpiresAt: now,
          lastHeartbeatAt: now,
        },
      }
    );
  }
}

export interface WorkerCycleSummary {
  skipped: boolean;
  skipReason?: 'IN_FLIGHT' | 'LEASE_HELD_BY_OTHER' | 'STOPPED';
  captures?: { checked: number; resolved: number; failed: number };
  refunds?: { checked: number; resolved: number; failed: number };
  webhooks?: { checked: number; processed: number; ignored: number; failed: number };
  search?: OutboxProcessSummary;
  error?: string;
  nextDelayMs: number;
}

export interface WorkerRunnerDeps {
  paymentService?: Pick<PaymentService, 'reconcileStuckPendingCaptures'>;
  returnService?: Pick<ReturnService, 'reconcileStuckPendingRefunds'>;
  webhookService?: Pick<WebhookService, 'retryFailedWebhooks'>;
  searchSyncService?: Pick<SearchSyncService, 'processPendingOutbox'>;
  leaseStore?: WorkerLeaseStore;
  jobName?: string;
  ownerId?: string;
  reconcileIntervalMs?: number;
  pendingReconcileMinAgeMs?: number;
  leaseTtlMs?: number;
  maxBackoffMs?: number;
  webhookMaxRetries?: number;
}

/**
 * Coordinates periodic PayPal capture/refund reconciliation and failed webhook retries
 * with single-flight locking, MongoDB lease deduplication, bounded exponential backoff,
 * and graceful shutdown support.
 */
export class WorkerRunner {
  private readonly paymentService: Pick<PaymentService, 'reconcileStuckPendingCaptures'>;
  private readonly returnService: Pick<ReturnService, 'reconcileStuckPendingRefunds'>;
  private readonly webhookService: Pick<WebhookService, 'retryFailedWebhooks'>;
  private readonly searchSyncService: Pick<SearchSyncService, 'processPendingOutbox'>;
  private readonly leaseStore: WorkerLeaseStore;
  private readonly jobName: string;
  private readonly ownerId: string;
  private readonly baseIntervalMs: number;
  private readonly minAgeMs: number;
  private readonly leaseTtlMs: number;
  private readonly maxBackoffMs: number;
  private readonly webhookMaxRetries: number;

  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlight: Promise<WorkerCycleSummary> | null = null;
  private consecutiveFailures = 0;

  constructor(deps: WorkerRunnerDeps = {}) {
    this.paymentService = deps.paymentService ?? new PaymentService();
    this.returnService = deps.returnService ?? new ReturnService();
    this.webhookService = deps.webhookService ?? new WebhookService();
    this.searchSyncService = deps.searchSyncService ?? defaultSearchSyncService;
    this.leaseStore = deps.leaseStore ?? new MongooseWorkerLeaseStore();
    this.jobName = deps.jobName ?? 'reboxify-reconcile-worker';
    this.ownerId = deps.ownerId ?? `worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    this.baseIntervalMs = deps.reconcileIntervalMs ?? 60_000;
    this.minAgeMs = deps.pendingReconcileMinAgeMs ?? 120_000;
    this.leaseTtlMs = deps.leaseTtlMs ?? 90_000;
    this.maxBackoffMs = deps.maxBackoffMs ?? 300_000;
    this.webhookMaxRetries = deps.webhookMaxRetries ?? 5;
  }

  getOwnerId(): string {
    return this.ownerId;
  }

  isRunning(): boolean {
    return !this.stopped;
  }

  computeNextDelayMs(failures: number): number {
    if (failures <= 0) return this.baseIntervalMs;
    const exp = Math.min(failures, 6);
    return Math.min(this.maxBackoffMs, this.baseIntervalMs * Math.pow(2, exp));
  }

  async runOnce(): Promise<WorkerCycleSummary> {
    if (this.stopped) {
      return { skipped: true, skipReason: 'STOPPED', nextDelayMs: this.baseIntervalMs };
    }
    if (this.inFlight) {
      return { skipped: true, skipReason: 'IN_FLIGHT', nextDelayMs: this.baseIntervalMs };
    }

    const work = this.executeCycle();
    this.inFlight = work;
    try {
      return await work;
    } finally {
      this.inFlight = null;
    }
  }

  private async executeCycle(): Promise<WorkerCycleSummary> {
    let acquired = false;
    try {
      acquired = await this.leaseStore.tryAcquire(this.jobName, this.ownerId, this.leaseTtlMs);
    } catch (err) {
      this.consecutiveFailures += 1;
      const msg = err instanceof Error ? err.message : 'Failed to acquire worker lease';
      console.error('[reboxify-worker] Lease acquisition error:', msg);
      return {
        skipped: false,
        error: msg,
        nextDelayMs: this.computeNextDelayMs(this.consecutiveFailures),
      };
    }

    if (!acquired) {
      console.log('[reboxify-worker] Lease held by another worker instance; skipping duplicate cycle.');
      return {
        skipped: true,
        skipReason: 'LEASE_HELD_BY_OTHER',
        nextDelayMs: this.baseIntervalMs,
      };
    }

    try {
      const captures = await this.paymentService.reconcileStuckPendingCaptures(this.minAgeMs);
      const refunds = await this.returnService.reconcileStuckPendingRefunds(this.minAgeMs);
      const webhooks = await this.webhookService.retryFailedWebhooks(20, this.webhookMaxRetries);
      let search: OutboxProcessSummary;
      try {
        search = await this.searchSyncService.processPendingOutbox(50);
      } catch {
        search = { skipped: false, checked: 1, indexed: 0, deleted: 0, failed: 1 };
      }

      // Elasticsearch indexing failures use per-outbox nextRetryAt backoff so an ES outage
      // never delays critical PayPal capture/refund reconciliation or webhook retries.
      const itemFailures = captures.failed + refunds.failed + webhooks.failed;
      if (itemFailures > 0) {
        this.consecutiveFailures += 1;
      } else {
        this.consecutiveFailures = 0;
      }

      const summary = {
        captures,
        refunds,
        webhooks,
        ...(search.skipped ? {} : { search }),
      };
      await this.leaseStore.recordOutcome(this.jobName, this.ownerId, {
        status: itemFailures > 0 ? 'ERROR' : 'OK',
        summary,
        consecutiveFailures: this.consecutiveFailures,
      });

      if (
        captures.checked > 0 ||
        refunds.checked > 0 ||
        webhooks.checked > 0 ||
        (!search.skipped && search.checked > 0) ||
        itemFailures > 0
      ) {
        console.log('[reboxify-worker] Reconciliation cycle complete:', summary);
      }

      return {
        skipped: false,
        captures,
        refunds,
        webhooks,
        search,
        nextDelayMs: this.computeNextDelayMs(this.consecutiveFailures),
      };
    } catch (err) {
      this.consecutiveFailures += 1;
      const msg = err instanceof Error ? err.message : 'Worker cycle error';
      console.error('[reboxify-worker] Reconciliation cycle failed:', msg);
      await this.leaseStore
        .recordOutcome(this.jobName, this.ownerId, {
          status: 'ERROR',
          consecutiveFailures: this.consecutiveFailures,
          error: msg,
        })
        .catch(() => undefined);
      return {
        skipped: false,
        error: msg,
        nextDelayMs: this.computeNextDelayMs(this.consecutiveFailures),
      };
    }
  }

  start(): void {
    this.stopped = false;
    const scheduleNext = (delayMs: number) => {
      if (this.stopped) return;
      this.timer = setTimeout(async () => {
        const result = await this.runOnce();
        scheduleNext(result.nextDelayMs);
      }, delayMs);
    };
    // Trigger initial reconciliation cycle immediately on boot, then schedule with backoff.
    void this.runOnce().then((res) => {
      scheduleNext(res.nextDelayMs);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }
    await this.leaseStore.release(this.jobName, this.ownerId).catch(() => undefined);
  }
}

