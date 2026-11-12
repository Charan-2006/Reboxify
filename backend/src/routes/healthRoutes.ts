import { Router } from 'express';
import mongoose from 'mongoose';
import { getDatabaseStatus } from '../config/db.js';
import { config } from '../config/env.js';
import { WorkerLeaseModel } from '../models/WorkerLease.js';
import { SearchEngineClient, defaultSearchEngineClient } from '../services/elasticsearchClient.js';
import { GeminiModelClient, defaultGeminiClient } from '../services/geminiClient.js';

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

export function createHealthRouter(deps?: {
  esClient?: SearchEngineClient;
  geminiClient?: GeminiModelClient;
}): Router {
  const router = Router();
  const esClient = deps?.esClient ?? defaultSearchEngineClient;
  const geminiClient = deps?.geminiClient ?? defaultGeminiClient;

  router.get('/health', async (_req, res) => {
    const db = getDatabaseStatus();
    const isProd = config.nodeEnv === 'production';
    const prodDbHealthy = db.connected && db.replicaSetSupported;

    const [worker, esHealth, geminiHealth] = await Promise.all([
      readWorkerHealth(),
      esClient.checkHealth(false),
      geminiClient.checkHealth(false),
    ]);

    const mongodbStatus = !db.connected
      ? 'DEGRADED'
      : db.replicaSetSupported
        ? 'HEALTHY'
        : isProd
          ? 'DEGRADED'
          : 'CONNECTED';

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
        status: mongodbStatus,
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
        pickupSchedulerConfigured: true,
        bryntumSchedulerMode: 'COMMUNITY_READY',
        statuses: {
          mongodb: mongodbStatus,
          replicaSet: db.replicaSetSupported ? 'HEALTHY' : db.connected ? 'DEGRADED' : 'DISABLED',
          worker: worker.status,
          paypal: config.integrations.paypalConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED',
          paypalWebhook: config.integrations.paypalWebhookConfigured
            ? 'CONFIGURED'
            : 'NOT_CONFIGURED',
          elasticsearch: esHealth.status,
          gemini: geminiHealth.status,
          pickupScheduler: 'COMMUNITY_READY',
        },
        diagnostics: {
          elasticsearch: {
            status: esHealth.status,
            ...(esHealth.clusterName ? { clusterName: esHealth.clusterName } : {}),
            ...(esHealth.message ? { message: esHealth.message } : {}),
            checkedAt: esHealth.checkedAt,
          },
          gemini: {
            status: geminiHealth.status,
            model: geminiHealth.model,
            ...(geminiHealth.message ? { message: geminiHealth.message } : {}),
            checkedAt: geminiHealth.checkedAt,
          },
        },
      },
    };

    res.status(isProd && !prodDbHealthy ? 503 : 200).json(payload);
  });

  return router;
}
