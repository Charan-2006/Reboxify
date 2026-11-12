import mongoose, { Document, Schema } from 'mongoose';

export interface ISearchOutbox extends Document {
  entityType: 'passport' | 'package_event' | 'return' | 'payment';
  entityId: string;
  operation: 'UPSERT' | 'DELETE';
  attemptCount: number;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  lastError?: string;
  nextRetryAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const searchOutboxSchema = new Schema<ISearchOutbox>(
  {
    entityType: {
      type: String,
      enum: ['passport', 'package_event', 'return', 'payment'],
      required: true,
    },
    entityId: { type: String, required: true },
    operation: { type: String, enum: ['UPSERT', 'DELETE'], default: 'UPSERT', required: true },
    attemptCount: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'],
      default: 'PENDING',
      required: true,
    },
    lastError: { type: String },
    nextRetryAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: 'searchOutbox' }
);

searchOutboxSchema.index({ status: 1, nextRetryAt: 1 });
searchOutboxSchema.index({ entityType: 1, entityId: 1 });

export const SearchOutboxModel = mongoose.model<ISearchOutbox>(
  'SearchOutbox',
  searchOutboxSchema
);

