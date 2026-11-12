import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IDeliveryPartner extends Document {
  userId: Types.ObjectId;
  displayName: string;
  serviceZones: string[];
  workingHours: {
    startHour: number;
    endHour: number;
    daysOfWeek: number[];
  };
  dailyCapacity: number;
  status: 'ACTIVE' | 'UNAVAILABLE' | 'SUSPENDED';
  createdAt: Date;
  updatedAt: Date;
}

const deliveryPartnerSchema = new Schema<IDeliveryPartner>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    displayName: { type: String, required: true, trim: true },
    serviceZones: { type: [String], required: true, default: [] },
    workingHours: {
      startHour: { type: Number, default: 8, min: 0, max: 23 },
      endHour: { type: Number, default: 20, min: 1, max: 24 },
      daysOfWeek: { type: [Number], default: [1, 2, 3, 4, 5, 6] },
    },
    dailyCapacity: { type: Number, default: 15, min: 1 },
    status: { type: String, enum: ['ACTIVE', 'UNAVAILABLE', 'SUSPENDED'], default: 'ACTIVE' },
  },
  { timestamps: true, collection: 'deliveryPartners' }
);

deliveryPartnerSchema.index({ serviceZones: 1, status: 1 });

export const DeliveryPartnerModel = mongoose.model<IDeliveryPartner>(
  'DeliveryPartner',
  deliveryPartnerSchema
);

