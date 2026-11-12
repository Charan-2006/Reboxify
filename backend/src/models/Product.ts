import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IProduct extends Document {
  merchantId: Types.ObjectId;
  sku: string;
  name: string;
  dimensionsCm: {
    length: number;
    width: number;
    height: number;
  };
  weightKg: number;
  allowedOrientations: string[];
  rotatable: boolean;
  fragility: 'LOW' | 'MEDIUM' | 'HIGH';
  restrictions: {
    liquidContainment: boolean;
    temperatureControlled: boolean;
    contaminationSensitive: boolean;
    notes?: string;
  };
  unitPrice: number;
  currency: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<IProduct>(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    sku: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    dimensionsCm: {
      length: { type: Number, required: true, gt: 0 },
      width: { type: Number, required: true, gt: 0 },
      height: { type: Number, required: true, gt: 0 },
    },
    weightKg: { type: Number, required: true, gt: 0 },
    allowedOrientations: { type: [String], default: ['UPRIGHT', 'ROTATED'] },
    rotatable: { type: Boolean, default: true },
    fragility: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], default: 'LOW' },
    restrictions: {
      liquidContainment: { type: Boolean, default: false },
      temperatureControlled: { type: Boolean, default: false },
      contaminationSensitive: { type: Boolean, default: false },
      notes: { type: String },
    },
    unitPrice: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD', uppercase: true, minlength: 3, maxlength: 3 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'products' }
);

// Blueprint Section 15.3: Unique compound index on (merchantId, sku)
productSchema.index({ merchantId: 1, sku: 1 }, { unique: true });

export const ProductModel = mongoose.model<IProduct>('Product', productSchema);

