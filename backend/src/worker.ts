import { connectDatabase, disconnectDatabase } from './config/db.js';
import { loadConfig } from './config/env.js';
import { WorkerRunner } from './services/workerRunner.js';

/**
 * Render Background Worker entrypoint (Blueprint Section 14.3, Phase 6).
 * Validates production config on startup, enforces replica-set availability in production,
 * runs durable PayPal capture/refund reconciliation and failed webhook retries with
 * MongoDB lease deduplication and bounded exponential backoff, and shuts down gracefully.
 */
async function startWorker(): Promise<void> {
  const workerConfig = loadConfig(process.env, { service: 'worker' });
  const dbStatus = await connectDatabase(workerConfig.mongodbUri);

  if (workerConfig.nodeEnv === 'production' && (!dbStatus.connected || !dbStatus.replicaSetSupported)) {
    console.error('[reboxify-worker] Fatal: Active MongoDB replica-set connection is required in production.', {
      connected: dbStatus.connected,
      replicaSetSupported: dbStatus.replicaSetSupported,
      lastError: dbStatus.lastError,
    });
    await disconnectDatabase();
    process.exit(1);
  }

  console.log('[reboxify-worker] Starting background worker...', {
    environment: workerConfig.nodeEnv,
    mongodbConnected: dbStatus.connected,
    replicaSetSupported: dbStatus.replicaSetSupported,
    paypalConfigured: workerConfig.integrations.paypalConfigured,
    paypalWebhookConfigured: workerConfig.integrations.paypalWebhookConfigured,
    reconcileIntervalMs: workerConfig.reconcileIntervalMs,
    pendingReconcileMinAgeMs: workerConfig.pendingReconcileMinAgeMs,
    workerLeaseTtlMs: workerConfig.workerLeaseTtlMs,
  });

  const runner = new WorkerRunner({
    reconcileIntervalMs: workerConfig.reconcileIntervalMs,
    pendingReconcileMinAgeMs: workerConfig.pendingReconcileMinAgeMs,
    leaseTtlMs: workerConfig.workerLeaseTtlMs,
    maxBackoffMs: workerConfig.workerMaxBackoffMs,
    webhookMaxRetries: workerConfig.webhookMaxRetries,
  });

  runner.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[reboxify-worker] Received ${signal}, stopping worker gracefully...`);
    await runner.stop();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void startWorker();
