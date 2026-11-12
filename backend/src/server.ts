import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { config } from './config/env.js';
import { WorkerRunner } from './services/workerRunner.js';

async function bootstrap(): Promise<void> {
  const dbStatus = await connectDatabase(config.mongodbUri);

  if (dbStatus.connected) {
    console.log(
      `[reboxify-api] MongoDB connected (replicaSet=${dbStatus.replicaSetSupported}).`
    );
  } else {
    console.warn(
      `[reboxify-api] Starting without active MongoDB connection: ${dbStatus.lastError}`
    );
  }

  console.log('[reboxify-api] Integration readiness:', {
    paypalConfigured: config.integrations.paypalConfigured,
    paypalWebhookConfigured: config.integrations.paypalWebhookConfigured,
    geminiConfigured: config.integrations.geminiConfigured,
    elasticsearchConfigured: config.integrations.elasticsearchConfigured,
    embeddedWorkerEnabled: config.enableEmbeddedWorker,
    currency: config.defaultCurrency,
  });

  let embeddedWorker: WorkerRunner | null = null;
  const canStartEmbeddedWorker =
    config.enableEmbeddedWorker &&
    dbStatus.connected &&
    (config.nodeEnv !== 'production' || dbStatus.replicaSetSupported);

  if (canStartEmbeddedWorker) {
    embeddedWorker = new WorkerRunner({
      reconcileIntervalMs: config.reconcileIntervalMs,
      pendingReconcileMinAgeMs: config.pendingReconcileMinAgeMs,
      leaseTtlMs: config.workerLeaseTtlMs,
      maxBackoffMs: config.workerMaxBackoffMs,
      webhookMaxRetries: config.webhookMaxRetries,
    });
    embeddedWorker.start();
    console.log('[reboxify-api] Embedded reconciliation worker started.');
  } else if (config.enableEmbeddedWorker) {
    console.warn(
      '[reboxify-api] Embedded worker skipped: requires active MongoDB replica-set connection.'
    );
  }

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[reboxify-api] Listening on port ${config.port} (${config.nodeEnv}).`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[reboxify-api] Received ${signal}, shutting down cleanly...`);
    server.close(async () => {
      if (embeddedWorker) {
        await embeddedWorker.stop();
      }
      await disconnectDatabase();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void bootstrap();

