import mongoose, { Document, Schema } from 'mongoose';

export interface IIdempotencyKey extends Document {
  key: string;
  operation: string;
  actorId: string;
  requestHash: string;
  statusCode: number;
  resultRef: Record<string, unknown>;
  expiresAt: Date;
  createdAt: Date;
}

const idempotencyKeySchema = new Schema<IIdempotencyKey>(
  {
    key: { type: String, required: true, unique: true, trim: true },
    operation: { type: String, required: true },
    actorId: { type: String, required: true },
    requestHash: { type: String, required: true },
    statusCode: { type: Number, required: true },
    resultRef: { type: Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'idempotencyKeys' }
);

idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyKeyModel = mongoose.model<IIdempotencyKey>(
  'IdempotencyKey',
  idempotencyKeySchema
);

