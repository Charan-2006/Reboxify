import mongoose, { Document, Schema, Types } from 'mongoose';
import { OWNERSHIP_MODELS, OwnershipModel } from '../types/domain.js';

export interface IBusiness extends Document {
  ownerUserId: Types.ObjectId;
  name: string;
  legalName: string;
  slug: string;
  currency: string;
  packagingModel: OwnershipModel;
  allowCrossMerchantPool: boolean;
  policies: {
    returnWindowDays: number;
    autoApproveOnPass: boolean;
    depositMultiplier: number;
    allowedReturnApprovers: string[];
  };
  subscription: {
    plan: 'STARTER' | 'BUSINESS' | 'ENTERPRISE';
    status: 'ACTIVE' | 'PAUSED' | 'CANCELLED';
  };
  status: 'ACTIVE' | 'ONBOARDING' | 'SUSPENDED';
  createdAt: Date;
  updatedAt: Date;
}

const businessSchema = new Schema<IBusiness>(
  {
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    legalName: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    currency: { type: String, default: 'USD', uppercase: true, minlength: 3, maxlength: 3 },
    packagingModel: { type: String, enum: OWNERSHIP_MODELS, default: 'HYBRID', required: true },
    allowCrossMerchantPool: { type: Boolean, default: true },
    policies: {
      returnWindowDays: { type: Number, default: 14, min: 1 },
      autoApproveOnPass: { type: Boolean, default: true },
      depositMultiplier: { type: Number, default: 1.0, min: 0 },
      allowedReturnApprovers: { type: [String], default: ['COLLECTION_CENTRE', 'MERCHANT_ADMIN', 'ADMIN'] },
    },
    subscription: {
      plan: { type: String, enum: ['STARTER', 'BUSINESS', 'ENTERPRISE'], default: 'STARTER' },
      status: { type: String, enum: ['ACTIVE', 'PAUSED', 'CANCELLED'], default: 'ACTIVE' },
    },
    status: { type: String, enum: ['ACTIVE', 'ONBOARDING', 'SUSPENDED'], default: 'ACTIVE' },
  },
  { timestamps: true, collection: 'businesses' }
);

businessSchema.index({ ownerUserId: 1 });

export const BusinessModel = mongoose.model<IBusiness>('Business', businessSchema);

