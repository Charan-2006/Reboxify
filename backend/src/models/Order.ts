import mongoose, { Document, Schema, Types } from 'mongoose';
import { ORDER_STATUSES, OrderStatus } from '../types/domain.js';

export interface IOrder extends Document {
  orderNumber: string;
  merchantId: Types.ObjectId;
  customerId: Types.ObjectId;
  items: Array<{
    productId: Types.ObjectId;
    sku: string;
    name: string;
    quantity: number;
    unitPrice: number;
  }>;
  shippingReference: {
    recipientName: string;
    zone: string;
    addressLine: string;
    fulfilmentLocation: string;
  };
  allocatedPackages: Array<{
    packageRef: Types.ObjectId;
    packageId: string;
    packageClass: string;
    ownerType: string;
    depositAmount: number;
    depositBreakdown?: {
      baseDeposit: number;
      multiplier: number;
      replacementValue: number;
      ruleVersion: string;
    };
    explanation?: string;
    explanationSource?: 'GEMINI' | 'TEMPLATE';
  }>;
  allocationMetadata?: {
    outcome: string;
    policyVersion: string;
    allocatedAt?: Date;
    splitRecommended?: boolean;
    notes?: string;
  };
  totals: {
    productSubtotal: number;
    depositTotal: number;
    shippingTotal: number;
    taxTotal: number;
    grandTotal: number;
  };
  currency: string;
  status: OrderStatus;
  returnDeadlineAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const orderSchema = new Schema<IOrder>(
  {
    orderNumber: { type: String, required: true, unique: true, uppercase: true, trim: true },
    merchantId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    items: [
      {
        productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
        sku: { type: String, required: true },
        name: { type: String, required: true },
        quantity: { type: Number, required: true, min: 1 },
        unitPrice: { type: Number, required: true, min: 0 },
      },
    ],
    shippingReference: {
      recipientName: { type: String, required: true },
      zone: { type: String, required: true },
      addressLine: { type: String, required: true },
      fulfilmentLocation: { type: String, required: true },
    },
    allocatedPackages: [
      {
        packageRef: { type: Schema.Types.ObjectId, ref: 'Package', required: true },
        packageId: { type: String, required: true },
        packageClass: { type: String, required: true },
        ownerType: { type: String, required: true },
        depositAmount: { type: Number, required: true, min: 0 },
        depositBreakdown: {
          baseDeposit: { type: Number },
          multiplier: { type: Number },
          replacementValue: { type: Number },
          ruleVersion: { type: String },
        },
        explanation: { type: String },
        explanationSource: { type: String, enum: ['GEMINI', 'TEMPLATE'] },
      },
    ],
    allocationMetadata: {
      outcome: { type: String },
      policyVersion: { type: String },
      allocatedAt: { type: Date },
      splitRecommended: { type: Boolean },
      notes: { type: String },
    },
    totals: {
      productSubtotal: { type: Number, required: true, min: 0 },
      depositTotal: { type: Number, required: true, min: 0 },
      shippingTotal: { type: Number, default: 0, min: 0 },
      taxTotal: { type: Number, default: 0, min: 0 },
      grandTotal: { type: Number, required: true, min: 0 },
    },
    currency: { type: String, default: 'USD', uppercase: true, minlength: 3, maxlength: 3 },
    status: { type: String, enum: ORDER_STATUSES, default: 'PLACED', required: true },
    returnDeadlineAt: { type: Date },
  },
  { timestamps: true, collection: 'orders' }
);

orderSchema.index({ merchantId: 1, status: 1, updatedAt: -1 });
orderSchema.index({ customerId: 1, createdAt: -1 });

export const OrderModel = mongoose.model<IOrder>('Order', orderSchema);

