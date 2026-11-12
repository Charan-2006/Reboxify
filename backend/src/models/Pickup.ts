import mongoose, { Document, Schema, Types } from 'mongoose';
import { PICKUP_STATUSES, PickupStatus, RETURN_MODES, ReturnMode } from '../types/domain.js';

export interface IPickup extends Document {
  returnId: Types.ObjectId;
  orderId?: Types.ObjectId;
  packageId: string;
  merchantId: Types.ObjectId;
  customerId?: Types.ObjectId;
  collectionCenterId?: Types.ObjectId;
  slotStart: Date;
  slotEnd: Date;
  timeZone: string;
  pickupMethod: ReturnMode;
  serviceZone: string;
  addressSummary: string;
  location?: {
    lat: number;
    lng: number;
  };
  partnerId?: Types.ObjectId;
  assignedPartnerName?: string;
  status: PickupStatus;
  rescheduleHistory: Array<{
    previousStart: Date;
    previousEnd: Date;
    newStart: Date;
    newEnd: Date;
    reason: string;
    changedBy: Types.ObjectId;
    changedAt: Date;
  }>;
  missedReason?: string;
  cancelReason?: string;
  notes?: string;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const pickupSchema = new Schema<IPickup>(
  {
    returnId: { type: Schema.Types.ObjectId, ref: 'Return', required: true, unique: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
    packageId: { type: String, required: true, uppercase: true, trim: true },
    merchantId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User' },
    collectionCenterId: { type: Schema.Types.ObjectId, ref: 'CollectionCenter' },
    slotStart: { type: Date, required: true },
    slotEnd: { type: Date, required: true },
    timeZone: { type: String, default: 'UTC', trim: true },
    pickupMethod: { type: String, enum: RETURN_MODES, default: 'PICKUP' },
    serviceZone: { type: String, required: true, trim: true },
    addressSummary: { type: String, required: true },
    location: {
      lat: { type: Number },
      lng: { type: Number },
    },
    partnerId: { type: Schema.Types.ObjectId, ref: 'User' },
    assignedPartnerName: { type: String, trim: true },
    status: { type: String, enum: PICKUP_STATUSES, default: 'UNASSIGNED', required: true },
    rescheduleHistory: [
      {
        previousStart: { type: Date, required: true },
        previousEnd: { type: Date, required: true },
        newStart: { type: Date, required: true },
        newEnd: { type: Date, required: true },
        reason: { type: String, required: true },
        changedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        changedAt: { type: Date, default: Date.now },
      },
    ],
    missedReason: { type: String },
    cancelReason: { type: String },
    notes: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'pickups' }
);

pickupSchema.index({ partnerId: 1, slotStart: 1, slotEnd: 1 });
pickupSchema.index({ merchantId: 1, status: 1, slotStart: 1 });
pickupSchema.index({ status: 1, slotStart: 1 });
pickupSchema.index({ collectionCenterId: 1, status: 1 });

export const PickupModel = mongoose.model<IPickup>('Pickup', pickupSchema);

