import mongoose, { ClientSession } from 'mongoose';
import { OrderModel, SearchOutboxModel, TransactionModel } from '../models/index.js';
import { OrderStatus, PaymentStatus } from '../types/domain.js';
import { serviceUnavailable } from '../utils/errors.js';
import { PaginatedResult } from './phase2Types.js';

export interface DepositAllocationDto {
  packageId: string;
  allocatedDeposit: number;
  refundedAmount: number;
  pendingRefundAmount: number;
}

export interface TransactionDto {
  id: string;
  orderId: string;
  merchantId: string;
  customerId: string;
  paypalOrderId: string;
  captureId?: string;
  amount: number;
  currency: string;
  state: PaymentStatus;
  depositAllocations: DepositAllocationDto[];
  approvedAt?: Date;
  capturedAt?: Date;
  lastReconciledAt?: Date;
  providerStatus?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TransactionRepository {
  create(
    input: Omit<TransactionDto, 'id' | 'createdAt' | 'updatedAt'>,
    session?: ClientSession | null
  ): Promise<TransactionDto>;
  findById(id: string, session?: ClientSession | null): Promise<TransactionDto | null>;
  findByPayPalOrderId(
    paypalOrderId: string,
    session?: ClientSession | null
  ): Promise<TransactionDto | null>;
  findActiveByOrderId(
    orderId: string,
    session?: ClientSession | null
  ): Promise<TransactionDto | null>;
  findLatestByOrderId(
    orderId: string,
    session?: ClientSession | null
  ): Promise<TransactionDto | null>;
  list(filters: {
    merchantId?: string;
    customerId?: string;
    state?: PaymentStatus;
    page: number;
    pageSize: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  }): Promise<PaginatedResult<TransactionDto>>;
  transitionState(
    transactionId: string,
    fromStates: PaymentStatus[],
    update: {
      state: PaymentStatus;
      captureId?: string;
      approvedAt?: Date;
      capturedAt?: Date;
      lastReconciledAt?: Date;
      providerStatus?: string;
    },
    session?: ClientSession | null
  ): Promise<TransactionDto | null>;
  updateOrderPaymentStatus(
    orderId: string,
    nextStatus: OrderStatus,
    session?: ClientSession | null
  ): Promise<void>;
  listPendingCapturesOlderThan?(cutoffDate: Date, limit?: number): Promise<TransactionDto[]>;
}

function ensureDbReady(): void {
  if (mongoose.connection.readyState !== 1) {
    throw serviceUnavailable('Database connection is not active. Configure MONGODB_URI.');
  }
}

function mapTransaction(doc: any): TransactionDto {
  return {
    id: doc._id.toString(),
    orderId: doc.orderId.toString(),
    merchantId: doc.merchantId.toString(),
    customerId: doc.customerId.toString(),
    paypalOrderId: doc.paypalOrderId,
    captureId: doc.captureId,
    amount: doc.amount,
    currency: doc.currency,
    state: doc.state,
    depositAllocations: (doc.depositAllocations ?? []).map((a: any) => ({
      packageId: a.packageId,
      allocatedDeposit: a.allocatedDeposit,
      refundedAmount: a.refundedAmount ?? 0,
      pendingRefundAmount: a.pendingRefundAmount ?? 0,
    })),
    approvedAt: doc.approvedAt,
    capturedAt: doc.capturedAt,
    lastReconciledAt: doc.lastReconciledAt,
    providerStatus: doc.providerStatus,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export class MongooseTransactionRepository implements TransactionRepository {
  async create(
    input: Omit<TransactionDto, 'id' | 'createdAt' | 'updatedAt'>,
    session?: ClientSession | null
  ): Promise<TransactionDto> {
    ensureDbReady();
    const [doc] = await TransactionModel.create(
      [
        {
          ...input,
          orderId: new mongoose.Types.ObjectId(input.orderId),
          merchantId: new mongoose.Types.ObjectId(input.merchantId),
          customerId: new mongoose.Types.ObjectId(input.customerId),
        },
      ],
      { session: session ?? undefined }
    );

    await SearchOutboxModel.create(
      [
        {
          entityType: 'payment',
          entityId: doc._id.toString(),
          operation: 'UPSERT',
          status: 'PENDING',
        },
      ],
      { session: session ?? undefined }
    );

    return mapTransaction(doc);
  }

  async findById(id: string, session?: ClientSession | null): Promise<TransactionDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const doc = await TransactionModel.findById(id)
      .session(session ?? null)
      .lean();
    return doc ? mapTransaction(doc) : null;
  }

  async findLatestByOrderId(
    orderId: string,
    session?: ClientSession | null
  ): Promise<TransactionDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(orderId)) return null;
    const doc = await TransactionModel.findOne({
      orderId: new mongoose.Types.ObjectId(orderId),
    })
      .sort({ createdAt: -1 })
      .session(session ?? null)
      .lean();
    return doc ? mapTransaction(doc) : null;
  }

  async findByPayPalOrderId(
    paypalOrderId: string,
    session?: ClientSession | null
  ): Promise<TransactionDto | null> {
    ensureDbReady();
    const doc = await TransactionModel.findOne({ paypalOrderId: paypalOrderId.trim() })
      .session(session ?? null)
      .lean();
    return doc ? mapTransaction(doc) : null;
  }

  async findActiveByOrderId(
    orderId: string,
    session?: ClientSession | null
  ): Promise<TransactionDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(orderId)) return null;
    const doc = await TransactionModel.findOne({
      orderId: new mongoose.Types.ObjectId(orderId),
      state: {
        $in: [
          'CREATED',
          'APPROVED',
          'CAPTURE_PENDING',
          'CAPTURED',
          'REFUND_REQUESTED',
          'REFUND_PENDING',
          'PARTIALLY_REFUNDED',
          'REFUNDED',
        ],
      },
    })
      .sort({ createdAt: -1 })
      .session(session ?? null)
      .lean();
    return doc ? mapTransaction(doc) : null;
  }

  async list(filters: {
    merchantId?: string;
    customerId?: string;
    state?: PaymentStatus;
    page: number;
    pageSize: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  }): Promise<PaginatedResult<TransactionDto>> {
    ensureDbReady();
    const query: Record<string, unknown> = {};
    if (filters.merchantId) query.merchantId = new mongoose.Types.ObjectId(filters.merchantId);
    if (filters.customerId) query.customerId = new mongoose.Types.ObjectId(filters.customerId);
    if (filters.state) query.state = filters.state;

    const allowedSort: Record<string, string> = {
      amount: 'amount',
      state: 'state',
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
    };
    const sortField = (filters.sortBy && allowedSort[filters.sortBy]) || 'updatedAt';
    const sortVal = filters.sortDir === 'asc' ? 1 : -1;

    const [docs, total] = await Promise.all([
      TransactionModel.find(query)
        .sort({ [sortField]: sortVal })
        .skip((filters.page - 1) * filters.pageSize)
        .limit(filters.pageSize)
        .lean(),
      TransactionModel.countDocuments(query),
    ]);

    return {
      items: docs.map(mapTransaction),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async transitionState(
    transactionId: string,
    fromStates: PaymentStatus[],
    update: {
      state: PaymentStatus;
      captureId?: string;
      approvedAt?: Date;
      capturedAt?: Date;
      lastReconciledAt?: Date;
      providerStatus?: string;
    },
    session?: ClientSession | null
  ): Promise<TransactionDto | null> {
    ensureDbReady();
    const doc = await TransactionModel.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(transactionId),
        state: { $in: fromStates },
      },
      { $set: update },
      { new: true, session: session ?? undefined }
    ).lean();

    if (doc) {
      await SearchOutboxModel.create(
        [
          {
            entityType: 'payment',
            entityId: doc._id.toString(),
            operation: 'UPSERT',
            status: 'PENDING',
          },
        ],
        { session: session ?? undefined }
      );
    }

    return doc ? mapTransaction(doc) : null;
  }

  async updateOrderPaymentStatus(
    orderId: string,
    nextStatus: OrderStatus,
    session?: ClientSession | null
  ): Promise<void> {
    ensureDbReady();
    await OrderModel.updateOne(
      { _id: new mongoose.Types.ObjectId(orderId) },
      { $set: { status: nextStatus } },
      { session: session ?? undefined }
    );
  }

  async listPendingCapturesOlderThan(cutoffDate: Date, limit = 50): Promise<TransactionDto[]> {
    ensureDbReady();
    const docs = await TransactionModel.find({
      state: 'CAPTURE_PENDING',
      updatedAt: { $lte: cutoffDate },
    })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .lean();
    return docs.map(mapTransaction);
  }
}
