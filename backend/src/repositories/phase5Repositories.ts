import crypto from 'node:crypto';
import mongoose, { ClientSession } from 'mongoose';
import {
  OrderModel,
  PackageEventModel,
  PackageModel,
  PickupModel,
  RefundModel,
  ReturnModel,
  TransactionModel,
  WebhookEventModel,
} from '../models/index.js';
import { enqueueSearchOutbox } from './outboxHelper.js';
import {
  InspectionCondition,
  OrderStatus,
  PackageStatus,
  PaymentStatus,
  ReturnMode,
  ReturnStatus,
  UserRole,
} from '../types/domain.js';
import { serviceUnavailable } from '../utils/errors.js';
import {
  mapPackageDto,
  OrderDto,
  PackageDto,
  PaginatedResult,
} from './phase2Repositories.js';
import { DepositAllocationDto, TransactionDto } from './phase3Repositories.js';
import { CreatePackageEventInput } from './phase4Repositories.js';

export interface ReturnDto {
  id: string;
  returnNumber: string;
  orderId: string;
  orderNumber?: string;
  packageRef: string;
  packageId: string;
  merchantId: string;
  customerId: string;
  mode: ReturnMode;
  returnMethodDetails?: {
    dropoffLocationLabel?: string;
    pickupWindowStart?: Date;
    pickupWindowEnd?: Date;
    serviceZone?: string;
    addressSummary?: string;
    swapOrderNumber?: string;
  };
  pickupId?: string;
  collectionCenterId?: string;
  assignedPartnerUserId?: string;
  assignedPartnerName?: string;
  status: ReturnStatus;
  reason?: string;
  returnDeadlineAt?: Date;
  isLateReturn: boolean;
  daysLate: number;
  disputed: boolean;
  disputeReason?: string;
  collectedAt?: Date;
  receivedAt?: Date;
  receivedBy?: string;
  evidenceFiles: Array<{
    fileId: string;
    filename: string;
    mimeType: string;
    sizeBytes?: number;
    uploadedAt: Date;
    uploadedBy: string;
  }>;
  inspection?: {
    inspectorId: string;
    inspectedAt: Date;
    checklist: {
      identityVerified: boolean;
      structuralIntegrity: boolean;
      cleanlinessAcceptable: boolean;
      completeComponents: boolean;
    };
    condition: InspectionCondition;
    outcome: 'PASS' | 'FAIL' | 'NEEDS_REVIEW';
    damageReason?: string;
    notes?: string;
  };
  decision?: {
    decidedBy: string;
    decidedAt: Date;
    outcome: 'APPROVED' | 'REJECTED' | 'NEEDS_REVIEW';
    reason: string;
  };
  refundEligibility: {
    eligible: boolean;
    reason?: string;
    originalDeposit: number;
    totalDeductions: number;
    calculatedAmount: number;
    currency: string;
    ruleVersion?: string;
    deductionBreakdown: Array<{
      code: string;
      label: string;
      amount: number;
      reason: string;
    }>;
  };
  refundId?: string;
  refundSummary?: {
    refundId: string;
    state: PaymentStatus;
    amount: number;
    providerRefundId?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface RefundDto {
  id: string;
  transactionId: string;
  orderId: string;
  returnId: string;
  merchantId: string;
  packageId: string;
  captureId: string;
  paypalRequestId: string;
  providerRefundId?: string;
  providerStatus?: string;
  failureReason?: string;
  amount: number;
  currency: string;
  reason: string;
  state: PaymentStatus;
  idempotencyKey: string;
  initiatedBy: string;
  lastReconciledAt?: Date;
  confirmedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookEventDto {
  id: string;
  provider: 'PAYPAL';
  providerEventId: string;
  eventType: string;
  resourceId?: string;
  payloadSummary: Record<string, unknown>;
  resourceSnapshot?: Record<string, unknown>;
  verificationResult: 'VERIFIED' | 'FAILED' | 'PENDING';
  processingState: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED';
  retryCount?: number;
  nextRetryAt?: Date;
  error?: string;
  receivedAt: Date;
  processedAt?: Date;
}

export interface ReturnRepository {
  createReturnWithPackageAtomically(
    params: {
      returnDoc: Omit<ReturnDto, 'id' | 'createdAt' | 'updatedAt'>;
      expectedPackageStatus: PackageStatus;
      nextPackageStatus: PackageStatus;
      pickupRequest?: {
        serviceZone: string;
        addressSummary: string;
        slotStart: Date;
        slotEnd: Date;
      };
      event: CreatePackageEventInput;
    },
    session?: ClientSession | null
  ): Promise<{ returnRecord: ReturnDto; package: PackageDto } | null>;
  findById(id: string, session?: ClientSession | null): Promise<ReturnDto | null>;
  findByReturnNumber(
    returnNumber: string,
    session?: ClientSession | null
  ): Promise<ReturnDto | null>;
  findByOrderAndPackage(
    orderId: string,
    packageId: string,
    session?: ClientSession | null
  ): Promise<ReturnDto | null>;
  findActiveByPackageId(packageId: string, session?: ClientSession | null): Promise<ReturnDto | null>;
  list(filters: {
    merchantId?: string;
    customerId?: string;
    assignedPartnerUserId?: string;
    status?: ReturnStatus;
    mode?: ReturnMode;
    condition?: InspectionCondition;
    refundStatus?: PaymentStatus;
    search?: string;
    page: number;
    pageSize: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  }): Promise<PaginatedResult<ReturnDto>>;
  transitionReturnAndPackageAtomically(
    params: {
      returnId: string;
      expectedReturnStatuses: ReturnStatus[];
      returnSet: Record<string, unknown>;
      packageUpdate?: {
        packageId: string;
        expectedStatuses: PackageStatus[];
        nextStatus: PackageStatus;
        newCustodian?: PackageDto['currentCustodian'];
        lastInspectionAt?: Date;
        lastInspectionOutcome?: 'PASS' | 'FAIL' | 'NEEDS_REVIEW';
      };
      event?: CreatePackageEventInput;
    },
    session?: ClientSession | null
  ): Promise<{ returnRecord: ReturnDto; package?: PackageDto } | null>;
  appendEvidenceFile(
    returnId: string,
    file: ReturnDto['evidenceFiles'][number],
    event?: CreatePackageEventInput,
    session?: ClientSession | null
  ): Promise<ReturnDto | null>;
}

export interface RefundRepository {
  findById(id: string, session?: ClientSession | null): Promise<RefundDto | null>;
  findByReturnId(returnId: string, session?: ClientSession | null): Promise<RefundDto | null>;
  findByProviderRefundId(
    providerRefundId: string,
    session?: ClientSession | null
  ): Promise<RefundDto | null>;
  findByIdempotencyKey(
    idempotencyKey: string,
    session?: ClientSession | null
  ): Promise<RefundDto | null>;
  listByTransactionId(
    transactionId: string,
    session?: ClientSession | null
  ): Promise<RefundDto[]>;
  listPendingOlderThan(cutoffDate: Date, limit?: number): Promise<RefundDto[]>;
  reserveRefundAndApproveReturnAtomically(
    params: {
      transactionId: string;
      packageId: string;
      expectedTxStates: PaymentStatus[];
      refundInput: Omit<RefundDto, 'id' | 'createdAt' | 'updatedAt'>;
      returnUpdate: {
        returnId: string;
        expectedReturnStatuses: ReturnStatus[];
        decision: NonNullable<ReturnDto['decision']>;
        eligibilityOverride?: ReturnDto['refundEligibility'];
      };
      event?: CreatePackageEventInput;
    },
    session?: ClientSession | null
  ): Promise<{ refund: RefundDto; transaction: TransactionDto; returnRecord: ReturnDto } | null>;
  markRefundPendingProvider(
    params: {
      refundId: string;
      providerRefundId?: string;
      providerStatus?: string;
      txState?: PaymentStatus;
      lastReconciledAt: Date;
    },
    session?: ClientSession | null
  ): Promise<RefundDto | null>;
  finalizeRefundCompletedAtomically(
    params: {
      refundId: string;
      providerRefundId: string;
      providerStatus: string;
      confirmedAt: Date;
      event?: CreatePackageEventInput;
    },
    session?: ClientSession | null
  ): Promise<{ refund: RefundDto; transaction: TransactionDto; returnRecord?: ReturnDto } | null>;
  failRefundAndReleaseReservationAtomically(
    params: {
      refundId: string;
      failureReason: string;
      providerStatus?: string;
      event?: CreatePackageEventInput;
    },
    session?: ClientSession | null
  ): Promise<{ refund: RefundDto; transaction: TransactionDto } | null>;
  retryFailedRefundReservationAtomically(
    params: {
      refundId: string;
      newPayPalRequestId: string;
    },
    session?: ClientSession | null
  ): Promise<{ refund: RefundDto; transaction: TransactionDto } | null>;
}

export interface WebhookEventRepository {
  findByProviderEventId(providerEventId: string): Promise<WebhookEventDto | null>;
  createUnique(input: {
    provider: 'PAYPAL';
    providerEventId: string;
    eventType: string;
    resourceId?: string;
    payloadSummary: Record<string, unknown>;
    resourceSnapshot?: Record<string, unknown>;
    verificationResult: 'VERIFIED' | 'FAILED' | 'PENDING';
    processingState: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED';
    error?: string;
  }): Promise<{ created: boolean; record: WebhookEventDto }>;
  updateProcessingState(
    providerEventId: string,
    update: {
      processingState: 'PROCESSED' | 'IGNORED' | 'FAILED';
      error?: string;
      processedAt?: Date;
      retryCount?: number;
      nextRetryAt?: Date | null;
    }
  ): Promise<WebhookEventDto | null>;
  listRetryableFailed?(now: Date, maxRetries: number, limit?: number): Promise<WebhookEventDto[]>;
}

function ensureDbReady(): void {
  if (mongoose.connection.readyState !== 1) {
    throw serviceUnavailable('Database connection is not active. Configure MONGODB_URI.');
  }
}

function toObjId(id: string | undefined): mongoose.Types.ObjectId | undefined {
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return undefined;
  return new mongoose.Types.ObjectId(id);
}

function mapTransactionLocal(doc: any): TransactionDto {
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

function mapReturn(doc: any): ReturnDto {
  return {
    id: doc._id.toString(),
    returnNumber: doc.returnNumber,
    orderId: doc.orderId.toString(),
    packageRef: doc.packageRef.toString(),
    packageId: doc.packageId,
    merchantId: doc.merchantId.toString(),
    customerId: doc.customerId.toString(),
    mode: doc.mode,
    returnMethodDetails: doc.returnMethodDetails,
    pickupId: doc.pickupId ? doc.pickupId.toString() : undefined,
    collectionCenterId: doc.collectionCenterId ? doc.collectionCenterId.toString() : undefined,
    assignedPartnerUserId: doc.assignedPartnerUserId
      ? doc.assignedPartnerUserId.toString()
      : undefined,
    assignedPartnerName: doc.assignedPartnerName,
    status: doc.status,
    reason: doc.reason,
    returnDeadlineAt: doc.returnDeadlineAt,
    isLateReturn: Boolean(doc.isLateReturn),
    daysLate: doc.daysLate ?? 0,
    disputed: Boolean(doc.disputed),
    disputeReason: doc.disputeReason,
    collectedAt: doc.collectedAt,
    receivedAt: doc.receivedAt,
    receivedBy: doc.receivedBy ? doc.receivedBy.toString() : undefined,
    evidenceFiles: (doc.evidenceFiles ?? []).map((f: any) => ({
      fileId: f.fileId,
      filename: f.filename,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      uploadedAt: f.uploadedAt,
      uploadedBy: f.uploadedBy.toString(),
    })),
    inspection: doc.inspection?.inspectedAt
      ? {
          inspectorId: doc.inspection.inspectorId.toString(),
          inspectedAt: doc.inspection.inspectedAt,
          checklist: doc.inspection.checklist,
          condition: doc.inspection.condition,
          outcome: doc.inspection.outcome,
          damageReason: doc.inspection.damageReason,
          notes: doc.inspection.notes,
        }
      : undefined,
    decision: doc.decision?.decidedAt
      ? {
          decidedBy: doc.decision.decidedBy.toString(),
          decidedAt: doc.decision.decidedAt,
          outcome: doc.decision.outcome,
          reason: doc.decision.reason,
        }
      : undefined,
    refundEligibility: {
      eligible: Boolean(doc.refundEligibility?.eligible),
      reason: doc.refundEligibility?.reason,
      originalDeposit: doc.refundEligibility?.originalDeposit ?? 0,
      totalDeductions: doc.refundEligibility?.totalDeductions ?? 0,
      calculatedAmount: doc.refundEligibility?.calculatedAmount ?? 0,
      currency: doc.refundEligibility?.currency ?? 'USD',
      ruleVersion: doc.refundEligibility?.ruleVersion,
      deductionBreakdown: doc.refundEligibility?.deductionBreakdown ?? [],
    },
    refundId: doc.refundId ? doc.refundId.toString() : undefined,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function mapRefund(doc: any): RefundDto {
  return {
    id: doc._id.toString(),
    transactionId: doc.transactionId.toString(),
    orderId: doc.orderId.toString(),
    returnId: doc.returnId.toString(),
    merchantId: doc.merchantId.toString(),
    packageId: doc.packageId,
    captureId: doc.captureId,
    paypalRequestId: doc.paypalRequestId,
    providerRefundId: doc.providerRefundId,
    providerStatus: doc.providerStatus,
    failureReason: doc.failureReason,
    amount: doc.amount,
    currency: doc.currency,
    reason: doc.reason,
    state: doc.state,
    idempotencyKey: doc.idempotencyKey,
    initiatedBy: doc.initiatedBy.toString(),
    lastReconciledAt: doc.lastReconciledAt,
    confirmedAt: doc.confirmedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function mapWebhook(doc: any): WebhookEventDto {
  return {
    id: doc._id.toString(),
    provider: 'PAYPAL',
    providerEventId: doc.providerEventId,
    eventType: doc.eventType,
    resourceId: doc.resourceId,
    payloadSummary: doc.payloadSummary ?? {},
    resourceSnapshot: doc.resourceSnapshot,
    verificationResult: doc.verificationResult,
    processingState: doc.processingState,
    retryCount: doc.retryCount ?? 0,
    nextRetryAt: doc.nextRetryAt,
    error: doc.error,
    receivedAt: doc.receivedAt,
    processedAt: doc.processedAt,
  };
}

async function appendEventAndOutbox(
  event: CreatePackageEventInput,
  extraOutbox: Array<{ entityType: 'passport' | 'package_event' | 'return' | 'payment'; entityId: string }>,
  session?: ClientSession | null
): Promise<void> {
  const eventId = event.eventId ?? `evt_${crypto.randomUUID()}`;
  const merchantObjId = toObjId(event.merchantId);

  await PackageEventModel.create(
    [
      {
        eventId,
        packageId: event.packageId.trim().toUpperCase(),
        ...(merchantObjId ? { merchantId: merchantObjId } : {}),
        ...(event.scanId?.trim() ? { scanId: event.scanId.trim() } : {}),
        type: event.type,
        actor: event.actor,
        occurredAt: event.occurredAt ?? new Date(),
        sourceSystem: event.sourceSystem ?? 'REBOXIFY_API',
        correlationId: event.correlationId,
        locationRef: event.locationRef,
        outcome: event.outcome,
        evidence: event.evidence ?? [],
        metadata: event.metadata,
      },
    ],
    { session: session ?? undefined }
  );

  const outboxEntries = [
    { entityType: 'package_event' as const, entityId: eventId },
    ...extraOutbox,
  ];
  await enqueueSearchOutbox(outboxEntries, session);
}

export class MongooseReturnRepository implements ReturnRepository {
  async createReturnWithPackageAtomically(
    params: {
      returnDoc: Omit<ReturnDto, 'id' | 'createdAt' | 'updatedAt'>;
      expectedPackageStatus: PackageStatus;
      nextPackageStatus: PackageStatus;
      pickupRequest?: {
        serviceZone: string;
        addressSummary: string;
        slotStart: Date;
        slotEnd: Date;
      };
      event: CreatePackageEventInput;
    },
    session?: ClientSession | null
  ): Promise<{ returnRecord: ReturnDto; package: PackageDto } | null> {
    ensureDbReady();
    const updatedPkg = await PackageModel.findOneAndUpdate(
      {
        packageId: params.returnDoc.packageId.trim().toUpperCase(),
        status: params.expectedPackageStatus,
      },
      { $set: { status: params.nextPackageStatus } },
      { new: true, session: session ?? undefined }
    ).lean();

    if (!updatedPkg) {
      return null;
    }

    const r = params.returnDoc;
    const [createdReturn] = await ReturnModel.create(
      [
        {
          ...r,
          orderId: new mongoose.Types.ObjectId(r.orderId),
          packageRef: new mongoose.Types.ObjectId(r.packageRef),
          merchantId: new mongoose.Types.ObjectId(r.merchantId),
          customerId: new mongoose.Types.ObjectId(r.customerId),
          ...(r.collectionCenterId ? { collectionCenterId: toObjId(r.collectionCenterId) } : {}),
          ...(r.assignedPartnerUserId
            ? { assignedPartnerUserId: toObjId(r.assignedPartnerUserId) }
            : {}),
        },
      ],
      { session: session ?? undefined }
    );

    if (params.pickupRequest) {
      const [createdPickup] = await PickupModel.create(
        [
          {
            returnId: createdReturn._id,
            orderId: new mongoose.Types.ObjectId(r.orderId),
            packageId: updatedPkg.packageId,
            merchantId: new mongoose.Types.ObjectId(r.merchantId),
            customerId: new mongoose.Types.ObjectId(r.customerId),
            ...(r.collectionCenterId ? { collectionCenterId: toObjId(r.collectionCenterId) } : {}),
            slotStart: params.pickupRequest.slotStart,
            slotEnd: params.pickupRequest.slotEnd,
            pickupMethod: r.mode === 'NEXT_DELIVERY_SWAP' ? 'NEXT_DELIVERY_SWAP' : 'PICKUP',
            serviceZone: params.pickupRequest.serviceZone,
            addressSummary: params.pickupRequest.addressSummary,
            status: 'UNASSIGNED',
            createdBy: new mongoose.Types.ObjectId(r.customerId),
            version: 1,
          },
        ],
        { session: session ?? undefined }
      );
      createdReturn.pickupId = createdPickup._id as mongoose.Types.ObjectId;
      await createdReturn.save({ session: session ?? undefined });
    }

    await appendEventAndOutbox(
      params.event,
      [
        { entityType: 'return', entityId: createdReturn._id.toString() },
        { entityType: 'passport', entityId: updatedPkg.packageId },
      ],
      session
    );

    return {
      returnRecord: mapReturn(createdReturn.toObject()),
      package: mapPackageDto(updatedPkg),
    };
  }

  async findById(id: string, session?: ClientSession | null): Promise<ReturnDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const doc = await ReturnModel.findById(id)
      .session(session ?? null)
      .lean();
    return doc ? mapReturn(doc) : null;
  }

  async findByReturnNumber(
    returnNumber: string,
    session?: ClientSession | null
  ): Promise<ReturnDto | null> {
    ensureDbReady();
    const doc = await ReturnModel.findOne({ returnNumber: returnNumber.trim().toUpperCase() })
      .session(session ?? null)
      .lean();
    return doc ? mapReturn(doc) : null;
  }

  async findByOrderAndPackage(
    orderId: string,
    packageId: string,
    session?: ClientSession | null
  ): Promise<ReturnDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(orderId)) return null;
    const doc = await ReturnModel.findOne({
      orderId: new mongoose.Types.ObjectId(orderId),
      packageId: packageId.trim().toUpperCase(),
    })
      .session(session ?? null)
      .lean();
    return doc ? mapReturn(doc) : null;
  }

  async findActiveByPackageId(
    packageId: string,
    session?: ClientSession | null
  ): Promise<ReturnDto | null> {
    ensureDbReady();
    const doc = await ReturnModel.findOne({
      packageId: packageId.trim().toUpperCase(),
      status: { $nin: ['CLOSED', 'REJECTED'] },
    })
      .sort({ createdAt: -1 })
      .session(session ?? null)
      .lean();
    return doc ? mapReturn(doc) : null;
  }

  async list(filters: {
    merchantId?: string;
    customerId?: string;
    assignedPartnerUserId?: string;
    status?: ReturnStatus;
    mode?: ReturnMode;
    condition?: InspectionCondition;
    refundStatus?: PaymentStatus;
    search?: string;
    page: number;
    pageSize: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  }): Promise<PaginatedResult<ReturnDto>> {
    ensureDbReady();
    const query: Record<string, unknown> = {};
    if (filters.merchantId && mongoose.Types.ObjectId.isValid(filters.merchantId)) {
      query.merchantId = new mongoose.Types.ObjectId(filters.merchantId);
    }
    if (filters.customerId && mongoose.Types.ObjectId.isValid(filters.customerId)) {
      query.customerId = new mongoose.Types.ObjectId(filters.customerId);
    }
    if (
      filters.assignedPartnerUserId &&
      mongoose.Types.ObjectId.isValid(filters.assignedPartnerUserId)
    ) {
      query.assignedPartnerUserId = new mongoose.Types.ObjectId(filters.assignedPartnerUserId);
    }
    if (filters.status) query.status = filters.status;
    if (filters.mode) query.mode = filters.mode;
    if (filters.condition) query['inspection.condition'] = filters.condition;
    if (filters.refundStatus) {
      const matchingRefunds = await RefundModel.find({ state: filters.refundStatus })
        .select('returnId')
        .lean();
      const returnIds = matchingRefunds.map((rf: any) => rf.returnId);
      query._id = { $in: returnIds };
    }
    if (filters.search?.trim()) {
      const escaped = filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matchingOrders = await OrderModel.find({
        orderNumber: { $regex: escaped, $options: 'i' },
      })
        .select('_id')
        .limit(50)
        .lean();
      const orderIds = matchingOrders.map((o: any) => o._id);
      query.$or = [
        { returnNumber: { $regex: escaped, $options: 'i' } },
        { packageId: { $regex: escaped, $options: 'i' } },
        { reason: { $regex: escaped, $options: 'i' } },
        { assignedPartnerName: { $regex: escaped, $options: 'i' } },
        ...(orderIds.length > 0 ? [{ orderId: { $in: orderIds } }] : []),
      ];
    }

    const allowedSort: Record<string, string> = {
      returnNumber: 'returnNumber',
      status: 'status',
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
    };
    const sortField = (filters.sortBy && allowedSort[filters.sortBy]) || 'updatedAt';
    const sortVal = filters.sortDir === 'asc' ? 1 : -1;

    const [docs, total] = await Promise.all([
      ReturnModel.find(query)
        .sort({ [sortField]: sortVal })
        .skip((filters.page - 1) * filters.pageSize)
        .limit(filters.pageSize)
        .lean(),
      ReturnModel.countDocuments(query),
    ]);

    const items = docs.map(mapReturn);
    if (items.length > 0) {
      const orderObjectIds = Array.from(new Set(items.map((r) => r.orderId))).map(
        (id) => new mongoose.Types.ObjectId(id)
      );
      const returnObjectIds = items.map((r) => new mongoose.Types.ObjectId(r.id));
      const [orders, refunds] = await Promise.all([
        OrderModel.find({ _id: { $in: orderObjectIds } })
          .select('_id orderNumber')
          .lean(),
        RefundModel.find({ returnId: { $in: returnObjectIds } })
          .select('_id returnId state amount providerRefundId')
          .lean(),
      ]);

      const orderMap = new Map<string, string>(
        orders.map((o: any) => [o._id.toString(), o.orderNumber as string])
      );
      const refundMap = new Map<string, any>(
        refunds.map((rf: any) => [rf.returnId.toString(), rf])
      );

      for (const ret of items) {
        ret.orderNumber = orderMap.get(ret.orderId);
        const rf = refundMap.get(ret.id);
        if (rf) {
          ret.refundSummary = {
            refundId: rf._id.toString(),
            state: rf.state,
            amount: rf.amount,
            providerRefundId: rf.providerRefundId,
          };
        }
      }
    }

    return {
      items,
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async transitionReturnAndPackageAtomically(
    params: {
      returnId: string;
      expectedReturnStatuses: ReturnStatus[];
      returnSet: Record<string, unknown>;
      packageUpdate?: {
        packageId: string;
        expectedStatuses: PackageStatus[];
        nextStatus: PackageStatus;
        newCustodian?: PackageDto['currentCustodian'];
        lastInspectionAt?: Date;
        lastInspectionOutcome?: 'PASS' | 'FAIL' | 'NEEDS_REVIEW';
      };
      event?: CreatePackageEventInput;
    },
    session?: ClientSession | null
  ): Promise<{ returnRecord: ReturnDto; package?: PackageDto } | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(params.returnId)) return null;

    const updatedReturn = await ReturnModel.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(params.returnId),
        status: { $in: params.expectedReturnStatuses },
      },
      { $set: params.returnSet },
      { new: true, session: session ?? undefined }
    ).lean();

    if (!updatedReturn) {
      return null;
    }

    let updatedPackage: PackageDto | undefined;
    if (params.packageUpdate) {
      const pkgSet: Record<string, unknown> = {
        status: params.packageUpdate.nextStatus,
      };
      if (params.packageUpdate.newCustodian) {
        pkgSet.currentCustodian = params.packageUpdate.newCustodian;
      }
      if (params.packageUpdate.lastInspectionAt) {
        pkgSet.lastInspectionAt = params.packageUpdate.lastInspectionAt;
      }
      if (params.packageUpdate.lastInspectionOutcome) {
        pkgSet.lastInspectionOutcome = params.packageUpdate.lastInspectionOutcome;
      }

      const pkgDoc = await PackageModel.findOneAndUpdate(
        {
          packageId: params.packageUpdate.packageId.trim().toUpperCase(),
          status: { $in: params.packageUpdate.expectedStatuses },
        },
        { $set: pkgSet },
        { new: true, session: session ?? undefined }
      ).lean();

      if (pkgDoc) {
        updatedPackage = mapPackageDto(pkgDoc);
      }
    }

    if (updatedReturn.pickupId) {
      const pickupFilter: Record<string, unknown> = { _id: updatedReturn.pickupId };
      if (params.returnSet.status === 'COLLECTED' || params.returnSet.status === 'RECEIVED') {
        await PickupModel.updateOne(
          { ...pickupFilter, status: { $nin: ['COMPLETED', 'CANCELLED'] } },
          { $set: { status: 'COMPLETED' }, $inc: { version: 1 } },
          { session: session ?? undefined }
        );
      } else if (typeof params.returnSet.assignedPartnerUserId === 'string') {
        await PickupModel.updateOne(
          { ...pickupFilter, status: { $in: ['UNASSIGNED', 'ASSIGNED', 'RESCHEDULED'] } },
          {
            $set: {
              partnerId: toObjId(params.returnSet.assignedPartnerUserId),
              ...(typeof params.returnSet.assignedPartnerName === 'string'
                ? { assignedPartnerName: params.returnSet.assignedPartnerName }
                : {}),
              status: 'ASSIGNED',
            },
            $inc: { version: 1 },
          },
          { session: session ?? undefined }
        );
      }
    }

    if (params.event) {
      const extra: Array<{ entityType: 'passport' | 'return'; entityId: string }> = [
        { entityType: 'return', entityId: updatedReturn._id.toString() },
      ];
      if (updatedPackage) {
        extra.push({ entityType: 'passport', entityId: updatedPackage.packageId });
      }
      await appendEventAndOutbox(params.event, extra, session);
    } else {
      await enqueueSearchOutbox(
        [{ entityType: 'return', entityId: updatedReturn._id.toString() }],
        session
      );
    }

    return {
      returnRecord: mapReturn(updatedReturn),
      package: updatedPackage,
    };
  }

  async appendEvidenceFile(
    returnId: string,
    file: ReturnDto['evidenceFiles'][number],
    event?: CreatePackageEventInput,
    session?: ClientSession | null
  ): Promise<ReturnDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(returnId)) return null;
    const updated = await ReturnModel.findByIdAndUpdate(
      returnId,
      {
        $push: {
          evidenceFiles: {
            ...file,
            uploadedBy: new mongoose.Types.ObjectId(file.uploadedBy),
          },
        },
      },
      { new: true, session: session ?? undefined }
    ).lean();
    if (!updated) return null;

    if (event) {
      await appendEventAndOutbox(
        event,
        [{ entityType: 'return', entityId: updated._id.toString() }],
        session
      );
    }
    return mapReturn(updated);
  }
}

export class MongooseRefundRepository implements RefundRepository {
  async findById(id: string, session?: ClientSession | null): Promise<RefundDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const doc = await RefundModel.findById(id)
      .session(session ?? null)
      .lean();
    return doc ? mapRefund(doc) : null;
  }

  async findByReturnId(returnId: string, session?: ClientSession | null): Promise<RefundDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(returnId)) return null;
    const doc = await RefundModel.findOne({ returnId: new mongoose.Types.ObjectId(returnId) })
      .sort({ createdAt: -1 })
      .session(session ?? null)
      .lean();
    return doc ? mapRefund(doc) : null;
  }

  async findByProviderRefundId(
    providerRefundId: string,
    session?: ClientSession | null
  ): Promise<RefundDto | null> {
    ensureDbReady();
    const doc = await RefundModel.findOne({ providerRefundId: providerRefundId.trim() })
      .session(session ?? null)
      .lean();
    return doc ? mapRefund(doc) : null;
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
    session?: ClientSession | null
  ): Promise<RefundDto | null> {
    ensureDbReady();
    const doc = await RefundModel.findOne({ idempotencyKey })
      .session(session ?? null)
      .lean();
    return doc ? mapRefund(doc) : null;
  }

  async listByTransactionId(
    transactionId: string,
    session?: ClientSession | null
  ): Promise<RefundDto[]> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(transactionId)) return [];
    const docs = await RefundModel.find({
      transactionId: new mongoose.Types.ObjectId(transactionId),
    })
      .sort({ createdAt: -1 })
      .session(session ?? null)
      .lean();
    return docs.map(mapRefund);
  }

  async listPendingOlderThan(cutoffDate: Date, limit = 50): Promise<RefundDto[]> {
    ensureDbReady();
    const docs = await RefundModel.find({
      state: { $in: ['REFUND_REQUESTED', 'REFUND_PENDING'] },
      updatedAt: { $lte: cutoffDate },
    })
      .limit(limit)
      .lean();
    return docs.map(mapRefund);
  }

  async reserveRefundAndApproveReturnAtomically(
    params: {
      transactionId: string;
      packageId: string;
      expectedTxStates: PaymentStatus[];
      refundInput: Omit<RefundDto, 'id' | 'createdAt' | 'updatedAt'>;
      returnUpdate: {
        returnId: string;
        expectedReturnStatuses: ReturnStatus[];
        decision: NonNullable<ReturnDto['decision']>;
        eligibilityOverride?: ReturnDto['refundEligibility'];
      };
      event?: CreatePackageEventInput;
    },
    session?: ClientSession | null
  ): Promise<{ refund: RefundDto; transaction: TransactionDto; returnRecord: ReturnDto } | null> {
    ensureDbReady();
    const txDoc = await TransactionModel.findOne({
      _id: new mongoose.Types.ObjectId(params.transactionId),
      state: { $in: params.expectedTxStates },
    }).session(session ?? null);

    if (!txDoc) return null;

    const normalizedPkgId = params.packageId.trim().toUpperCase();
    const alloc = txDoc.depositAllocations.find(
      (a) => a.packageId.toUpperCase() === normalizedPkgId
    );
    if (!alloc) return null;

    const remainingPkg = Math.round(
      ((alloc.allocatedDeposit - alloc.refundedAmount - alloc.pendingRefundAmount) + Number.EPSILON) * 100
    ) / 100;
    const totalUsed = txDoc.depositAllocations.reduce(
      (acc, a) => acc + a.refundedAmount + a.pendingRefundAmount,
      0
    );
    const remainingTx = Math.round(((txDoc.amount - totalUsed) + Number.EPSILON) * 100) / 100;

    if (params.refundInput.amount > remainingPkg + 0.001 || params.refundInput.amount > remainingTx + 0.001) {
      return null;
    }

    alloc.pendingRefundAmount =
      Math.round((alloc.pendingRefundAmount + params.refundInput.amount) * 100) / 100;
    txDoc.state = 'REFUND_REQUESTED';
    await txDoc.save({ session: session ?? undefined });

    const rInput = params.refundInput;
    const [refundDoc] = await RefundModel.create(
      [
        {
          ...rInput,
          transactionId: new mongoose.Types.ObjectId(rInput.transactionId),
          orderId: new mongoose.Types.ObjectId(rInput.orderId),
          returnId: new mongoose.Types.ObjectId(rInput.returnId),
          merchantId: new mongoose.Types.ObjectId(rInput.merchantId),
          initiatedBy: new mongoose.Types.ObjectId(rInput.initiatedBy),
          packageId: normalizedPkgId,
        },
      ],
      { session: session ?? undefined }
    );

    const retSet: Record<string, unknown> = {
      status: 'APPROVED',
      decision: {
        decidedBy: new mongoose.Types.ObjectId(params.returnUpdate.decision.decidedBy),
        decidedAt: params.returnUpdate.decision.decidedAt,
        outcome: params.returnUpdate.decision.outcome,
        reason: params.returnUpdate.decision.reason,
      },
      refundId: refundDoc._id,
    };
    if (params.returnUpdate.eligibilityOverride) {
      retSet.refundEligibility = params.returnUpdate.eligibilityOverride;
    }

    const updatedRet = await ReturnModel.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(params.returnUpdate.returnId),
        status: { $in: params.returnUpdate.expectedReturnStatuses },
      },
      { $set: retSet },
      { new: true, session: session ?? undefined }
    ).lean();

    if (!updatedRet) return null;

    if (params.event) {
      await appendEventAndOutbox(
        params.event,
        [
          { entityType: 'return', entityId: updatedRet._id.toString() },
          { entityType: 'payment', entityId: txDoc._id.toString() },
        ],
        session
      );
    }

    return {
      refund: mapRefund(refundDoc.toObject()),
      transaction: mapTransactionLocal(txDoc.toObject()),
      returnRecord: mapReturn(updatedRet),
    };
  }

  async markRefundPendingProvider(
    params: {
      refundId: string;
      providerRefundId?: string;
      providerStatus?: string;
      txState?: PaymentStatus;
      lastReconciledAt: Date;
    },
    session?: ClientSession | null
  ): Promise<RefundDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(params.refundId)) return null;

    const updated = await RefundModel.findByIdAndUpdate(
      params.refundId,
      {
        $set: {
          state: 'REFUND_PENDING',
          ...(params.providerRefundId ? { providerRefundId: params.providerRefundId } : {}),
          ...(params.providerStatus ? { providerStatus: params.providerStatus } : {}),
          lastReconciledAt: params.lastReconciledAt,
        },
      },
      { new: true, session: session ?? undefined }
    ).lean();

    if (!updated) return null;

    await TransactionModel.updateOne(
      {
        _id: updated.transactionId,
        state: { $in: ['CAPTURED', 'REFUND_REQUESTED', 'PARTIALLY_REFUNDED'] },
      },
      { $set: { state: params.txState ?? 'REFUND_PENDING', lastReconciledAt: params.lastReconciledAt } },
      { session: session ?? undefined }
    );

    return mapRefund(updated);
  }

  async finalizeRefundCompletedAtomically(
    params: {
      refundId: string;
      providerRefundId: string;
      providerStatus: string;
      confirmedAt: Date;
      event?: CreatePackageEventInput;
    },
    session?: ClientSession | null
  ): Promise<{ refund: RefundDto; transaction: TransactionDto; returnRecord?: ReturnDto } | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(params.refundId)) return null;

    const updatedRefund = await RefundModel.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(params.refundId),
        state: { $in: ['REFUND_REQUESTED', 'REFUND_PENDING', 'REFUND_FAILED'] },
      },
      {
        $set: {
          state: 'REFUNDED',
          providerRefundId: params.providerRefundId,
          providerStatus: params.providerStatus,
          confirmedAt: params.confirmedAt,
          lastReconciledAt: params.confirmedAt,
        },
      },
      { new: true, session: session ?? undefined }
    ).lean();

    if (!updatedRefund) return null;

    const txDoc = await TransactionModel.findById(updatedRefund.transactionId).session(
      session ?? null
    );
    if (!txDoc) return null;

    const alloc = txDoc.depositAllocations.find(
      (a) => a.packageId.toUpperCase() === updatedRefund.packageId.toUpperCase()
    );
    if (alloc) {
      alloc.pendingRefundAmount = Math.max(
        0,
        Math.round((alloc.pendingRefundAmount - updatedRefund.amount) * 100) / 100
      );
      alloc.refundedAmount =
        Math.round((alloc.refundedAmount + updatedRefund.amount) * 100) / 100;
    }

    const totalConfirmed = txDoc.depositAllocations.reduce((s, a) => s + a.refundedAmount, 0);
    const allDepositsRefunded = txDoc.depositAllocations.every(
      (a) => a.refundedAmount >= a.allocatedDeposit - 0.001
    );
    const fullTxRefunded = totalConfirmed >= txDoc.amount - 0.001;
    txDoc.state = fullTxRefunded ? 'REFUNDED' : allDepositsRefunded ? 'PARTIALLY_REFUNDED' : 'PARTIALLY_REFUNDED';
    txDoc.lastReconciledAt = params.confirmedAt;
    await txDoc.save({ session: session ?? undefined });

    const closedReturn = await ReturnModel.findOneAndUpdate(
      {
        _id: updatedRefund.returnId,
        status: { $in: ['APPROVED', 'UNDER_INSPECTION', 'NEEDS_REVIEW'] },
      },
      { $set: { status: 'CLOSED' } },
      { new: true, session: session ?? undefined }
    ).lean();

    if (params.event) {
      await appendEventAndOutbox(
        params.event,
        [
          { entityType: 'return', entityId: updatedRefund.returnId.toString() },
          { entityType: 'payment', entityId: txDoc._id.toString() },
        ],
        session
      );
    }

    return {
      refund: mapRefund(updatedRefund),
      transaction: mapTransactionLocal(txDoc.toObject()),
      returnRecord: closedReturn ? mapReturn(closedReturn) : undefined,
    };
  }

  async failRefundAndReleaseReservationAtomically(
    params: {
      refundId: string;
      failureReason: string;
      providerStatus?: string;
      event?: CreatePackageEventInput;
    },
    session?: ClientSession | null
  ): Promise<{ refund: RefundDto; transaction: TransactionDto } | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(params.refundId)) return null;

    const updatedRefund = await RefundModel.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(params.refundId),
        state: { $in: ['REFUND_REQUESTED', 'REFUND_PENDING'] },
      },
      {
        $set: {
          state: 'REFUND_FAILED',
          failureReason: params.failureReason,
          ...(params.providerStatus ? { providerStatus: params.providerStatus } : {}),
          lastReconciledAt: new Date(),
        },
      },
      { new: true, session: session ?? undefined }
    ).lean();

    if (!updatedRefund) return null;

    const txDoc = await TransactionModel.findById(updatedRefund.transactionId).session(
      session ?? null
    );
    if (!txDoc) return null;

    const alloc = txDoc.depositAllocations.find(
      (a) => a.packageId.toUpperCase() === updatedRefund.packageId.toUpperCase()
    );
    if (alloc) {
      alloc.pendingRefundAmount = Math.max(
        0,
        Math.round((alloc.pendingRefundAmount - updatedRefund.amount) * 100) / 100
      );
    }

    const totalConfirmed = txDoc.depositAllocations.reduce((s, a) => s + a.refundedAmount, 0);
    const totalPending = txDoc.depositAllocations.reduce((s, a) => s + a.pendingRefundAmount, 0);
    txDoc.state =
      totalPending > 0
        ? 'REFUND_PENDING'
        : totalConfirmed > 0
          ? 'PARTIALLY_REFUNDED'
          : 'CAPTURED';
    await txDoc.save({ session: session ?? undefined });

    if (params.event) {
      await appendEventAndOutbox(
        params.event,
        [{ entityType: 'payment', entityId: txDoc._id.toString() }],
        session
      );
    }

    return {
      refund: mapRefund(updatedRefund),
      transaction: mapTransactionLocal(txDoc.toObject()),
    };
  }

  async retryFailedRefundReservationAtomically(
    params: {
      refundId: string;
      newPayPalRequestId: string;
    },
    session?: ClientSession | null
  ): Promise<{ refund: RefundDto; transaction: TransactionDto } | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(params.refundId)) return null;

    const existing = await RefundModel.findOne({
      _id: new mongoose.Types.ObjectId(params.refundId),
      state: 'REFUND_FAILED',
    }).session(session ?? null);
    if (!existing) return null;

    const txDoc = await TransactionModel.findOne({
      _id: existing.transactionId,
      state: { $in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING', 'REFUND_FAILED'] },
    }).session(session ?? null);
    if (!txDoc) return null;

    const alloc = txDoc.depositAllocations.find(
      (a) => a.packageId.toUpperCase() === existing.packageId.toUpperCase()
    );
    if (!alloc) return null;

    const remainingPkg =
      Math.round(
        (alloc.allocatedDeposit - alloc.refundedAmount - alloc.pendingRefundAmount + Number.EPSILON) *
          100
      ) / 100;
    const totalUsed = txDoc.depositAllocations.reduce(
      (s, a) => s + a.refundedAmount + a.pendingRefundAmount,
      0
    );
    const remainingTx = Math.round((txDoc.amount - totalUsed + Number.EPSILON) * 100) / 100;
    if (existing.amount > remainingPkg + 0.001 || existing.amount > remainingTx + 0.001) {
      return null;
    }

    alloc.pendingRefundAmount =
      Math.round((alloc.pendingRefundAmount + existing.amount) * 100) / 100;
    txDoc.state = 'REFUND_REQUESTED';
    await txDoc.save({ session: session ?? undefined });

    existing.state = 'REFUND_REQUESTED';
    existing.paypalRequestId = params.newPayPalRequestId;
    await existing.save({ session: session ?? undefined });

    return {
      refund: mapRefund(existing.toObject()),
      transaction: mapTransactionLocal(txDoc.toObject()),
    };
  }
}

export class MongooseWebhookEventRepository implements WebhookEventRepository {
  async findByProviderEventId(providerEventId: string): Promise<WebhookEventDto | null> {
    ensureDbReady();
    const doc = await WebhookEventModel.findOne({ providerEventId: providerEventId.trim() }).lean();
    return doc ? mapWebhook(doc) : null;
  }

  async createUnique(input: {
    provider: 'PAYPAL';
    providerEventId: string;
    eventType: string;
    resourceId?: string;
    payloadSummary: Record<string, unknown>;
    resourceSnapshot?: Record<string, unknown>;
    verificationResult: 'VERIFIED' | 'FAILED' | 'PENDING';
    processingState: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED';
    error?: string;
  }): Promise<{ created: boolean; record: WebhookEventDto }> {
    ensureDbReady();
    try {
      const [doc] = await WebhookEventModel.create([input]);
      return { created: true, record: mapWebhook(doc.toObject()) };
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) {
        const existing = await this.findByProviderEventId(input.providerEventId);
        if (existing) return { created: false, record: existing };
      }
      throw err;
    }
  }

  async updateProcessingState(
    providerEventId: string,
    update: {
      processingState: 'PROCESSED' | 'IGNORED' | 'FAILED';
      error?: string;
      processedAt?: Date;
      retryCount?: number;
      nextRetryAt?: Date | null;
    }
  ): Promise<WebhookEventDto | null> {
    ensureDbReady();
    const { nextRetryAt, ...rest } = update;
    const mongoUpdate: Record<string, unknown> = { $set: rest };
    if (nextRetryAt === null) {
      mongoUpdate.$unset = { nextRetryAt: 1 };
    } else if (nextRetryAt !== undefined) {
      (mongoUpdate.$set as Record<string, unknown>).nextRetryAt = nextRetryAt;
    }
    const doc = await WebhookEventModel.findOneAndUpdate(
      { providerEventId: providerEventId.trim() },
      mongoUpdate,
      { new: true }
    ).lean();
    return doc ? mapWebhook(doc) : null;
  }

  async listRetryableFailed(now: Date, maxRetries: number, limit = 20): Promise<WebhookEventDto[]> {
    ensureDbReady();
    const docs = await WebhookEventModel.find({
      verificationResult: 'VERIFIED',
      processingState: 'FAILED',
      retryCount: { $lt: maxRetries },
      $or: [{ nextRetryAt: { $exists: false } }, { nextRetryAt: null }, { nextRetryAt: { $lte: now } }],
    })
      .sort({ nextRetryAt: 1, updatedAt: 1 })
      .limit(limit)
      .lean();
    return docs.map(mapWebhook);
  }
}

export type { DepositAllocationDto, OrderDto, PaymentStatus, UserRole };
