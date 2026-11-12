import mongoose, { Document, Schema, Types } from 'mongoose';
import { PAYMENT_STATUSES, PaymentStatus } from '../types/domain.js';

export interface IRefund extends Document {
  transactionId: Types.ObjectId;
  orderId: Types.ObjectId;
  returnId: Types.ObjectId;
  merchantId: Types.ObjectId;
  packageId: string;
  captureId: string;
  paypalRequestId: string;
  providerRefundId?: string;
  providerStatus?: string;
  failureReason?: string;
  amount: number;
  currency: string;
  reason: string;
  state: PaymentStatus;
  idempotencyKey: string;
  initiatedBy: Types.ObjectId;
  lastReconciledAt?: Date;
  confirmedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const refundSchema = new Schema<IRefund>(
  {
    transactionId: { type: Schema.Types.ObjectId, ref: 'Transaction', required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    returnId: { type: Schema.Types.ObjectId, ref: 'Return', required: true },
    merchantId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    packageId: { type: String, required: true, uppercase: true, trim: true },
    captureId: { type: String, required: true, trim: true },
    paypalRequestId: { type: String, required: true, trim: true },
    providerRefundId: { type: String, unique: true, sparse: true, trim: true },
    providerStatus: { type: String, trim: true },
    failureReason: { type: String, trim: true },
    amount: { type: Number, required: true, gt: 0 },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
    reason: { type: String, required: true },
    state: { type: String, enum: PAYMENT_STATUSES, default: 'REFUND_REQUESTED', required: true },
    idempotencyKey: { type: String, required: true, unique: true },
    initiatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lastReconciledAt: { type: Date },
    confirmedAt: { type: Date },
  },
  { timestamps: true, collection: 'refunds' }
);

refundSchema.index({ transactionId: 1, state: 1 });
refundSchema.index({ returnId: 1, state: 1 });
refundSchema.index({ merchantId: 1, state: 1, updatedAt: -1 });

export const RefundModel = mongoose.model<IRefund>('Refund', refundSchema);

