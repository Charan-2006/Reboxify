import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IAuditLog extends Document {
  actor: {
    userId: string;
    role: string;
    ip?: string;
  };
  action: string;
  entityType: string;
  entityId: string;
  businessId?: Types.ObjectId;
  beforeSummary?: Record<string, unknown>;
  afterSummary?: Record<string, unknown>;
  timestamp: Date;
  correlationId?: string;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    actor: {
      userId: { type: String, required: true },
      role: { type: String, required: true },
      ip: { type: String },
    },
    action: { type: String, required: true, trim: true },
    entityType: { type: String, required: true, trim: true },
    entityId: { type: String, required: true, trim: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business' },
    beforeSummary: { type: Schema.Types.Mixed },
    afterSummary: { type: Schema.Types.Mixed },
    timestamp: { type: Date, default: Date.now, required: true },
    correlationId: { type: String },
  },
  { timestamps: false, collection: 'auditLogs' }
);

auditLogSchema.index({ businessId: 1, timestamp: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1, timestamp: -1 });
auditLogSchema.index({ correlationId: 1 });

export const AuditLogModel = mongoose.model<IAuditLog>('AuditLog', auditLogSchema);

