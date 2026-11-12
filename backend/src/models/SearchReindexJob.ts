import mongoose, { Document, Schema } from 'mongoose';

export type ReindexEntityScope = 'orders' | 'packages' | 'returns' | 'transactions';

export interface ISearchReindexJob extends Document {
  jobId: string;
  requestedBy: string;
  merchantId?: string;
  entities: ReindexEntityScope[];
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  currentEntity?: ReindexEntityScope;
  cursors: {
    orders?: string;
    packages?: string;
    returns?: string;
    transactions?: string;
  };
  processedCounts: {
    orders: number;
    packages: number;
    returns: number;
    transactions: number;
  };
  failedCount: number;
  lastError?: string;
  startedAt: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const searchReindexJobSchema = new Schema<ISearchReindexJob>(
  {
    jobId: { type: String, required: true, unique: true },
    requestedBy: { type: String, required: true },
    merchantId: { type: String },
    entities: {
      type: [String],
      enum: ['orders', 'packages', 'returns', 'transactions'],
      required: true,
    },
    status: {
      type: String,
      enum: ['RUNNING', 'COMPLETED', 'FAILED'],
      default: 'RUNNING',
      required: true,
    },
    currentEntity: {
      type: String,
      enum: ['orders', 'packages', 'returns', 'transactions'],
    },
    cursors: {
      orders: { type: String },
      packages: { type: String },
      returns: { type: String },
      transactions: { type: String },
    },
    processedCounts: {
      orders: { type: Number, default: 0 },
      packages: { type: Number, default: 0 },
      returns: { type: Number, default: 0 },
      transactions: { type: Number, default: 0 },
    },
    failedCount: { type: Number, default: 0 },
    lastError: { type: String },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date },
  },
  { timestamps: true, collection: 'searchReindexJobs' }
);

searchReindexJobSchema.index({ createdAt: -1 });

export const SearchReindexJobModel = mongoose.model<ISearchReindexJob>(
  'SearchReindexJob',
  searchReindexJobSchema
);

