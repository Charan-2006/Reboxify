import mongoose, { ClientSession } from 'mongoose';
import { AppError, serviceUnavailable } from '../utils/errors.js';
import { config } from './env.js';

export interface DatabaseStatus {
  connected: boolean;
  readyState: number;
  replicaSetSupported: boolean;
  lastError?: string;
}

let replicaSetSupported = false;
let lastDbError: string | undefined;

export function sanitizeDbErrorMessage(raw: string): string {
  return raw.replace(/(mongodb(?:\+srv)?:\/\/)([^@\s]+)@/gi, '$1***@');
}

export async function connectDatabase(uri?: string): Promise<DatabaseStatus> {
  replicaSetSupported = false;
  if (!uri) {
    lastDbError = 'MONGODB_URI is not configured.';
    return getDatabaseStatus();
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
    });
    lastDbError = undefined;

    // Detect replica set capability for multi-document transactions.
    const admin = mongoose.connection.db?.admin();
    if (admin) {
      try {
        const hello = await admin.command({ hello: 1 });
        replicaSetSupported = Boolean(hello.setName || hello.msg === 'isdbgrid');
      } catch {
        replicaSetSupported = false;
      }
    }
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'Failed to connect to MongoDB';
    lastDbError = sanitizeDbErrorMessage(rawMsg);
  }

  return getDatabaseStatus();
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  replicaSetSupported = false;
}

export function getDatabaseStatus(): DatabaseStatus {
  return {
    connected: mongoose.connection.readyState === 1,
    readyState: mongoose.connection.readyState,
    replicaSetSupported,
    lastError: lastDbError,
  };
}

/**
 * Executes a callback inside a MongoDB replica-set transaction when supported.
 * In production (or when requireReplicaSet=true), throws a 503 AppError rather than
 * silently falling back to non-transactional writes.
 */
export async function runInTransaction<T>(
  work: (session: ClientSession | null) => Promise<T>,
  options: { requireReplicaSet?: boolean } = {}
): Promise<T> {
  if (mongoose.connection.readyState !== 1) {
    throw serviceUnavailable('Database connection is not active.');
  }

  const mustUseReplicaSet =
    options.requireReplicaSet ??
    (process.env.NODE_ENV === 'production' || config.nodeEnv === 'production');

  if (!replicaSetSupported) {
    if (mustUseReplicaSet) {
      throw new AppError(
        503,
        'TRANSACTION_INFRASTRUCTURE_UNAVAILABLE',
        'MongoDB replica set is required for transactional consistency in production.'
      );
    }
    return work(null);
  }

  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

