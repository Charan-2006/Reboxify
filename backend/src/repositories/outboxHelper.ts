import { ClientSession } from 'mongoose';
import { SearchOutboxModel } from '../models/index.js';

export interface SearchOutboxEntryInput {
  entityType: 'passport' | 'package_event' | 'return' | 'payment';
  entityId: string;
  operation?: 'UPSERT' | 'DELETE';
  status?: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
}

/**
 * Persists one or more SearchOutbox entries atomically within an active Mongoose
 * session when provided. Mongoose requires `{ session, ordered: true }` when passing
 * multiple documents to `Model.create()` inside a transaction session.
 */
export async function enqueueSearchOutbox(
  entries: SearchOutboxEntryInput[],
  session?: ClientSession | null
): Promise<void> {
  if (entries.length === 0) return;

  const docs = entries.map((entry) => ({
    entityType: entry.entityType,
    entityId: entry.entityId,
    operation: entry.operation ?? 'UPSERT',
    status: entry.status ?? 'PENDING',
  }));

  if (session) {
    await SearchOutboxModel.create(docs, { session, ordered: true });
    return;
  }

  await SearchOutboxModel.create(docs);
}

