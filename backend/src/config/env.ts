import 'dotenv/config';
import crypto from 'node:crypto';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  APP_BASE_URL: z.string().url().default('http://localhost:5000'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  JWT_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  QR_SIGNING_SECRET: z.string().optional(),
  QR_KEY_ID: z.string().min(1).max(32).default('k1'),
  QR_PREVIOUS_KEY_ID: z.string().min(1).max(32).optional(),
  QR_PREVIOUS_SIGNING_SECRET: z.string().optional(),
  QR_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(315360000).default(31536000),
  DEFAULT_CURRENCY: z.string().min(3).max(3).default('USD'),
  MONGODB_URI: z.string().optional(),
  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  ELASTICSEARCH_URL: z.string().optional(),
  ELASTICSEARCH_API_KEY: z.string().optional(),
  ELASTICSEARCH_USERNAME: z.string().optional(),
  ELASTICSEARCH_PASSWORD: z.string().optional(),
  ELASTICSEARCH_INDEX_PREFIX: z.string().min(1).max(32).default('reboxify'),
  ELASTICSEARCH_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(5000),
  AI_RATE_LIMIT_MAX_PER_MIN: z.coerce.number().int().min(1).max(200).default(20),
  ENABLE_EMBEDDED_WORKER: z.enum(['true', 'false', '1', '0']).optional(),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  PENDING_RECONCILE_MIN_AGE_MS: z.coerce.number().int().positive().default(120000),
  WORKER_LEASE_TTL_MS: z.coerce.number().int().min(10000).default(90000),
  WORKER_MAX_BACKOFF_MS: z.coerce.number().int().min(5000).default(300000),
  WEBHOOK_MAX_RETRIES: z.coerce.number().int().min(1).max(20).default(5),
});

export interface IntegrationStatus {
  mongodbConfigured: boolean;
  paypalConfigured: boolean;
  paypalWebhookConfigured: boolean;
  geminiConfigured: boolean;
  elasticsearchConfigured: boolean;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  appBaseUrl: string;
  corsOrigins: string[];
  jwtSecret: string;
  sessionSecret: string;
  qrSigningSecret: string;
  qrKeyId: string;
  qrPreviousKeyId?: string;
  qrPreviousSigningSecret?: string;
  qrTokenTtlSeconds: number;
  defaultCurrency: string;
  mongodbUri?: string;
  paypalEnv: 'sandbox' | 'live';
  paypalClientId?: string;
  paypalClientSecret?: string;
  paypalWebhookId?: string;
  geminiApiKey?: string;
  geminiModel: string;
  elasticsearchUrl?: string;
  elasticsearchApiKey?: string;
  elasticsearchUsername?: string;
  elasticsearchPassword?: string;
  elasticsearchIndexPrefix: string;
  elasticsearchRequestTimeoutMs: number;
  aiRateLimitMaxPerMin: number;
  enableEmbeddedWorker: boolean;
  outboxPollIntervalMs: number;
  reconcileIntervalMs: number;
  pendingReconcileMinAgeMs: number;
  workerLeaseTtlMs: number;
  workerMaxBackoffMs: number;
  webhookMaxRetries: number;
  integrations: IntegrationStatus;
}

const PLACEHOLDER_SECRET_PATTERNS = [
  'replace-with-',
  'changeme',
  'your-secret',
  'example-secret',
];

function isPlaceholderSecret(value: string): boolean {
  const lower = value.toLowerCase();
  return PLACEHOLDER_SECRET_PATTERNS.some((pattern) => lower.includes(pattern));
}

function resolveSecret(
  raw: string | undefined,
  name: string,
  nodeEnv: 'development' | 'test' | 'production'
): string {
  const trimmed = raw?.trim();
  if (trimmed && trimmed.length >= 16) {
    if (nodeEnv === 'production' && isPlaceholderSecret(trimmed)) {
      throw new Error(
        `Required secret ${name} uses a placeholder value and cannot be used in production.`
      );
    }
    return trimmed;
  }
  if (nodeEnv === 'production') {
    throw new Error(`Missing or weak required secret ${name} in production environment.`);
  }
  // Ephemeral random fallback in dev/test so secrets are never hardcoded in source control.
  return crypto.randomBytes(32).toString('hex');
}

export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
  _options?: { service?: 'api' | 'worker' }
): AppConfig {
  const parsed = envSchema.parse(source);
  const nodeEnv = parsed.NODE_ENV;

  if (nodeEnv === 'production' && !parsed.MONGODB_URI?.trim()) {
    throw new Error('MONGODB_URI is required in production environment.');
  }

  const corsOrigins = parsed.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const appBaseUrl = parsed.APP_BASE_URL.trim().replace(/\/+$/, '');

  const mongodbUri = parsed.MONGODB_URI?.trim() || undefined;
  const paypalClientId = parsed.PAYPAL_CLIENT_ID?.trim() || undefined;
  const paypalClientSecret = parsed.PAYPAL_CLIENT_SECRET?.trim() || undefined;
  if (Boolean(paypalClientId) !== Boolean(paypalClientSecret)) {
    throw new Error(
      'Both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be configured together.'
    );
  }
  const paypalWebhookId = parsed.PAYPAL_WEBHOOK_ID?.trim() || undefined;
  const geminiApiKey = parsed.GEMINI_API_KEY?.trim() || undefined;
  const elasticsearchUrl = parsed.ELASTICSEARCH_URL?.trim() || undefined;
  const elasticsearchApiKey = parsed.ELASTICSEARCH_API_KEY?.trim() || undefined;
  const elasticsearchUsername = parsed.ELASTICSEARCH_USERNAME?.trim() || undefined;
  const elasticsearchPassword = parsed.ELASTICSEARCH_PASSWORD?.trim() || undefined;
  const elasticsearchIndexPrefix = parsed.ELASTICSEARCH_INDEX_PREFIX.trim().toLowerCase();

  const qrPreviousSigningSecret = parsed.QR_PREVIOUS_SIGNING_SECRET?.trim() || undefined;
  const qrPreviousKeyId = qrPreviousSigningSecret
    ? parsed.QR_PREVIOUS_KEY_ID?.trim() || 'k0'
    : undefined;

  return {
    nodeEnv,
    port: parsed.PORT,
    appBaseUrl,
    corsOrigins,
    jwtSecret: resolveSecret(parsed.JWT_SECRET, 'JWT_SECRET', nodeEnv),
    sessionSecret: resolveSecret(parsed.SESSION_SECRET, 'SESSION_SECRET', nodeEnv),
    qrSigningSecret: resolveSecret(parsed.QR_SIGNING_SECRET, 'QR_SIGNING_SECRET', nodeEnv),
    qrKeyId: parsed.QR_KEY_ID,
    qrPreviousKeyId,
    qrPreviousSigningSecret,
    qrTokenTtlSeconds: parsed.QR_TOKEN_TTL_SECONDS,
    defaultCurrency: parsed.DEFAULT_CURRENCY.toUpperCase(),
    mongodbUri,
    paypalEnv: parsed.PAYPAL_ENV,
    paypalClientId,
    paypalClientSecret,
    paypalWebhookId,
    geminiApiKey,
    geminiModel: parsed.GEMINI_MODEL,
    elasticsearchUrl,
    elasticsearchApiKey,
    elasticsearchUsername,
    elasticsearchPassword,
    elasticsearchIndexPrefix,
    elasticsearchRequestTimeoutMs: parsed.ELASTICSEARCH_REQUEST_TIMEOUT_MS,
    aiRateLimitMaxPerMin: parsed.AI_RATE_LIMIT_MAX_PER_MIN,
    enableEmbeddedWorker:
      parsed.ENABLE_EMBEDDED_WORKER === 'true' || parsed.ENABLE_EMBEDDED_WORKER === '1',
    outboxPollIntervalMs: parsed.OUTBOX_POLL_INTERVAL_MS,
    reconcileIntervalMs: parsed.RECONCILE_INTERVAL_MS,
    pendingReconcileMinAgeMs: parsed.PENDING_RECONCILE_MIN_AGE_MS,
    workerLeaseTtlMs: parsed.WORKER_LEASE_TTL_MS,
    workerMaxBackoffMs: parsed.WORKER_MAX_BACKOFF_MS,
    webhookMaxRetries: parsed.WEBHOOK_MAX_RETRIES,
    integrations: {
      mongodbConfigured: Boolean(mongodbUri),
      paypalConfigured: Boolean(paypalClientId && paypalClientSecret),
      paypalWebhookConfigured: Boolean(paypalWebhookId),
      geminiConfigured: Boolean(geminiApiKey),
      elasticsearchConfigured: Boolean(elasticsearchUrl),
    },
  };
}

export const config = loadConfig();

