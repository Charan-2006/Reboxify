import mongoose, { Document, Schema, Types } from 'mongoose';
import {
  PACKAGE_CLASSES,
  PACKAGE_OWNER_TYPES,
  PACKAGE_STATUSES,
  PackageClass,
  PackageOwnerType,
  PackageStatus,
} from '../types/domain.js';

export interface IPackage extends Document {
  packageId: string;
  qrTokenHash: string;
  qrTokenVersion: number;
  qrRevoked: boolean;
  qrRevokedAt?: Date;
  qrRevokedReason?: string;
  ownerType: PackageOwnerType;
  ownerId?: Types.ObjectId;
  packageClass: PackageClass;
  dimensionsCm: {
    length: number;
    width: number;
    height: number;
  };
  maxWeightKg: number;
  protectionCategory: 'STANDARD' | 'REINFORCED' | 'HIGH_PROTECTION';
  supportsLiquidContainment: boolean;
  material: string;
  replacementValue: number;
  depositAmount: number;
  currency: string;
  status: PackageStatus;
  condition: 'NEW' | 'GOOD' | 'MINOR_WEAR' | 'DAMAGED' | 'CONTAMINATED';
  reuseCount: number;
  maxLifecycleLimit: number;
  fulfilmentLocation: string;
  currentCustodian: {
    custodianType: 'REBOXIFY_CENTRE' | 'MERCHANT' | 'DELIVERY_PARTNER' | 'CUSTOMER';
    custodianId: string;
    label: string;
    assignedAt: Date;
  };
  currentOrderId?: Types.ObjectId;
  assignedPartnerUserId?: Types.ObjectId;
  assignedPartnerName?: string;
  lastInspectionAt?: Date;
  lastInspectionOutcome?: 'PASS' | 'FAIL' | 'NEEDS_REVIEW';
  lastCleanedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const packageSchema = new Schema<IPackage>(
  {
    packageId: { type: String, required: true, unique: true, uppercase: true, trim: true },
    qrTokenHash: { type: String, required: true },
    qrTokenVersion: { type: Number, default: 1, min: 1, required: true },
    qrRevoked: { type: Boolean, default: false, required: true },
    qrRevokedAt: { type: Date },
    qrRevokedReason: { type: String, trim: true },
    ownerType: { type: String, enum: PACKAGE_OWNER_TYPES, required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'Business' },
    packageClass: { type: String, enum: PACKAGE_CLASSES, required: true },
    dimensionsCm: {
      length: { type: Number, required: true, gt: 0 },
      width: { type: Number, required: true, gt: 0 },
      height: { type: Number, required: true, gt: 0 },
    },
    maxWeightKg: { type: Number, required: true, gt: 0 },
    protectionCategory: {
      type: String,
      enum: ['STANDARD', 'REINFORCED', 'HIGH_PROTECTION'],
      default: 'STANDARD',
      required: true,
    },
    supportsLiquidContainment: { type: Boolean, default: false },
    material: { type: String, default: 'REUSABLE_PP', required: true },
    replacementValue: { type: Number, required: true, min: 0 },
    depositAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD', uppercase: true, minlength: 3, maxlength: 3 },
    status: { type: String, enum: PACKAGE_STATUSES, default: 'AVAILABLE', required: true },
    condition: {
      type: String,
      enum: ['NEW', 'GOOD', 'MINOR_WEAR', 'DAMAGED', 'CONTAMINATED'],
      default: 'NEW',
    },
    reuseCount: { type: Number, default: 0, min: 0 },
    maxLifecycleLimit: { type: Number, default: 50, min: 1 },
    fulfilmentLocation: { type: String, required: true, trim: true },
    currentCustodian: {
      custodianType: {
        type: String,
        enum: ['REBOXIFY_CENTRE', 'MERCHANT', 'DELIVERY_PARTNER', 'CUSTOMER'],
        required: true,
      },
      custodianId: { type: String, required: true },
      label: { type: String, required: true },
      assignedAt: { type: Date, default: Date.now },
    },
    currentOrderId: { type: Schema.Types.ObjectId, ref: 'Order' },
    assignedPartnerUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    assignedPartnerName: { type: String, trim: true },
    lastInspectionAt: { type: Date },
    lastInspectionOutcome: { type: String, enum: ['PASS', 'FAIL', 'NEEDS_REVIEW'] },
    lastCleanedAt: { type: Date },
  },
  { timestamps: true, collection: 'packages' }
);

packageSchema.index({ ownerId: 1, status: 1, updatedAt: -1 });
packageSchema.index({ status: 1, packageClass: 1, fulfilmentLocation: 1 });
packageSchema.index({ assignedPartnerUserId: 1, status: 1, updatedAt: -1 });

export const PackageModel = mongoose.model<IPackage>('Package', packageSchema);

