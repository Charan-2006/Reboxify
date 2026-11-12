import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * Reserved Post-MVP schema (Blueprint Section 6 & 15.1).
 * Not exposed as cash-equivalent rewards in the Hackathon MVP.
 */
export interface IGreenWallet extends Document {
  userId: Types.ObjectId;
  pointsBalance: number;
  ledgerEntries: Array<{
    delta: number;
    reason: string;
    ruleVersion: string;
    referenceId?: string;
    createdAt: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const greenWalletSchema = new Schema<IGreenWallet>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    pointsBalance: { type: Number, default: 0, min: 0 },
    ledgerEntries: [
      {
        delta: { type: Number, required: true },
        reason: { type: String, required: true },
        ruleVersion: { type: String, required: true },
        referenceId: { type: String },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true, collection: 'greenWallets' }
);

export const GreenWalletModel = mongoose.model<IGreenWallet>('GreenWallet', greenWalletSchema);

