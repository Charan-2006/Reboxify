import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { NextFunction, Request, Response } from 'express';
import { IdempotencyKeyModel } from '../models/IdempotencyKey.js';
import { badRequest, conflict } from '../utils/errors.js';

export interface IdempotencyRecord {
  key: string;
  operation: string;
  actorId: string;
  requestHash: string;
  statusCode: number;
  resultRef: Record<string, unknown>;
  expiresAt: Date;
}

export interface IdempotencyStore {
  findByKey(key: string): Promise<IdempotencyRecord | null>;
  save(record: IdempotencyRecord): Promise<void>;
}

export class MongooseIdempotencyStore implements IdempotencyStore {
  async findByKey(key: string): Promise<IdempotencyRecord | null> {
    if (mongoose.connection.readyState !== 1) return null;
    const doc = await IdempotencyKeyModel.findOne({ key }).lean();
    if (!doc) return null;
    return {
      key: doc.key,
      operation: doc.operation,
      actorId: doc.actorId,
      requestHash: doc.requestHash,
      statusCode: doc.statusCode,
      resultRef: doc.resultRef as Record<string, unknown>,
      expiresAt: doc.expiresAt,
    };
  }

  async save(record: IdempotencyRecord): Promise<void> {
    if (mongoose.connection.readyState !== 1) return;
    await IdempotencyKeyModel.create(record).catch(() => undefined);
  }
}

const defaultIdempotencyStore = new MongooseIdempotencyStore();

function hashPayload(body: unknown, params: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ body: body ?? {}, params: params ?? {} }))
    .digest('hex');
}

export function requireIdempotency(
  operation: string,
  options: { optional?: boolean; store?: IdempotencyStore } = {}
) {
  const store = options.store ?? defaultIdempotencyStore;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawKey = req.header('idempotency-key')?.trim();
    if (!rawKey) {
      if (options.optional) {
        next();
        return;
      }
      next(badRequest('Idempotency-Key header is required for this operation.'));
      return;
    }

    const actorId = req.auth?.userId ?? 'anonymous';
    const compositeKey = `${operation}:${actorId}:${rawKey}`;
    const requestHash = hashPayload(req.body, req.params);

    const existing = await store.findByKey(compositeKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        next(
          conflict(
            'Idempotency-Key was reused with a different request payload.',
            'IDEMPOTENCY_CONFLICT'
          )
        );
        return;
      }
      res.status(existing.statusCode).json(existing.resultRef);
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = ((payload: Record<string, unknown>) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        void store.save({
          key: compositeKey,
          operation,
          actorId,
          requestHash,
          statusCode: res.statusCode,
          resultRef: payload,
          expiresAt,
        });
      }
      return originalJson(payload);
    }) as Response['json'];

    next();
  };
}
