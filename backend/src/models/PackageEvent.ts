import mongoose, { Document, Schema, Types } from 'mongoose';
import { UserRole } from '../types/domain.js';

export interface IPackageEvent extends Document {
  eventId: string;
  packageId: string;
  merchantId?: Types.ObjectId;
  scanId?: string;
  type: string;
  actor: {
    userId: string;
    role: UserRole | 'SYSTEM' | 'PAYPAL_WEBHOOK';
  };
  occurredAt: Date;
  sourceSystem: string;
  correlationId?: string;
  locationRef?: string;
  outcome: 'ACCEPTED' | 'REJECTED';
  evidence: Array<{
    type: 'PHOTO' | 'QR_SCAN' | 'SIGNATURE' | 'NOTE';
    fileRef?: string;
    detail?: string;
  }>;
  metadata?: Record<string, unknown>;
}

const packageEventSchema = new Schema<IPackageEvent>(
  {
    eventId: { type: String, required: true, unique: true },
    packageId: { type: String, required: true, uppercase: true, trim: true },
    merchantId: { type: Schema.Types.ObjectId, ref: 'Business' },
    scanId: {
      type: String,
      trim: true,
      set: (value: unknown) => {
        if (typeof value !== 'string') return undefined;
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      },
    },
    type: { type: String, required: true, trim: true },
    actor: {
      userId: { type: String, required: true },
      role: { type: String, required: true },
    },
    occurredAt: { type: Date, default: Date.now, required: true },
    sourceSystem: { type: String, default: 'REBOXIFY_API', required: true },
    correlationId: { type: String },
    locationRef: { type: String },
    outcome: { type: String, enum: ['ACCEPTED', 'REJECTED'], default: 'ACCEPTED', required: true },
    evidence: [
      {
        type: { type: String, enum: ['PHOTO', 'QR_SCAN', 'SIGNATURE', 'NOTE'], required: true },
        fileRef: { type: String },
        detail: { type: String },
      },
    ],
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: false, collection: 'packageEvents' }
);

packageEventSchema.index({ packageId: 1, occurredAt: -1 });
packageEventSchema.index({ merchantId: 1, occurredAt: -1 });
packageEventSchema.index({ outcome: 1, occurredAt: -1 });
packageEventSchema.index(
  { packageId: 1, scanId: 1 },
  {
    unique: true,
    partialFilterExpression: { scanId: { $exists: true } },
  }
);

// Blueprint Section 15.3: packageEvents are append-only; corrections create compensating events.
const blockMutation = function (next: (err?: Error) => void) {
  next(new Error('packageEvents collection is append-only and cannot be modified or deleted.'));
};

packageEventSchema.pre('updateOne', blockMutation);
packageEventSchema.pre('updateMany', blockMutation);
packageEventSchema.pre('findOneAndUpdate', blockMutation);
packageEventSchema.pre('deleteOne', blockMutation);
packageEventSchema.pre('deleteMany', blockMutation);
packageEventSchema.pre('findOneAndDelete', blockMutation);

export const PackageEventModel = mongoose.model<IPackageEvent>(
  'PackageEvent',
  packageEventSchema
);

