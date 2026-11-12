import crypto from 'node:crypto';
import mongoose, { ClientSession } from 'mongoose';
import {
  OrderModel,
  PackageEventModel,
  PackageModel,
  SearchOutboxModel,
  UserModel,
} from '../models/index.js';
import { OrderStatus, PackageStatus, UserRole } from '../types/domain.js';
import { serviceUnavailable } from '../utils/errors.js';
import {
  mapPackageDto,
  OrderDto,
  PackageDto,
  PaginatedResult,
} from './phase2Repositories.js';

export interface PackageEventDto {
  eventId: string;
  packageId: string;
  merchantId?: string;
  scanId?: string;
  type: string;
  actor: {
    userId: string;
    role: UserRole | 'SYSTEM' | 'PAYPAL_WEBHOOK';
  };
  occurredAt: Date;
  sourceSystem: string;
  correlationId?: string;
  locationRef?: string;
  outcome: 'ACCEPTED' | 'REJECTED';
  evidence: Array<{
    type: 'PHOTO' | 'QR_SCAN' | 'SIGNATURE' | 'NOTE';
    fileRef?: string;
    detail?: string;
  }>;
  metadata?: Record<string, unknown>;
}

export interface CreatePackageEventInput {
  eventId?: string;
  packageId: string;
  merchantId?: string;
  scanId?: string;
  type: string;
  actor: {
    userId: string;
    role: UserRole | 'SYSTEM' | 'PAYPAL_WEBHOOK';
  };
  occurredAt?: Date;
  sourceSystem?: string;
  correlationId?: string;
  locationRef?: string;
  outcome: 'ACCEPTED' | 'REJECTED';
  evidence?: Array<{
    type: 'PHOTO' | 'QR_SCAN' | 'SIGNATURE' | 'NOTE';
    fileRef?: string;
    detail?: string;
  }>;
  metadata?: Record<string, unknown>;
}

export interface PartnerDirectoryEntry {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: 'ACTIVE' | 'SUSPENDED' | 'INVITED';
}

export interface AtomicScanTransitionParams {
  packageId: string;
  expectedFromStatus: PackageStatus;
  toStatus: PackageStatus;
  newCustodian?: PackageDto['currentCustodian'];
  clearOrderAndPartner?: boolean;
  assignedPartnerUserId?: string;
  assignedPartnerName?: string;
  incrementReuseCount?: boolean;
  lastInspectionAt?: Date;
  lastInspectionOutcome?: 'PASS' | 'FAIL' | 'NEEDS_REVIEW';
  lastCleanedAt?: Date;
  event: CreatePackageEventInput;
  orderUpdate?: {
    orderId: string;
    expectedStatuses: OrderStatus[];
    toStatus: OrderStatus;
    returnDeadlineAt?: Date;
  };
}

export interface PassportRepository {
  findPackageById(packageId: string, session?: ClientSession | null): Promise<PackageDto | null>;
  findPackagesByIds(
    packageIds: string[],
    session?: ClientSession | null
  ): Promise<PackageDto[]>;
  findAssignedToPartner(params: {
    partnerUserId: string;
    status?: PackageStatus;
    page: number;
    pageSize: number;
  }): Promise<PaginatedResult<PackageDto>>;
  findEventsByPackageId(packageId: string, limit?: number): Promise<PackageEventDto[]>;
  findEventByScanId(
    packageId: string,
    scanId: string,
    session?: ClientSession | null
  ): Promise<PackageEventDto | null>;
  recordEvent(input: CreatePackageEventInput, session?: ClientSession | null): Promise<PackageEventDto>;
  applyScanTransitionAtomically(
    params: AtomicScanTransitionParams,
    session?: ClientSession | null
  ): Promise<{ package: PackageDto; event: PackageEventDto; orderUpdated: boolean } | null>;
  updateQrCredentials(
    params: {
      packageId: string;
      qrTokenHash: string;
      qrTokenVersion: number;
      qrRevoked: boolean;
      qrRevokedAt?: Date | null;
      qrRevokedReason?: string | null;
      event: CreatePackageEventInput;
    },
    session?: ClientSession | null
  ): Promise<{ package: PackageDto; event: PackageEventDto } | null>;
  assignDeliveryPartner(
    params: {
      packageId: string;
      partnerUserId: string;
      partnerName: string;
      event: CreatePackageEventInput;
    },
    session?: ClientSession | null
  ): Promise<{ package: PackageDto; event: PackageEventDto } | null>;
  findUserSummary(userId: string): Promise<PartnerDirectoryEntry | null>;
  listActiveDeliveryPartners(): Promise<PartnerDirectoryEntry[]>;
}

function ensureDbReady(): void {
  if (mongoose.connection.readyState !== 1) {
    throw serviceUnavailable('Database connection is not active. Configure MONGODB_URI.');
  }
}

function mapPackageEvent(doc: any): PackageEventDto {
  return {
    eventId: doc.eventId,
    packageId: doc.packageId,
    merchantId: doc.merchantId ? doc.merchantId.toString() : undefined,
    scanId: doc.scanId,
    type: doc.type,
    actor: doc.actor,
    occurredAt: doc.occurredAt,
    sourceSystem: doc.sourceSystem,
    correlationId: doc.correlationId,
    locationRef: doc.locationRef,
    outcome: doc.outcome,
    evidence: doc.evidence ?? [],
    metadata: doc.metadata,
  };
}

function toSafeObjectId(value: string | undefined): mongoose.Types.ObjectId | undefined {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) {
    return undefined;
  }
  return new mongoose.Types.ObjectId(value);
}

export class MongoosePassportRepository implements PassportRepository {
  async findPackageById(
    packageId: string,
    session?: ClientSession | null
  ): Promise<PackageDto | null> {
    ensureDbReady();
    const doc = await PackageModel.findOne({ packageId: packageId.trim().toUpperCase() })
      .session(session ?? null)
      .lean();
    return doc ? mapPackageDto(doc) : null;
  }

  async findPackagesByIds(
    packageIds: string[],
    session?: ClientSession | null
  ): Promise<PackageDto[]> {
    ensureDbReady();
    if (packageIds.length === 0) return [];
    const normalized = packageIds.map((id) => id.trim().toUpperCase());
    const docs = await PackageModel.find({ packageId: { $in: normalized } })
      .session(session ?? null)
      .lean();
    return docs.map(mapPackageDto);
  }

  async findAssignedToPartner(params: {
    partnerUserId: string;
    status?: PackageStatus;
    page: number;
    pageSize: number;
  }): Promise<PaginatedResult<PackageDto>> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(params.partnerUserId)) {
      return { items: [], total: 0, page: params.page, pageSize: params.pageSize };
    }
    const query: Record<string, unknown> = {
      assignedPartnerUserId: new mongoose.Types.ObjectId(params.partnerUserId),
    };
    if (params.status) {
      query.status = params.status;
    }

    const [docs, total] = await Promise.all([
      PackageModel.find(query)
        .sort({ updatedAt: -1 })
        .skip((params.page - 1) * params.pageSize)
        .limit(params.pageSize)
        .lean(),
      PackageModel.countDocuments(query),
    ]);

    return {
      items: docs.map(mapPackageDto),
      total,
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  async findEventsByPackageId(packageId: string, limit = 100): Promise<PackageEventDto[]> {
    ensureDbReady();
    const docs = await PackageEventModel.find({ packageId: packageId.trim().toUpperCase() })
      .sort({ occurredAt: -1 })
      .limit(limit)
      .lean();
    return docs.map(mapPackageEvent);
  }

  async findEventByScanId(
    packageId: string,
    scanId: string,
    session?: ClientSession | null
  ): Promise<PackageEventDto | null> {
    ensureDbReady();
    const doc = await PackageEventModel.findOne({
      packageId: packageId.trim().toUpperCase(),
      scanId: scanId.trim(),
    })
      .session(session ?? null)
      .lean();
    return doc ? mapPackageEvent(doc) : null;
  }

  async recordEvent(
    input: CreatePackageEventInput,
    session?: ClientSession | null
  ): Promise<PackageEventDto> {
    ensureDbReady();
    const eventId = input.eventId ?? `evt_${crypto.randomUUID()}`;
    const merchantObjId = toSafeObjectId(input.merchantId);

    const [doc] = await PackageEventModel.create(
      [
        {
          eventId,
          packageId: input.packageId.trim().toUpperCase(),
          ...(merchantObjId ? { merchantId: merchantObjId } : {}),
          ...(input.scanId?.trim() ? { scanId: input.scanId.trim() } : {}),
          type: input.type,
          actor: input.actor,
          occurredAt: input.occurredAt ?? new Date(),
          sourceSystem: input.sourceSystem ?? 'REBOXIFY_API',
          correlationId: input.correlationId,
          locationRef: input.locationRef,
          outcome: input.outcome,
          evidence: input.evidence ?? [],
          metadata: input.metadata,
        },
      ],
      { session: session ?? undefined }
    );

    await SearchOutboxModel.create(
      [
        {
          entityType: 'package_event',
          entityId: eventId,
          operation: 'UPSERT',
          status: 'PENDING',
        },
      ],
      { session: session ?? undefined }
    );

    return mapPackageEvent(doc.toObject ? doc.toObject() : doc);
  }

  async applyScanTransitionAtomically(
    params: AtomicScanTransitionParams,
    session?: ClientSession | null
  ): Promise<{ package: PackageDto; event: PackageEventDto; orderUpdated: boolean } | null> {
    ensureDbReady();
    const setFields: Record<string, unknown> = {
      status: params.toStatus,
    };
    const unsetFields: Record<string, 1> = {};

    if (params.newCustodian) {
      setFields.currentCustodian = params.newCustodian;
    }
    if (params.assignedPartnerUserId) {
      const partnerObjId = toSafeObjectId(params.assignedPartnerUserId);
      if (partnerObjId) {
        setFields.assignedPartnerUserId = partnerObjId;
      }
      if (params.assignedPartnerName) {
        setFields.assignedPartnerName = params.assignedPartnerName;
      }
    }
    if (params.clearOrderAndPartner) {
      unsetFields.currentOrderId = 1;
      unsetFields.assignedPartnerUserId = 1;
      unsetFields.assignedPartnerName = 1;
    }
    if (params.lastInspectionAt) {
      setFields.lastInspectionAt = params.lastInspectionAt;
    }
    if (params.lastInspectionOutcome) {
      setFields.lastInspectionOutcome = params.lastInspectionOutcome;
    }
    if (params.lastCleanedAt) {
      setFields.lastCleanedAt = params.lastCleanedAt;
    }

    const updateDoc: Record<string, unknown> = { $set: setFields };
    if (Object.keys(unsetFields).length > 0) {
      updateDoc.$unset = unsetFields;
    }
    if (params.incrementReuseCount) {
      updateDoc.$inc = { reuseCount: 1 };
    }

    const updatedPkgDoc = await PackageModel.findOneAndUpdate(
      {
        packageId: params.packageId.trim().toUpperCase(),
        status: params.expectedFromStatus,
      },
      updateDoc,
      { new: true, session: session ?? undefined }
    ).lean();

    if (!updatedPkgDoc) {
      return null;
    }

    const event = await this.recordEvent(params.event, session);

    await SearchOutboxModel.create(
      [
        {
          entityType: 'passport',
          entityId: updatedPkgDoc.packageId,
          operation: 'UPSERT',
          status: 'PENDING',
        },
      ],
      { session: session ?? undefined }
    );

    let orderUpdated = false;
    if (params.orderUpdate && mongoose.Types.ObjectId.isValid(params.orderUpdate.orderId)) {
      const orderSet: Record<string, unknown> = {
        status: params.orderUpdate.toStatus,
      };
      if (params.orderUpdate.returnDeadlineAt) {
        orderSet.returnDeadlineAt = params.orderUpdate.returnDeadlineAt;
      }
      const updatedOrder = await OrderModel.findOneAndUpdate(
        {
          _id: new mongoose.Types.ObjectId(params.orderUpdate.orderId),
          status: { $in: params.orderUpdate.expectedStatuses },
        },
        { $set: orderSet },
        { new: true, session: session ?? undefined }
      ).lean();
      orderUpdated = Boolean(updatedOrder);
    }

    return {
      package: mapPackageDto(updatedPkgDoc),
      event,
      orderUpdated,
    };
  }

  async updateQrCredentials(
    params: {
      packageId: string;
      qrTokenHash: string;
      qrTokenVersion: number;
      qrRevoked: boolean;
      qrRevokedAt?: Date | null;
      qrRevokedReason?: string | null;
      event: CreatePackageEventInput;
    },
    session?: ClientSession | null
  ): Promise<{ package: PackageDto; event: PackageEventDto } | null> {
    ensureDbReady();
    const setFields: Record<string, unknown> = {
      qrTokenHash: params.qrTokenHash,
      qrTokenVersion: params.qrTokenVersion,
      qrRevoked: params.qrRevoked,
    };
    const unsetFields: Record<string, 1> = {};

    if (params.qrRevokedAt) {
      setFields.qrRevokedAt = params.qrRevokedAt;
    } else if (params.qrRevokedAt === null) {
      unsetFields.qrRevokedAt = 1;
    }

    if (params.qrRevokedReason) {
      setFields.qrRevokedReason = params.qrRevokedReason;
    } else if (params.qrRevokedReason === null) {
      unsetFields.qrRevokedReason = 1;
    }

    const updateDoc: Record<string, unknown> = { $set: setFields };
    if (Object.keys(unsetFields).length > 0) {
      updateDoc.$unset = unsetFields;
    }

    const updatedPkgDoc = await PackageModel.findOneAndUpdate(
      { packageId: params.packageId.trim().toUpperCase() },
      updateDoc,
      { new: true, session: session ?? undefined }
    ).lean();

    if (!updatedPkgDoc) {
      return null;
    }

    const event = await this.recordEvent(params.event, session);

    await SearchOutboxModel.create(
      [
        {
          entityType: 'passport',
          entityId: updatedPkgDoc.packageId,
          operation: 'UPSERT',
          status: 'PENDING',
        },
      ],
      { session: session ?? undefined }
    );

    return {
      package: mapPackageDto(updatedPkgDoc),
      event,
    };
  }

  async assignDeliveryPartner(
    params: {
      packageId: string;
      partnerUserId: string;
      partnerName: string;
      event: CreatePackageEventInput;
    },
    session?: ClientSession | null
  ): Promise<{ package: PackageDto; event: PackageEventDto } | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(params.partnerUserId)) {
      return null;
    }
    const updatedPkgDoc = await PackageModel.findOneAndUpdate(
      { packageId: params.packageId.trim().toUpperCase() },
      {
        $set: {
          assignedPartnerUserId: new mongoose.Types.ObjectId(params.partnerUserId),
          assignedPartnerName: params.partnerName,
        },
      },
      { new: true, session: session ?? undefined }
    ).lean();

    if (!updatedPkgDoc) {
      return null;
    }

    const event = await this.recordEvent(params.event, session);

    await SearchOutboxModel.create(
      [
        {
          entityType: 'passport',
          entityId: updatedPkgDoc.packageId,
          operation: 'UPSERT',
          status: 'PENDING',
        },
      ],
      { session: session ?? undefined }
    );

    return {
      package: mapPackageDto(updatedPkgDoc),
      event,
    };
  }

  async findUserSummary(userId: string): Promise<PartnerDirectoryEntry | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return null;
    }
    const doc = await UserModel.findById(userId)
      .select('name email role status')
      .lean();
    if (!doc) return null;
    return {
      id: doc._id.toString(),
      name: doc.name,
      email: doc.email,
      role: doc.role as UserRole,
      status: doc.status as PartnerDirectoryEntry['status'],
    };
  }

  async listActiveDeliveryPartners(): Promise<PartnerDirectoryEntry[]> {
    ensureDbReady();
    const docs = await UserModel.find({ role: 'DELIVERY_PARTNER', status: 'ACTIVE' })
      .select('name email role status')
      .sort({ name: 1 })
      .lean();
    return docs.map((doc) => ({
      id: doc._id.toString(),
      name: doc.name,
      email: doc.email,
      role: doc.role as UserRole,
      status: doc.status as PartnerDirectoryEntry['status'],
    }));
  }
}

export type { OrderDto };

