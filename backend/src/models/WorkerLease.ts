import mongoose, { Document, Schema } from 'mongoose';

export interface IWorkerLease extends Document<string> {
  _id: string;
  ownerId: string;
  status: 'RUNNING' | 'STOPPED' | 'ERROR';
  leaseExpiresAt: Date;
  lastHeartbeatAt: Date;
  lastCycleAt?: Date;
  lastCycleStatus?: 'OK' | 'ERROR';
  lastCycleSummary?: Record<string, unknown>;
  consecutiveFailures: number;
  lastError?: string;
  updatedAt: Date;
}

const workerLeaseSchema = new Schema<IWorkerLease>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true },
    status: { type: String, enum: ['RUNNING', 'STOPPED', 'ERROR'], default: 'RUNNING', required: true },
    leaseExpiresAt: { type: Date, required: true },
    lastHeartbeatAt: { type: Date, required: true },
    lastCycleAt: { type: Date },
    lastCycleStatus: { type: String, enum: ['OK', 'ERROR'] },
    lastCycleSummary: { type: Schema.Types.Mixed },
    consecutiveFailures: { type: Number, default: 0, min: 0 },
    lastError: { type: String },
  },
  { timestamps: true, collection: 'workerLeases' }
);

export const WorkerLeaseModel = mongoose.model<IWorkerLease>('WorkerLease', workerLeaseSchema);

