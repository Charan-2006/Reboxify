import mongoose from 'mongoose';
import { AuditLogModel } from '../models/AuditLog.js';

export interface AuditEntryInput {
  actor: {
    userId: string;
    role: string;
    ip?: string;
  };
  action: string;
  entityType: string;
  entityId: string;
  businessId?: string;
  beforeSummary?: Record<string, unknown>;
  afterSummary?: Record<string, unknown>;
  correlationId?: string;
}

export interface AuditWriter {
  record(entry: AuditEntryInput): Promise<void>;
}

export class MongoAuditWriter implements AuditWriter {
  async record(entry: AuditEntryInput): Promise<void> {
    if (mongoose.connection.readyState !== 1) {
      return;
    }

    await AuditLogModel.create({
      actor: entry.actor,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      ...(entry.businessId ? { businessId: new mongoose.Types.ObjectId(entry.businessId) } : {}),
      beforeSummary: entry.beforeSummary,
      afterSummary: entry.afterSummary,
      timestamp: new Date(),
      correlationId: entry.correlationId,
    });
  }
}

export const defaultAuditWriter = new MongoAuditWriter();

