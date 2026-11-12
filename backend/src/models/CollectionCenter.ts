import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ICollectionCenter extends Document {
  code: string;
  name: string;
  operatorUserId: Types.ObjectId;
  address: string;
  serviceZones: string[];
  hours: string;
  capacity: number;
  currentWorkload: number;
  status: 'ACTIVE' | 'FULL' | 'OFFLINE';
  createdAt: Date;
  updatedAt: Date;
}

const collectionCenterSchema = new Schema<ICollectionCenter>(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    operatorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    address: { type: String, required: true },
    serviceZones: { type: [String], default: [] },
    hours: { type: String, default: '09:00-19:00' },
    capacity: { type: Number, default: 200, min: 1 },
    currentWorkload: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ['ACTIVE', 'FULL', 'OFFLINE'], default: 'ACTIVE' },
  },
  { timestamps: true, collection: 'collectionCenters' }
);

collectionCenterSchema.index({ operatorUserId: 1 });
collectionCenterSchema.index({ serviceZones: 1, status: 1 });

export const CollectionCenterModel = mongoose.model<ICollectionCenter>(
  'CollectionCenter',
  collectionCenterSchema
);

