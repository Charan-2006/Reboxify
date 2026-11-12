import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { config } from './config/env.js';

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
    currency: config.defaultCurrency,
  });

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[reboxify-api] Listening on port ${config.port} (${config.nodeEnv}).`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[reboxify-api] Received ${signal}, shutting down cleanly...`);
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void bootstrap();

