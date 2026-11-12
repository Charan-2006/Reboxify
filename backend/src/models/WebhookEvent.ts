import mongoose, { Document, Schema } from 'mongoose';

export interface IWebhookEvent extends Document {
  provider: 'PAYPAL';
  providerEventId: string;
  eventType: string;
  resourceId?: string;
  payloadSummary: Record<string, unknown>;
  resourceSnapshot?: Record<string, unknown>;
  verificationResult: 'VERIFIED' | 'FAILED' | 'PENDING';
  processingState: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED';
  retryCount: number;
  nextRetryAt?: Date;
  error?: string;
  receivedAt: Date;
  processedAt?: Date;
}

const webhookEventSchema = new Schema<IWebhookEvent>(
  {
    provider: { type: String, enum: ['PAYPAL'], default: 'PAYPAL', required: true },
    providerEventId: { type: String, required: true, unique: true, trim: true },
    eventType: { type: String, required: true, trim: true },
    resourceId: { type: String, trim: true },
    payloadSummary: { type: Schema.Types.Mixed, required: true },
    resourceSnapshot: { type: Schema.Types.Mixed },
    verificationResult: {
      type: String,
      enum: ['VERIFIED', 'FAILED', 'PENDING'],
      required: true,
    },
    processingState: {
      type: String,
      enum: ['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED'],
      default: 'RECEIVED',
      required: true,
    },
    retryCount: { type: Number, default: 0, min: 0 },
    nextRetryAt: { type: Date },
    error: { type: String },
    receivedAt: { type: Date, default: Date.now },
    processedAt: { type: Date },
  },
  { timestamps: true, collection: 'webhookEvents' }
);

webhookEventSchema.index({ eventType: 1, processingState: 1 });
webhookEventSchema.index({ processingState: 1, verificationResult: 1, nextRetryAt: 1 });

export const WebhookEventModel = mongoose.model<IWebhookEvent>(
  'WebhookEvent',
  webhookEventSchema
);

