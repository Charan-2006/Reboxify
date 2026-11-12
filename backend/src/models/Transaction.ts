import mongoose, { Document, Schema, Types } from 'mongoose';
import { PAYMENT_STATUSES, PaymentStatus } from '../types/domain.js';

export interface ITransaction extends Document {
  orderId: Types.ObjectId;
  merchantId: Types.ObjectId;
  customerId: Types.ObjectId;
  paypalOrderId: string;
  captureId?: string;
  amount: number;
  currency: string;
  state: PaymentStatus;
  depositAllocations: Array<{
    packageId: string;
    allocatedDeposit: number;
    refundedAmount: number;
    pendingRefundAmount: number;
  }>;
  approvedAt?: Date;
  capturedAt?: Date;
  lastReconciledAt?: Date;
  providerStatus?: string;
  createdAt: Date;
  updatedAt: Date;
}

const transactionSchema = new Schema<ITransaction>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    merchantId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    paypalOrderId: { type: String, required: true, unique: true, trim: true },
    captureId: { type: String, unique: true, sparse: true, trim: true },
    amount: { type: Number, required: true, gt: 0 },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
    state: { type: String, enum: PAYMENT_STATUSES, default: 'CREATED', required: true },
    depositAllocations: [
      {
        packageId: { type: String, required: true },
        allocatedDeposit: { type: Number, required: true, min: 0 },
        refundedAmount: { type: Number, default: 0, min: 0 },
        pendingRefundAmount: { type: Number, default: 0, min: 0 },
      },
    ],
    approvedAt: { type: Date },
    capturedAt: { type: Date },
    lastReconciledAt: { type: Date },
    providerStatus: { type: String },
  },
  { timestamps: true, collection: 'transactions' }
);

transactionSchema.index({ merchantId: 1, state: 1, updatedAt: -1 });
transactionSchema.index({ orderId: 1 });

export const TransactionModel = mongoose.model<ITransaction>('Transaction', transactionSchema);

