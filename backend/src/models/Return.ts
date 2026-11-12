import mongoose, { Document, Schema, Types } from 'mongoose';
import {
  INSPECTION_CONDITIONS,
  InspectionCondition,
  RETURN_MODES,
  RETURN_STATUSES,
  ReturnMode,
  ReturnStatus,
} from '../types/domain.js';

export interface IReturn extends Document {
  returnNumber: string;
  orderId: Types.ObjectId;
  packageRef: Types.ObjectId;
  packageId: string;
  merchantId: Types.ObjectId;
  customerId: Types.ObjectId;
  mode: ReturnMode;
  returnMethodDetails?: {
    dropoffLocationLabel?: string;
    pickupWindowStart?: Date;
    pickupWindowEnd?: Date;
    serviceZone?: string;
    addressSummary?: string;
    swapOrderNumber?: string;
  };
  pickupId?: Types.ObjectId;
  collectionCenterId?: Types.ObjectId;
  assignedPartnerUserId?: Types.ObjectId;
  assignedPartnerName?: string;
  status: ReturnStatus;
  reason?: string;
  returnDeadlineAt?: Date;
  isLateReturn: boolean;
  daysLate: number;
  disputed: boolean;
  disputeReason?: string;
  collectedAt?: Date;
  receivedAt?: Date;
  receivedBy?: Types.ObjectId;
  evidenceFiles: Array<{
    fileId: string;
    filename: string;
    mimeType: string;
    sizeBytes?: number;
    uploadedAt: Date;
    uploadedBy: Types.ObjectId;
  }>;
  inspection?: {
    inspectorId: Types.ObjectId;
    inspectedAt: Date;
    checklist: {
      identityVerified: boolean;
      structuralIntegrity: boolean;
      cleanlinessAcceptable: boolean;
      completeComponents: boolean;
    };
    condition: InspectionCondition;
    outcome: 'PASS' | 'FAIL' | 'NEEDS_REVIEW';
    damageReason?: string;
    notes?: string;
  };
  decision?: {
    decidedBy: Types.ObjectId;
    decidedAt: Date;
    outcome: 'APPROVED' | 'REJECTED' | 'NEEDS_REVIEW';
    reason: string;
  };
  refundEligibility: {
    eligible: boolean;
    reason?: string;
    originalDeposit: number;
    totalDeductions: number;
    calculatedAmount: number;
    currency: string;
    ruleVersion?: string;
    deductionBreakdown: Array<{
      code: string;
      label: string;
      amount: number;
      reason: string;
    }>;
  };
  refundId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const returnSchema = new Schema<IReturn>(
  {
    returnNumber: { type: String, required: true, unique: true, uppercase: true, trim: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    packageRef: { type: Schema.Types.ObjectId, ref: 'Package', required: true },
    packageId: { type: String, required: true, uppercase: true, trim: true },
    merchantId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mode: { type: String, enum: RETURN_MODES, required: true },
    returnMethodDetails: {
      dropoffLocationLabel: { type: String, trim: true },
      pickupWindowStart: { type: Date },
      pickupWindowEnd: { type: Date },
      serviceZone: { type: String, trim: true },
      addressSummary: { type: String, trim: true },
      swapOrderNumber: { type: String, trim: true },
    },
    pickupId: { type: Schema.Types.ObjectId, ref: 'Pickup' },
    collectionCenterId: { type: Schema.Types.ObjectId, ref: 'CollectionCenter' },
    assignedPartnerUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    assignedPartnerName: { type: String, trim: true },
    status: { type: String, enum: RETURN_STATUSES, default: 'REQUESTED', required: true },
    reason: { type: String, trim: true },
    returnDeadlineAt: { type: Date },
    isLateReturn: { type: Boolean, default: false, required: true },
    daysLate: { type: Number, default: 0, min: 0 },
    disputed: { type: Boolean, default: false, required: true },
    disputeReason: { type: String, trim: true },
    collectedAt: { type: Date },
    receivedAt: { type: Date },
    receivedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    evidenceFiles: [
      {
        fileId: { type: String, required: true },
        filename: { type: String, required: true },
        mimeType: { type: String, required: true },
        sizeBytes: { type: Number },
        uploadedAt: { type: Date, default: Date.now },
        uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      },
    ],
    inspection: {
      inspectorId: { type: Schema.Types.ObjectId, ref: 'User' },
      inspectedAt: { type: Date },
      checklist: {
        identityVerified: { type: Boolean },
        structuralIntegrity: { type: Boolean },
        cleanlinessAcceptable: { type: Boolean },
        completeComponents: { type: Boolean },
      },
      condition: { type: String, enum: INSPECTION_CONDITIONS },
      outcome: { type: String, enum: ['PASS', 'FAIL', 'NEEDS_REVIEW'] },
      damageReason: { type: String, trim: true },
      notes: { type: String },
    },
    decision: {
      decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      decidedAt: { type: Date },
      outcome: { type: String, enum: ['APPROVED', 'REJECTED', 'NEEDS_REVIEW'] },
      reason: { type: String },
    },
    refundEligibility: {
      eligible: { type: Boolean, default: false },
      reason: { type: String },
      originalDeposit: { type: Number, default: 0, min: 0 },
      totalDeductions: { type: Number, default: 0, min: 0 },
      calculatedAmount: { type: Number, default: 0, min: 0 },
      currency: { type: String, default: 'USD' },
      ruleVersion: { type: String },
      deductionBreakdown: [
        {
          code: { type: String, required: true },
          label: { type: String, required: true },
          amount: { type: Number, required: true, min: 0 },
          reason: { type: String, required: true },
        },
      ],
    },
    refundId: { type: Schema.Types.ObjectId, ref: 'Refund' },
  },
  { timestamps: true, collection: 'returns' }
);

returnSchema.index({ orderId: 1, packageId: 1 }, { unique: true });
returnSchema.index({ merchantId: 1, status: 1, updatedAt: -1 });
returnSchema.index({ customerId: 1, createdAt: -1 });
returnSchema.index({ assignedPartnerUserId: 1, status: 1, updatedAt: -1 });

export const ReturnModel = mongoose.model<IReturn>('Return', returnSchema);

