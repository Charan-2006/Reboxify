import mongoose, { Document, Schema, Types } from 'mongoose';
import { UserRole } from '../types/domain.js';

export interface IAiInteraction extends Document {
  userId: Types.ObjectId;
  role: UserRole;
  businessId?: Types.ObjectId;
  intent: string;
  toolCalls: Array<{
    toolName: string;
    allowed: boolean;
    outcome: 'SUCCESS' | 'DENIED' | 'ERROR';
  }>;
  resultRefs: string[];
  modelName: string;
  promptTemplateVersion: string;
  outcome: 'SUCCESS' | 'FALLBACK' | 'REFUSED' | 'ERROR';
  flagged: boolean;
  correlationId?: string;
  createdAt: Date;
}

const aiInteractionSchema = new Schema<IAiInteraction>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, required: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'Business' },
    intent: { type: String, required: true },
    toolCalls: [
      {
        toolName: { type: String, required: true },
        allowed: { type: Boolean, required: true },
        outcome: { type: String, enum: ['SUCCESS', 'DENIED', 'ERROR'], required: true },
      },
    ],
    resultRefs: { type: [String], default: [] },
    modelName: { type: String, required: true },
    promptTemplateVersion: { type: String, required: true },
    outcome: { type: String, enum: ['SUCCESS', 'FALLBACK', 'REFUSED', 'ERROR'], required: true },
    flagged: { type: Boolean, default: false },
    correlationId: { type: String },
  },
  { timestamps: true, collection: 'aiInteractions' }
);

aiInteractionSchema.index({ userId: 1, createdAt: -1 });
aiInteractionSchema.index({ businessId: 1, createdAt: -1 });

export const AiInteractionModel = mongoose.model<IAiInteraction>(
  'AiInteraction',
  aiInteractionSchema
);

