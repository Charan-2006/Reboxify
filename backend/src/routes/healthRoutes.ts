import { Router } from 'express';
import mongoose from 'mongoose';
import { getDatabaseStatus } from '../config/db.js';
import { config } from '../config/env.js';
import { WorkerLeaseModel } from '../models/WorkerLease.js';

export interface WorkerHealthSnapshot {
  status: 'HEALTHY' | 'STALE' | 'STOPPED' | 'NOT_DETECTED';
  lastHeartbeatAt?: string;
  lastCycleAt?: string;
  lastCycleStatus?: 'OK' | 'ERROR';
  consecutiveFailures?: number;
}

async function readWorkerHealth(): Promise<WorkerHealthSnapshot> {
  if (mongoose.connection.readyState !== 1) {
    return { status: 'NOT_DETECTED' };
  }
  try {
    const doc = await WorkerLeaseModel.findById('reboxify-reconcile-worker').lean();
    if (!doc) {
      return { status: 'NOT_DETECTED' };
    }
    const staleThresholdMs = Math.max(120_000, config.reconcileIntervalMs * 2.5);
    const ageMs = Date.now() - new Date(doc.lastHeartbeatAt).getTime();
    const derivedStatus: WorkerHealthSnapshot['status'] =
      doc.status === 'STOPPED'
        ? 'STOPPED'
        : ageMs <= staleThresholdMs
          ? 'HEALTHY'
          : 'STALE';

    return {
      status: derivedStatus,
      lastHeartbeatAt: new Date(doc.lastHeartbeatAt).toISOString(),
      ...(doc.lastCycleAt ? { lastCycleAt: new Date(doc.lastCycleAt).toISOString() } : {}),
      ...(doc.lastCycleStatus ? { lastCycleStatus: doc.lastCycleStatus } : {}),
      consecutiveFailures: doc.consecutiveFailures ?? 0,
    };
  } catch {
    return { status: 'NOT_DETECTED' };
  }
}

export function createHealthRouter(): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const db = getDatabaseStatus();
    const isProd = config.nodeEnv === 'production';
    const prodDbHealthy = db.connected && db.replicaSetSupported;
    const worker = await readWorkerHealth();

    const payload = {
      status: !isProd || prodDbHealthy ? 'ok' : 'degraded',
      service: 'reboxify-api',
      environment: config.nodeEnv,
      currency: config.defaultCurrency,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      database: {
        connected: db.connected,
        replicaSetSupported: db.replicaSetSupported,
        ...(db.lastError && !db.connected
          ? {
              statusMessage: isProd
                ? 'Database connection unavailable.'
                : db.lastError,
            }
          : !db.replicaSetSupported && db.connected && isProd
            ? { statusMessage: 'MongoDB replica set is required in production.' }
            : {}),
      },
      worker,
      integrations: {
        paypalSandboxConfigured: config.integrations.paypalConfigured,
        paypalWebhookConfigured: config.integrations.paypalWebhookConfigured,
        geminiConfigured: config.integrations.geminiConfigured,
        elasticsearchConfigured: config.integrations.elasticsearchConfigured,
        pickupSchedulerConfigured: false,
        bryntumSchedulerMode: 'NOT_IMPLEMENTED',
      },
    };

    res.status(isProd && !prodDbHealthy ? 503 : 200).json(payload);
  });

  return router;
}
