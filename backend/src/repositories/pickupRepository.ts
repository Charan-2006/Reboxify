import crypto from 'node:crypto';
import mongoose, { ClientSession } from 'mongoose';
import {
  CollectionCenterModel,
  DeliveryPartnerModel,
  OrderModel,
  PackageEventModel,
  PickupModel,
  ReturnModel,
  UserModel,
} from '../models/index.js';
import { PickupStatus, ReturnMode, UserRole } from '../types/domain.js';
import { conflict, serviceUnavailable } from '../utils/errors.js';
import { enqueueSearchOutbox } from './outboxHelper.js';
import { PaginatedResult } from './phase2Types.js';
import { CreatePackageEventInput } from './phase4Repositories.js';

export interface PickupRescheduleEntryDto {
  previousStart: Date;
  previousEnd: Date;
  newStart: Date;
  newEnd: Date;
  reason: string;
  changedBy: string;
  changedAt: Date;
}

export interface PickupDto {
  id: string;
  returnId: string;
  returnNumber?: string;
  orderId?: string;
  orderNumber?: string;
  packageId: string;
  merchantId: string;
  customerId?: string;
  collectionCenterId?: string;
  slotStart: Date;
  slotEnd: Date;
  timeZone: string;
  pickupMethod: ReturnMode;
  serviceZone: string;
  addressSummary: string;
  location?: { lat: number; lng: number };
  partnerId?: string;
  assignedPartnerName?: string;
  status: PickupStatus;
  rescheduleHistory: PickupRescheduleEntryDto[];
  missedReason?: string;
  cancelReason?: string;
  notes?: string;
  createdBy?: string;
  updatedBy?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PartnerScheduleDto {
  id?: string;
  userId: string;
  displayName: string;
  email?: string;
  serviceZones: string[];
  timeZone: string;
  workingHours: {
    startHour: number;
    endHour: number;
    daysOfWeek: number[];
  };
  unavailablePeriods: Array<{
    start: Date;
    end: Date;
    reason?: string;
  }>;
  dailyCapacity: number;
  maxConcurrentCapacity: number;
  bookingLockVersion: number;
  status: 'ACTIVE' | 'UNAVAILABLE' | 'SUSPENDED';
}

export interface CollectionCentreDto {
  id: string;
  code: string;
  name: string;
  operatorUserId: string;
  address: string;
  serviceZones: string[];
  hours: string;
  capacity: number;
  currentWorkload: number;
  status: 'ACTIVE' | 'FULL' | 'OFFLINE';
}

export interface PickupRepository {
  findById(id: string, session?: ClientSession | null): Promise<PickupDto | null>;
  findByReturnId(returnId: string, session?: ClientSession | null): Promise<PickupDto | null>;
  list(filters: {
    merchantId?: string;
    customerId?: string;
    partnerId?: string;
    collectionCenterId?: string;
    includeUnassignedForCentre?: boolean;
    status?: PickupStatus;
    statuses?: PickupStatus[];
    serviceZone?: string;
    from?: Date;
    to?: Date;
    search?: string;
    page: number;
    pageSize: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  }): Promise<PaginatedResult<PickupDto>>;
  create(
    input: {
      returnId: string;
      orderId?: string;
      packageId: string;
      merchantId: string;
      customerId?: string;
      collectionCenterId?: string;
      slotStart: Date;
      slotEnd: Date;
      timeZone: string;
      pickupMethod: ReturnMode;
      serviceZone: string;
      addressSummary: string;
      location?: { lat: number; lng: number };
      partnerId?: string;
      assignedPartnerName?: string;
      status: PickupStatus;
      notes?: string;
      createdBy?: string;
    },
    session?: ClientSession | null
  ): Promise<PickupDto>;
  updateOptimistic(
    pickupId: string,
    expectedVersion: number,
    setFields: Record<string, unknown>,
    options?: {
      pushReschedule?: {
        previousStart: Date;
        previousEnd: Date;
        newStart: Date;
        newEnd: Date;
        reason: string;
        changedBy: string;
        changedAt: Date;
      };
      unsetFields?: string[];
    },
    session?: ClientSession | null
  ): Promise<PickupDto | null>;
  findPartnerSchedule(
    partnerUserId: string,
    session?: ClientSession | null
  ): Promise<PartnerScheduleDto | null>;
  lockPartnerForScheduling(
    partnerUserId: string,
    fallbackDisplayName: string,
    session?: ClientSession | null
  ): Promise<PartnerScheduleDto>;
  upsertPartnerSchedule(
    partnerUserId: string,
    input: Partial<
      Pick<
        PartnerScheduleDto,
        | 'displayName'
        | 'serviceZones'
        | 'timeZone'
        | 'workingHours'
        | 'unavailablePeriods'
        | 'dailyCapacity'
        | 'maxConcurrentCapacity'
        | 'status'
      >
    >,
    session?: ClientSession | null
  ): Promise<PartnerScheduleDto>;
  listPartnerResources(filters?: {
    partnerUserId?: string;
    serviceZone?: string;
    includeUnavailable?: boolean;
  }): Promise<PartnerScheduleDto[]>;
  findCollectionCentreById(
    centreId: string,
    session?: ClientSession | null
  ): Promise<CollectionCentreDto | null>;
  listCollectionCentres(filters?: {
    status?: 'ACTIVE' | 'FULL' | 'OFFLINE';
    operatorUserId?: string;
    serviceZone?: string;
  }): Promise<CollectionCentreDto[]>;
  countPartnerOverlappingPickups(
    partnerUserId: string,
    slotStart: Date,
    slotEnd: Date,
    excludePickupId?: string,
    session?: ClientSession | null
  ): Promise<number>;
  countPartnerPickupsInRange(
    partnerUserId: string,
    rangeStart: Date,
    rangeEnd: Date,
    excludePickupId?: string,
    session?: ClientSession | null
  ): Promise<number>;
  countCentreOverlappingPickups(
    collectionCenterId: string,
    slotStart: Date,
    slotEnd: Date,
    excludePickupId?: string,
    session?: ClientSession | null
  ): Promise<number>;
  syncReturnAndRecordEvent(
    params: {
      returnId: string;
      returnSet?: Record<string, unknown>;
      unsetReturnFields?: string[];
      event?: CreatePackageEventInput;
      outboxExtra?: Array<{
        entityType: 'passport' | 'package_event' | 'return' | 'payment';
        entityId: string;
      }>;
    },
    session?: ClientSession | null
  ): Promise<void>;
}

function ensureDbReady(): void {
  if (mongoose.connection.readyState !== 1) {
    throw serviceUnavailable('Database connection is not active. Configure MONGODB_URI.');
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mapPickup(doc: any): PickupDto {
  return {
    id: doc._id.toString(),
    returnId: doc.returnId.toString(),
    ...(doc.orderId ? { orderId: doc.orderId.toString() } : {}),
    packageId: doc.packageId,
    merchantId: doc.merchantId.toString(),
    ...(doc.customerId ? { customerId: doc.customerId.toString() } : {}),
    ...(doc.collectionCenterId ? { collectionCenterId: doc.collectionCenterId.toString() } : {}),
    slotStart: new Date(doc.slotStart),
    slotEnd: new Date(doc.slotEnd),
    timeZone: doc.timeZone || 'UTC',
    pickupMethod: doc.pickupMethod || 'PICKUP',
    serviceZone: doc.serviceZone,
    addressSummary: doc.addressSummary,
    ...(doc.location?.lat !== undefined && doc.location?.lng !== undefined
      ? { location: { lat: doc.location.lat, lng: doc.location.lng } }
      : {}),
    ...(doc.partnerId ? { partnerId: doc.partnerId.toString() } : {}),
    ...(doc.assignedPartnerName ? { assignedPartnerName: doc.assignedPartnerName } : {}),
    status: doc.status,
    rescheduleHistory: (doc.rescheduleHistory ?? []).map((entry: any) => ({
      previousStart: new Date(entry.previousStart),
      previousEnd: new Date(entry.previousEnd),
      newStart: new Date(entry.newStart),
      newEnd: new Date(entry.newEnd),
      reason: entry.reason,
      changedBy: entry.changedBy.toString(),
      changedAt: new Date(entry.changedAt),
    })),
    ...(doc.missedReason ? { missedReason: doc.missedReason } : {}),
    ...(doc.cancelReason ? { cancelReason: doc.cancelReason } : {}),
    ...(doc.notes ? { notes: doc.notes } : {}),
    ...(doc.createdBy ? { createdBy: doc.createdBy.toString() } : {}),
    ...(doc.updatedBy ? { updatedBy: doc.updatedBy.toString() } : {}),
    version: doc.version ?? 1,
    createdAt: new Date(doc.createdAt),
    updatedAt: new Date(doc.updatedAt),
  };
}

function mapPartnerSchedule(doc: any, fallbackUser?: { name?: string; email?: string }): PartnerScheduleDto {
  return {
    ...(doc._id ? { id: doc._id.toString() } : {}),
    userId: doc.userId.toString(),
    displayName: doc.displayName || fallbackUser?.name || 'Delivery Partner',
    ...(fallbackUser?.email ? { email: fallbackUser.email } : {}),
    serviceZones: doc.serviceZones ?? [],
    timeZone: doc.timeZone || 'UTC',
    workingHours: {
      startHour: doc.workingHours?.startHour ?? 8,
      endHour: doc.workingHours?.endHour ?? 20,
      daysOfWeek:
        Array.isArray(doc.workingHours?.daysOfWeek) && doc.workingHours.daysOfWeek.length > 0
          ? doc.workingHours.daysOfWeek
          : [0, 1, 2, 3, 4, 5, 6],
    },
    unavailablePeriods: (doc.unavailablePeriods ?? []).map((p: any) => ({
      start: new Date(p.start),
      end: new Date(p.end),
      ...(p.reason ? { reason: p.reason } : {}),
    })),
    dailyCapacity: doc.dailyCapacity ?? 15,
    maxConcurrentCapacity: doc.maxConcurrentCapacity ?? 1,
    bookingLockVersion: doc.bookingLockVersion ?? 0,
    status: doc.status ?? 'ACTIVE',
  };
}

function mapCollectionCentre(doc: any): CollectionCentreDto {
  return {
    id: doc._id.toString(),
    code: doc.code,
    name: doc.name,
    operatorUserId: doc.operatorUserId.toString(),
    address: doc.address,
    serviceZones: doc.serviceZones ?? [],
    hours: doc.hours ?? '09:00-19:00',
    capacity: doc.capacity ?? 200,
    currentWorkload: doc.currentWorkload ?? 0,
    status: doc.status ?? 'ACTIVE',
  };
}

async function enrichPickupDtos(items: PickupDto[]): Promise<PickupDto[]> {
  if (items.length === 0) return items;
  const returnIds = Array.from(new Set(items.map((p) => p.returnId))).map(
    (id) => new mongoose.Types.ObjectId(id)
  );
  const returns = await ReturnModel.find({ _id: { $in: returnIds } })
    .select('_id returnNumber orderId')
    .lean();

  const returnMap = new Map<string, { returnNumber: string; orderId?: string }>(
    returns.map((r: any) => [
      r._id.toString(),
      { returnNumber: r.returnNumber, orderId: r.orderId ? r.orderId.toString() : undefined },
    ])
  );

  const orderIds = Array.from(
    new Set(
      items
        .map((p) => p.orderId || returnMap.get(p.returnId)?.orderId)
        .filter((v): v is string => Boolean(v && mongoose.Types.ObjectId.isValid(v)))
    )
  ).map((id) => new mongoose.Types.ObjectId(id));

  const orders =
    orderIds.length > 0
      ? await OrderModel.find({ _id: { $in: orderIds } }).select('_id orderNumber').lean()
      : [];
  const orderMap = new Map<string, string>(
    orders.map((o: any) => [o._id.toString(), o.orderNumber as string])
  );

  for (const item of items) {
    const retInfo = returnMap.get(item.returnId);
    if (retInfo) {
      item.returnNumber = retInfo.returnNumber;
      if (!item.orderId && retInfo.orderId) item.orderId = retInfo.orderId;
    }
    if (item.orderId) {
      item.orderNumber = orderMap.get(item.orderId);
    }
  }
  return items;
}

export class MongoosePickupRepository implements PickupRepository {
  async findById(id: string, session?: ClientSession | null): Promise<PickupDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const doc = await PickupModel.findById(id)
      .session(session ?? null)
      .lean();
    if (!doc) return null;
    const [enriched] = await enrichPickupDtos([mapPickup(doc)]);
    return enriched;
  }

  async findByReturnId(returnId: string, session?: ClientSession | null): Promise<PickupDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(returnId)) return null;
    const doc = await PickupModel.findOne({ returnId: new mongoose.Types.ObjectId(returnId) })
      .session(session ?? null)
      .lean();
    if (!doc) return null;
    const [enriched] = await enrichPickupDtos([mapPickup(doc)]);
    return enriched;
  }

  async list(filters: {
    merchantId?: string;
    customerId?: string;
    partnerId?: string;
    collectionCenterId?: string;
    includeUnassignedForCentre?: boolean;
    status?: PickupStatus;
    statuses?: PickupStatus[];
    serviceZone?: string;
    from?: Date;
    to?: Date;
    search?: string;
    page: number;
    pageSize: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  }): Promise<PaginatedResult<PickupDto>> {
    ensureDbReady();
    const andClauses: Record<string, unknown>[] = [];

    if (filters.merchantId && mongoose.Types.ObjectId.isValid(filters.merchantId)) {
      andClauses.push({ merchantId: new mongoose.Types.ObjectId(filters.merchantId) });
    }
    if (filters.customerId && mongoose.Types.ObjectId.isValid(filters.customerId)) {
      andClauses.push({ customerId: new mongoose.Types.ObjectId(filters.customerId) });
    }
    if (filters.partnerId && mongoose.Types.ObjectId.isValid(filters.partnerId)) {
      andClauses.push({ partnerId: new mongoose.Types.ObjectId(filters.partnerId) });
    }
    if (filters.collectionCenterId && mongoose.Types.ObjectId.isValid(filters.collectionCenterId)) {
      const centreId = new mongoose.Types.ObjectId(filters.collectionCenterId);
      if (filters.includeUnassignedForCentre) {
        andClauses.push({
          $or: [{ collectionCenterId: centreId }, { collectionCenterId: { $exists: false } }, { collectionCenterId: null }],
        });
      } else {
        andClauses.push({ collectionCenterId: centreId });
      }
    }
    if (filters.status) {
      andClauses.push({ status: filters.status });
    } else if (filters.statuses && filters.statuses.length > 0) {
      andClauses.push({ status: { $in: filters.statuses } });
    }
    if (filters.serviceZone?.trim()) {
      andClauses.push({
        serviceZone: { $regex: `^${escapeRegex(filters.serviceZone.trim())}$`, $options: 'i' },
      });
    }
    if (filters.from) {
      andClauses.push({ slotEnd: { $gte: filters.from } });
    }
    if (filters.to) {
      andClauses.push({ slotStart: { $lte: filters.to } });
    }
    if (filters.search?.trim()) {
      const escaped = escapeRegex(filters.search.trim());
      const matchingReturns = await ReturnModel.find({
        returnNumber: { $regex: escaped, $options: 'i' },
      })
        .select('_id')
        .limit(50)
        .lean();
      const returnIds = matchingReturns.map((r: any) => r._id);
      andClauses.push({
        $or: [
          { packageId: { $regex: escaped, $options: 'i' } },
          { serviceZone: { $regex: escaped, $options: 'i' } },
          { addressSummary: { $regex: escaped, $options: 'i' } },
          { assignedPartnerName: { $regex: escaped, $options: 'i' } },
          ...(returnIds.length > 0 ? [{ returnId: { $in: returnIds } }] : []),
        ],
      });
    }

    const query: Record<string, unknown> =
      andClauses.length === 0
        ? {}
        : andClauses.length === 1
          ? andClauses[0]
          : { $and: andClauses };

    const allowedSort: Record<string, string> = {
      slotStart: 'slotStart',
      status: 'status',
      serviceZone: 'serviceZone',
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
    };
    const sortField = (filters.sortBy && allowedSort[filters.sortBy]) || 'slotStart';
    const sortVal = filters.sortDir === 'desc' ? -1 : 1;

    const [docs, total] = await Promise.all([
      PickupModel.find(query)
        .sort({ [sortField]: sortVal })
        .skip((filters.page - 1) * filters.pageSize)
        .limit(filters.pageSize)
        .lean(),
      PickupModel.countDocuments(query),
    ]);

    const items = await enrichPickupDtos(docs.map(mapPickup));
    return {
      items,
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async create(
    input: {
      returnId: string;
      orderId?: string;
      packageId: string;
      merchantId: string;
      customerId?: string;
      collectionCenterId?: string;
      slotStart: Date;
      slotEnd: Date;
      timeZone: string;
      pickupMethod: ReturnMode;
      serviceZone: string;
      addressSummary: string;
      location?: { lat: number; lng: number };
      partnerId?: string;
      assignedPartnerName?: string;
      status: PickupStatus;
      notes?: string;
      createdBy?: string;
    },
    session?: ClientSession | null
  ): Promise<PickupDto> {
    ensureDbReady();
    try {
      const [created] = await PickupModel.create(
        [
          {
            returnId: new mongoose.Types.ObjectId(input.returnId),
            ...(input.orderId ? { orderId: new mongoose.Types.ObjectId(input.orderId) } : {}),
            packageId: input.packageId.trim().toUpperCase(),
            merchantId: new mongoose.Types.ObjectId(input.merchantId),
            ...(input.customerId ? { customerId: new mongoose.Types.ObjectId(input.customerId) } : {}),
            ...(input.collectionCenterId
              ? { collectionCenterId: new mongoose.Types.ObjectId(input.collectionCenterId) }
              : {}),
            slotStart: input.slotStart,
            slotEnd: input.slotEnd,
            timeZone: input.timeZone || 'UTC',
            pickupMethod: input.pickupMethod,
            serviceZone: input.serviceZone.trim(),
            addressSummary: input.addressSummary.trim(),
            ...(input.location ? { location: input.location } : {}),
            ...(input.partnerId ? { partnerId: new mongoose.Types.ObjectId(input.partnerId) } : {}),
            ...(input.assignedPartnerName ? { assignedPartnerName: input.assignedPartnerName } : {}),
            status: input.status,
            ...(input.notes ? { notes: input.notes } : {}),
            ...(input.createdBy ? { createdBy: new mongoose.Types.ObjectId(input.createdBy) } : {}),
            ...(input.createdBy ? { updatedBy: new mongoose.Types.ObjectId(input.createdBy) } : {}),
            version: 1,
          },
        ],
        { session: session ?? undefined }
      );
      const [enriched] = await enrichPickupDtos([mapPickup(created.toObject())]);
      return enriched;
    } catch (err: any) {
      if (err?.code === 11000) {
        throw conflict('A pickup appointment already exists for this return.');
      }
      throw err;
    }
  }

  async updateOptimistic(
    pickupId: string,
    expectedVersion: number,
    setFields: Record<string, unknown>,
    options?: {
      pushReschedule?: {
        previousStart: Date;
        previousEnd: Date;
        newStart: Date;
        newEnd: Date;
        reason: string;
        changedBy: string;
        changedAt: Date;
      };
      unsetFields?: string[];
    },
    session?: ClientSession | null
  ): Promise<PickupDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(pickupId)) return null;

    const mappedSet: Record<string, unknown> = { ...setFields };
    for (const idField of ['partnerId', 'collectionCenterId', 'updatedBy'] as const) {
      const val = mappedSet[idField];
      if (typeof val === 'string' && mongoose.Types.ObjectId.isValid(val)) {
        mappedSet[idField] = new mongoose.Types.ObjectId(val);
      }
    }

    const updateDoc: Record<string, unknown> = {
      $set: mappedSet,
      $inc: { version: 1 },
    };
    if (options?.unsetFields && options.unsetFields.length > 0) {
      const unsetObj: Record<string, 1> = {};
      for (const f of options.unsetFields) unsetObj[f] = 1;
      updateDoc.$unset = unsetObj;
    }
    if (options?.pushReschedule) {
      updateDoc.$push = {
        rescheduleHistory: {
          ...options.pushReschedule,
          changedBy: new mongoose.Types.ObjectId(options.pushReschedule.changedBy),
        },
      };
    }

    const doc = await PickupModel.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(pickupId), version: expectedVersion },
      updateDoc,
      { new: true, session: session ?? undefined }
    ).lean();
    if (!doc) return null;
    const [enriched] = await enrichPickupDtos([mapPickup(doc)]);
    return enriched;
  }

  async findPartnerSchedule(
    partnerUserId: string,
    session?: ClientSession | null
  ): Promise<PartnerScheduleDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(partnerUserId)) return null;
    const userObjId = new mongoose.Types.ObjectId(partnerUserId);
    const [userDoc, profileDoc] = await Promise.all([
      UserModel.findOne({ _id: userObjId, role: 'DELIVERY_PARTNER' })
        .select('_id name email status')
        .session(session ?? null)
        .lean(),
      DeliveryPartnerModel.findOne({ userId: userObjId }).session(session ?? null).lean(),
    ]);

    if (!userDoc) return null;
    if (!profileDoc) {
      return {
        userId: userDoc._id.toString(),
        displayName: userDoc.name,
        email: userDoc.email,
        serviceZones: [],
        timeZone: 'UTC',
        workingHours: { startHour: 8, endHour: 20, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
        unavailablePeriods: [],
        dailyCapacity: 15,
        maxConcurrentCapacity: 1,
        bookingLockVersion: 0,
        status: userDoc.status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED',
      };
    }
    return mapPartnerSchedule(profileDoc, { name: userDoc.name, email: userDoc.email });
  }

  async lockPartnerForScheduling(
    partnerUserId: string,
    fallbackDisplayName: string,
    session?: ClientSession | null
  ): Promise<PartnerScheduleDto> {
    ensureDbReady();
    const userObjId = new mongoose.Types.ObjectId(partnerUserId);
    const doc = await DeliveryPartnerModel.findOneAndUpdate(
      { userId: userObjId },
      {
        $inc: { bookingLockVersion: 1 },
        $setOnInsert: {
          userId: userObjId,
          displayName: fallbackDisplayName,
          serviceZones: [],
          timeZone: 'UTC',
          workingHours: { startHour: 8, endHour: 20, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
          unavailablePeriods: [],
          dailyCapacity: 15,
          maxConcurrentCapacity: 1,
          status: 'ACTIVE',
        },
      },
      { upsert: true, new: true, session: session ?? undefined }
    ).lean();
    return mapPartnerSchedule(doc, { name: fallbackDisplayName });
  }

  async upsertPartnerSchedule(
    partnerUserId: string,
    input: Partial<
      Pick<
        PartnerScheduleDto,
        | 'displayName'
        | 'serviceZones'
        | 'timeZone'
        | 'workingHours'
        | 'unavailablePeriods'
        | 'dailyCapacity'
        | 'maxConcurrentCapacity'
        | 'status'
      >
    >,
    session?: ClientSession | null
  ): Promise<PartnerScheduleDto> {
    ensureDbReady();
    const userObjId = new mongoose.Types.ObjectId(partnerUserId);
    const userDoc = await UserModel.findById(userObjId).select('name email').session(session ?? null).lean();
    const setFields: Record<string, unknown> = {};
    if (input.displayName !== undefined) setFields.displayName = input.displayName;
    if (input.serviceZones !== undefined) setFields.serviceZones = input.serviceZones;
    if (input.timeZone !== undefined) setFields.timeZone = input.timeZone;
    if (input.workingHours !== undefined) setFields.workingHours = input.workingHours;
    if (input.unavailablePeriods !== undefined) setFields.unavailablePeriods = input.unavailablePeriods;
    if (input.dailyCapacity !== undefined) setFields.dailyCapacity = input.dailyCapacity;
    if (input.maxConcurrentCapacity !== undefined) {
      setFields.maxConcurrentCapacity = input.maxConcurrentCapacity;
    }
    if (input.status !== undefined) setFields.status = input.status;

    const doc = await DeliveryPartnerModel.findOneAndUpdate(
      { userId: userObjId },
      {
        $set: setFields,
        $inc: { bookingLockVersion: 1 },
        $setOnInsert: {
          userId: userObjId,
          ...(input.displayName === undefined ? { displayName: userDoc?.name ?? 'Delivery Partner' } : {}),
        },
      },
      { upsert: true, new: true, session: session ?? undefined }
    ).lean();

    return mapPartnerSchedule(doc, userDoc ? { name: userDoc.name, email: userDoc.email } : undefined);
  }

  async listPartnerResources(filters?: {
    partnerUserId?: string;
    serviceZone?: string;
    includeUnavailable?: boolean;
  }): Promise<PartnerScheduleDto[]> {
    ensureDbReady();
    const userQuery: Record<string, unknown> = {
      role: 'DELIVERY_PARTNER' as UserRole,
      status: 'ACTIVE',
    };
    if (filters?.partnerUserId && mongoose.Types.ObjectId.isValid(filters.partnerUserId)) {
      userQuery._id = new mongoose.Types.ObjectId(filters.partnerUserId);
    }

    const users = await UserModel.find(userQuery).select('_id name email status').lean();
    if (users.length === 0) return [];

    const userIds = users.map((u: any) => u._id);
    const profiles = await DeliveryPartnerModel.find({ userId: { $in: userIds } }).lean();
    const profileMap = new Map<string, any>(
      profiles.map((p: any) => [p.userId.toString(), p])
    );

    const results: PartnerScheduleDto[] = [];
    for (const u of users as any[]) {
      const p = profileMap.get(u._id.toString());
      const dto = p
        ? mapPartnerSchedule(p, { name: u.name, email: u.email })
        : {
            userId: u._id.toString(),
            displayName: u.name,
            email: u.email,
            serviceZones: [],
            timeZone: 'UTC',
            workingHours: { startHour: 8, endHour: 20, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
            unavailablePeriods: [],
            dailyCapacity: 15,
            maxConcurrentCapacity: 1,
            bookingLockVersion: 0,
            status: 'ACTIVE' as const,
          };

      if (!filters?.includeUnavailable && dto.status !== 'ACTIVE') {
        continue;
      }
      if (
        filters?.serviceZone?.trim() &&
        dto.serviceZones.length > 0 &&
        !dto.serviceZones.some(
          (z) =>
            z === '*' ||
            z.toUpperCase() === 'ALL' ||
            z.trim().toUpperCase() === filters.serviceZone!.trim().toUpperCase()
        )
      ) {
        continue;
      }
      results.push(dto);
    }
    return results;
  }

  async findCollectionCentreById(
    centreId: string,
    session?: ClientSession | null
  ): Promise<CollectionCentreDto | null> {
    ensureDbReady();
    if (!mongoose.Types.ObjectId.isValid(centreId)) return null;
    const doc = await CollectionCenterModel.findById(centreId).session(session ?? null).lean();
    return doc ? mapCollectionCentre(doc) : null;
  }

  async listCollectionCentres(filters?: {
    status?: 'ACTIVE' | 'FULL' | 'OFFLINE';
    operatorUserId?: string;
    serviceZone?: string;
  }): Promise<CollectionCentreDto[]> {
    ensureDbReady();
    const query: Record<string, unknown> = {};
    if (filters?.status) query.status = filters.status;
    if (filters?.operatorUserId && mongoose.Types.ObjectId.isValid(filters.operatorUserId)) {
      query.operatorUserId = new mongoose.Types.ObjectId(filters.operatorUserId);
    }
    if (filters?.serviceZone?.trim()) {
      query.serviceZones = { $in: [new RegExp(`^${escapeRegex(filters.serviceZone.trim())}$`, 'i')] };
    }
    const docs = await CollectionCenterModel.find(query).sort({ name: 1 }).lean();
    return docs.map(mapCollectionCentre);
  }

  async countPartnerOverlappingPickups(
    partnerUserId: string,
    slotStart: Date,
    slotEnd: Date,
    excludePickupId?: string,
    session?: ClientSession | null
  ): Promise<number> {
    ensureDbReady();
    const query: Record<string, unknown> = {
      partnerId: new mongoose.Types.ObjectId(partnerUserId),
      status: { $nin: ['CANCELLED', 'COMPLETED', 'MISSED'] },
      slotStart: { $lt: slotEnd },
      slotEnd: { $gt: slotStart },
    };
    if (excludePickupId && mongoose.Types.ObjectId.isValid(excludePickupId)) {
      query._id = { $ne: new mongoose.Types.ObjectId(excludePickupId) };
    }
    return PickupModel.countDocuments(query).session(session ?? null);
  }

  async countPartnerPickupsInRange(
    partnerUserId: string,
    rangeStart: Date,
    rangeEnd: Date,
    excludePickupId?: string,
    session?: ClientSession | null
  ): Promise<number> {
    ensureDbReady();
    const query: Record<string, unknown> = {
      partnerId: new mongoose.Types.ObjectId(partnerUserId),
      status: { $nin: ['CANCELLED'] },
      slotStart: { $gte: rangeStart, $lt: rangeEnd },
    };
    if (excludePickupId && mongoose.Types.ObjectId.isValid(excludePickupId)) {
      query._id = { $ne: new mongoose.Types.ObjectId(excludePickupId) };
    }
    return PickupModel.countDocuments(query).session(session ?? null);
  }

  async countCentreOverlappingPickups(
    collectionCenterId: string,
    slotStart: Date,
    slotEnd: Date,
    excludePickupId?: string,
    session?: ClientSession | null
  ): Promise<number> {
    ensureDbReady();
    const query: Record<string, unknown> = {
      collectionCenterId: new mongoose.Types.ObjectId(collectionCenterId),
      status: { $nin: ['CANCELLED', 'COMPLETED'] },
      slotStart: { $lt: slotEnd },
      slotEnd: { $gt: slotStart },
    };
    if (excludePickupId && mongoose.Types.ObjectId.isValid(excludePickupId)) {
      query._id = { $ne: new mongoose.Types.ObjectId(excludePickupId) };
    }
    return PickupModel.countDocuments(query).session(session ?? null);
  }

  async syncReturnAndRecordEvent(
    params: {
      returnId: string;
      returnSet?: Record<string, unknown>;
      unsetReturnFields?: string[];
      event?: CreatePackageEventInput;
      outboxExtra?: Array<{
        entityType: 'passport' | 'package_event' | 'return' | 'payment';
        entityId: string;
      }>;
    },
    session?: ClientSession | null
  ): Promise<void> {
    ensureDbReady();
    if (params.returnSet || params.unsetReturnFields?.length) {
      const updateOp: Record<string, unknown> = {};
      if (params.returnSet && Object.keys(params.returnSet).length > 0) {
        const mapped: Record<string, unknown> = { ...params.returnSet };
        if (typeof mapped.pickupId === 'string' && mongoose.Types.ObjectId.isValid(mapped.pickupId)) {
          mapped.pickupId = new mongoose.Types.ObjectId(mapped.pickupId);
        }
        if (
          typeof mapped.assignedPartnerUserId === 'string' &&
          mongoose.Types.ObjectId.isValid(mapped.assignedPartnerUserId)
        ) {
          mapped.assignedPartnerUserId = new mongoose.Types.ObjectId(mapped.assignedPartnerUserId);
        }
        if (
          typeof mapped.collectionCenterId === 'string' &&
          mongoose.Types.ObjectId.isValid(mapped.collectionCenterId)
        ) {
          mapped.collectionCenterId = new mongoose.Types.ObjectId(mapped.collectionCenterId);
        }
        updateOp.$set = mapped;
      }
      if (params.unsetReturnFields && params.unsetReturnFields.length > 0) {
        const unsetObj: Record<string, 1> = {};
        for (const f of params.unsetReturnFields) unsetObj[f] = 1;
        updateOp.$unset = unsetObj;
      }
      await ReturnModel.updateOne(
        { _id: new mongoose.Types.ObjectId(params.returnId) },
        updateOp,
        { session: session ?? undefined }
      );
    }

    if (params.event) {
      const eventId = params.event.eventId ?? `evt_${crypto.randomUUID()}`;
      const merchantObjId =
        params.event.merchantId && mongoose.Types.ObjectId.isValid(params.event.merchantId)
          ? new mongoose.Types.ObjectId(params.event.merchantId)
          : undefined;
      await PackageEventModel.create(
        [
          {
            eventId,
            packageId: params.event.packageId.trim().toUpperCase(),
            ...(merchantObjId ? { merchantId: merchantObjId } : {}),
            ...(params.event.scanId?.trim() ? { scanId: params.event.scanId.trim() } : {}),
            type: params.event.type,
            actor: params.event.actor,
            occurredAt: params.event.occurredAt ?? new Date(),
            sourceSystem: params.event.sourceSystem ?? 'REBOXIFY_API',
            correlationId: params.event.correlationId,
            locationRef: params.event.locationRef,
            outcome: params.event.outcome,
            evidence: params.event.evidence ?? [],
            metadata: params.event.metadata,
          },
        ],
        { session: session ?? undefined }
      );

      await enqueueSearchOutbox(
        [
          { entityType: 'package_event', entityId: eventId },
          { entityType: 'return', entityId: params.returnId },
          { entityType: 'passport', entityId: params.event.packageId.trim().toUpperCase() },
          ...(params.outboxExtra ?? []),
        ],
        session
      );
    }
  }
}
