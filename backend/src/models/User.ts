import mongoose, { Document, Schema, Types } from 'mongoose';
import { USER_ROLES, UserRole } from '../types/domain.js';

export interface IUser extends Document {
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  status: 'ACTIVE' | 'SUSPENDED' | 'INVITED';
  businessId?: Types.ObjectId;
  collectionCenterId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: USER_ROLES, required: true, default: 'CUSTOMER' },
    status: { type: String, enum: ['ACTIVE', 'SUSPENDED', 'INVITED'], default: 'ACTIVE', required: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business' },
    collectionCenterId: { type: Schema.Types.ObjectId, ref: 'CollectionCenter' },
  },
  { timestamps: true, collection: 'users' }
);

userSchema.index({ businessId: 1, role: 1 });

export const UserModel = mongoose.model<IUser>('User', userSchema);

