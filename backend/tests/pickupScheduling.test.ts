import crypto from 'node:crypto';
import { ClientSession } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { signAuthToken } from '../src/middleware/auth.js';
import { AuthService, StoredUserRecord, UserRepository } from '../src/services/authService.js';
import { AuditWriter } from '../src/services/auditService.js';
import { TransactionRunner } from '../src/services/businessService.js';
import { PickupService } from '../src/services/pickupService.js';
import {
  CollectionCentreDto,
  PartnerScheduleDto,
  PickupDto,
  PickupRepository,
} from '../src/repositories/pickupRepository.js';
import { ReturnDto, ReturnRepository } from '../src/repositories/phase5Repositories.js';
import { CreatePackageEventInput } from '../src/repositories/phase4Repositories.js';
import { OrderDto, OrderRepository, PackageDto, PackageRepository } from '../src/repositories/phase2Repositories.js';
import { TransactionDto, TransactionRepository } from '../src/repositories/phase3Repositories.js';
import { ReturnService } from '../src/services/returnService.js';
import { QrService } from '../src/services/qrService.js';
import { OrderStatus } from '../src/types/domain.js';

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

function buildPickupHarness() {
  const users = new Map<string, StoredUserRecord>();
  const packages = new Map<string, PackageDto>();
  const returns = new Map<string, ReturnDto>();
  const pickups = new Map<string, PickupDto>();
  const partnerSchedules = new Map<string, PartnerScheduleDto>();
  const centres = new Map<string, CollectionCentreDto>();
  const orders = new Map<string, OrderDto>();
  const transactions = new Map<string, TransactionDto>();
  const packageEvents: CreatePackageEventInput[] = [];
  const auditEntries: Array<{ action: string; entityType: string; entityId: string }> = [];

  // Serialize partner mutations across concurrent calls just like MongoDB document locking
  let partnerMutex = Promise.resolve();
  const withLock = async <T>(work: () => Promise<T>): Promise<T> => {
    const prev = partnerMutex;
    let release!: () => void;
    partnerMutex = new Promise<void>((res) => {
      release = res;
    });
    await prev;
    try {
      return await work();
    } finally {
      release();
    }
  };

  const runTx: TransactionRunner = async <T>(work: (s: ClientSession | null) => Promise<T>) =>
    withLock(() => work(null));

  const audit: AuditWriter = {
    async record(entry) {
      auditEntries.push({
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
      });
    },
  };

  const qrService = new QrService({
    currentKeyId: 'k1',
    currentSecret: 'pickup-scheduling-test-secret-32chars!',
    defaultTtlSeconds: 86400,
  });

  const userRepo: UserRepository = {
    async findByEmail(email) {
      for (const u of users.values()) if (u.email === email.toLowerCase().trim()) return u;
      return null;
    },
    async findById(id) {
      return users.get(id) ?? null;
    },
    async create(input) {
      const id = newId();
      const rec: StoredUserRecord = { id, ...input };
      users.set(id, rec);
      return rec;
    },
  };

  const packageRepo: PackageRepository = {
    async create(input) {
      const id = newId();
      const dto: PackageDto = { id, ...input, createdAt: new Date(), updatedAt: new Date() };
      packages.set(dto.packageId, dto);
      return dto;
    },
    async findByPackageId(packageId) {
      return packages.get(packageId.toUpperCase()) ?? null;
    },
    async list() {
      const items = Array.from(packages.values());
      return { items, total: items.length, page: 1, pageSize: 25 };
    },
    async findCandidatesForAllocation() {
      return [];
    },
    async reservePackagesAtomically() {
      return [];
    },
  };

  const orderRepo: OrderRepository = {
    async create(input) {
      const id = newId();
      const dto: OrderDto = { id, ...input, createdAt: new Date(), updatedAt: new Date() };
      orders.set(id, dto);
      return dto;
    },
    async findById(id) {
      return orders.get(id) ?? null;
    },
    async list() {
      const items = Array.from(orders.values());
      return { items, total: items.length, page: 1, pageSize: 25 };
    },
    async applyAllocationAtomically() {
      return null;
    },
  };

  const txRepo: TransactionRepository = {
    async create(input) {
      const id = newId();
      const dto: TransactionDto = { id, ...input, createdAt: new Date(), updatedAt: new Date() };
      transactions.set(id, dto);
      return dto;
    },
    async findById(id) {
      return transactions.get(id) ?? null;
    },
    async findByPayPalOrderId() {
      return null;
    },
    async findActiveByOrderId() {
      return null;
    },
    async findLatestByOrderId() {
      return null;
    },
    async list() {
      return { items: [], total: 0, page: 1, pageSize: 25 };
    },
    async transitionState() {
      return null;
    },
    async updateOrderPaymentStatus(_id: string, _status: OrderStatus) {},
  };

  const returnRepo: ReturnRepository = {
    async createReturnWithPackageAtomically(params) {
      const id = newId();
      const rec: ReturnDto = { id, ...params.returnDoc, createdAt: new Date(), updatedAt: new Date() };
      returns.set(id, rec);
      return { returnRecord: rec, package: packages.get(rec.packageId)! };
    },
    async findById(id) {
      return returns.get(id) ?? null;
    },
    async findByReturnNumber(num) {
      for (const r of returns.values()) if (r.returnNumber === num) return r;
      return null;
    },
    async findByOrderAndPackage(orderId, packageId) {
      for (const r of returns.values()) {
        if (r.orderId === orderId && r.packageId === packageId) return r;
      }
      return null;
    },
    async findActiveByPackageId(packageId) {
      for (const r of returns.values()) {
        if (r.packageId === packageId && r.status !== 'CLOSED' && r.status !== 'REJECTED') return r;
      }
      return null;
    },
    async list() {
      const items = Array.from(returns.values());
      return { items, total: items.length, page: 1, pageSize: 25 };
    },
    async transitionReturnAndPackageAtomically(params) {
      const ret = returns.get(params.returnId);
      if (!ret || !params.expectedReturnStatuses.includes(ret.status)) return null;
      Object.assign(ret, params.returnSet, { updatedAt: new Date() });
      const pkg = packages.get(ret.packageId);
      if (params.packageUpdate && pkg) {
        pkg.status = params.packageUpdate.nextStatus;
        if (params.packageUpdate.newCustodian) pkg.currentCustodian = params.packageUpdate.newCustodian;
      }
      if (ret.pickupId && params.returnSet.status === 'COLLECTED') {
        const pk = pickups.get(ret.pickupId);
        if (pk) {
          pk.status = 'COMPLETED';
          pk.version += 1;
        }
      }
      return { returnRecord: ret, package: pkg };
    },
    async appendEvidenceFile() {
      return null;
    },
  };

  const pickupRepo: PickupRepository = {
    async findById(id) {
      return pickups.get(id) ?? null;
    },
    async findByReturnId(returnId) {
      for (const p of pickups.values()) if (p.returnId === returnId) return p;
      return null;
    },
    async list(filters) {
      let items = Array.from(pickups.values());
      if (filters.merchantId) items = items.filter((p) => p.merchantId === filters.merchantId);
      if (filters.customerId) items = items.filter((p) => p.customerId === filters.customerId);
      if (filters.partnerId) items = items.filter((p) => p.partnerId === filters.partnerId);
      if (filters.status) items = items.filter((p) => p.status === filters.status);
      if (filters.serviceZone) {
        items = items.filter((p) => p.serviceZone.toUpperCase() === filters.serviceZone!.toUpperCase());
      }
      if (filters.from) items = items.filter((p) => p.slotEnd >= filters.from!);
      if (filters.to) items = items.filter((p) => p.slotStart <= filters.to!);
      if (filters.search?.trim()) {
        const q = filters.search.trim().toUpperCase();
        items = items.filter(
          (p) =>
            p.packageId.toUpperCase().includes(q) ||
            p.serviceZone.toUpperCase().includes(q) ||
            p.addressSummary.toUpperCase().includes(q) ||
            (p.returnNumber ?? '').toUpperCase().includes(q)
        );
      }
      items.sort((a, b) => a.slotStart.getTime() - b.slotStart.getTime());
      const start = (filters.page - 1) * filters.pageSize;
      return {
        items: items.slice(start, start + filters.pageSize),
        total: items.length,
        page: filters.page,
        pageSize: filters.pageSize,
      };
    },
    async create(input) {
      for (const existing of pickups.values()) {
        if (existing.returnId === input.returnId) {
          throw new Error('Duplicate returnId');
        }
      }
      const id = newId();
      const ret = returns.get(input.returnId);
      const dto: PickupDto = {
        id,
        ...input,
        returnNumber: ret?.returnNumber,
        rescheduleHistory: [],
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      pickups.set(id, dto);
      return dto;
    },
    async updateOptimistic(pickupId, expectedVersion, setFields, options) {
      const current = pickups.get(pickupId);
      if (!current || current.version !== expectedVersion) return null;
      const next: PickupDto = {
        ...current,
        ...setFields,
        rescheduleHistory: options?.pushReschedule
          ? [...current.rescheduleHistory, options.pushReschedule]
          : current.rescheduleHistory,
        version: current.version + 1,
        updatedAt: new Date(),
      } as PickupDto;
      if (options?.unsetFields) {
        for (const key of options.unsetFields) {
          delete (next as any)[key];
        }
      }
      pickups.set(pickupId, next);
      return next;
    },
    async findPartnerSchedule(partnerUserId) {
      const existing = partnerSchedules.get(partnerUserId);
      if (existing) return existing;
      const u = users.get(partnerUserId);
      if (!u || u.role !== 'DELIVERY_PARTNER') return null;
      return {
        userId: u.id,
        displayName: u.name,
        email: u.email,
        serviceZones: [],
        timeZone: 'UTC',
        workingHours: { startHour: 8, endHour: 20, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
        unavailablePeriods: [],
        dailyCapacity: 15,
        maxConcurrentCapacity: 1,
        bookingLockVersion: 0,
        status: 'ACTIVE',
      };
    },
    async lockPartnerForScheduling(partnerUserId, fallbackDisplayName) {
      const sched = (await this.findPartnerSchedule(partnerUserId)) ?? {
        userId: partnerUserId,
        displayName: fallbackDisplayName,
        serviceZones: [],
        timeZone: 'UTC',
        workingHours: { startHour: 8, endHour: 20, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
        unavailablePeriods: [],
        dailyCapacity: 15,
        maxConcurrentCapacity: 1,
        bookingLockVersion: 0,
        status: 'ACTIVE' as const,
      };
      sched.bookingLockVersion += 1;
      partnerSchedules.set(partnerUserId, sched);
      return sched;
    },
    async upsertPartnerSchedule(partnerUserId, input) {
      const cur = await this.lockPartnerForScheduling(partnerUserId, 'Partner');
      const next: PartnerScheduleDto = {
        ...cur,
        ...input,
        workingHours: input.workingHours ?? cur.workingHours,
        unavailablePeriods: input.unavailablePeriods ?? cur.unavailablePeriods,
        serviceZones: input.serviceZones ?? cur.serviceZones,
      };
      partnerSchedules.set(partnerUserId, next);
      return next;
    },
    async listPartnerResources(filters) {
      const out: PartnerScheduleDto[] = [];
      for (const u of users.values()) {
        if (u.role !== 'DELIVERY_PARTNER' || u.status !== 'ACTIVE') continue;
        if (filters?.partnerUserId && u.id !== filters.partnerUserId) continue;
        const sched = await this.findPartnerSchedule(u.id);
        if (!sched) continue;
        if (!filters?.includeUnavailable && sched.status !== 'ACTIVE') continue;
        if (
          filters?.serviceZone &&
          sched.serviceZones.length > 0 &&
          !sched.serviceZones.some((z) => z.toUpperCase() === filters.serviceZone!.toUpperCase())
        ) {
          continue;
        }
        out.push(sched);
      }
      return out;
    },
    async findCollectionCentreById(id) {
      return centres.get(id) ?? null;
    },
    async listCollectionCentres(filters) {
      return Array.from(centres.values()).filter(
        (c) => (!filters?.status || c.status === filters.status)
      );
    },
    async countPartnerOverlappingPickups(partnerUserId, slotStart, slotEnd, excludePickupId) {
      let count = 0;
      for (const p of pickups.values()) {
        if (excludePickupId && p.id === excludePickupId) continue;
        if (['CANCELLED', 'COMPLETED', 'MISSED'].includes(p.status)) continue;
        if (p.partnerId === partnerUserId && p.slotStart < slotEnd && p.slotEnd > slotStart) {
          count += 1;
        }
      }
      return count;
    },
    async countPartnerPickupsInRange(partnerUserId, rangeStart, rangeEnd, excludePickupId) {
      let count = 0;
      for (const p of pickups.values()) {
        if (excludePickupId && p.id === excludePickupId) continue;
        if (p.status === 'CANCELLED') continue;
        if (p.partnerId === partnerUserId && p.slotStart >= rangeStart && p.slotStart < rangeEnd) {
          count += 1;
        }
      }
      return count;
    },
    async countCentreOverlappingPickups(centreId, slotStart, slotEnd, excludePickupId) {
      let count = 0;
      for (const p of pickups.values()) {
        if (excludePickupId && p.id === excludePickupId) continue;
        if (['CANCELLED', 'COMPLETED'].includes(p.status)) continue;
        if (p.collectionCenterId === centreId && p.slotStart < slotEnd && p.slotEnd > slotStart) {
          count += 1;
        }
      }
      return count;
    },
    async syncReturnAndRecordEvent(params) {
      const ret = returns.get(params.returnId);
      if (ret && params.returnSet) {
        if (params.returnSet.pickupId) ret.pickupId = String(params.returnSet.pickupId);
        if (params.returnSet.status) ret.status = params.returnSet.status as any;
        if (params.returnSet.assignedPartnerUserId) {
          ret.assignedPartnerUserId = String(params.returnSet.assignedPartnerUserId);
        }
        if (params.returnSet.assignedPartnerName) {
          ret.assignedPartnerName = String(params.returnSet.assignedPartnerName);
        }
      }
      if (params.event) packageEvents.push(params.event);
    },
  };

  const authService = new AuthService(userRepo, audit);
  const passportRepo = {
    async recordEvent(evt: CreatePackageEventInput) {
      packageEvents.push(evt);
    },
    async findEventByScanId() {
      return null;
    },
    async findUserSummary(id: string) {
      return users.get(id) ?? null;
    },
  } as any;

  const returnService = new ReturnService(
    returnRepo,
    undefined as any,
    orderRepo,
    packageRepo,
    undefined as any,
    txRepo,
    passportRepo,
    {} as any,
    {} as any,
    qrService,
    audit,
    runTx
  );

  const pickupService = new PickupService(
    pickupRepo,
    returnRepo,
    audit,
    runTx,
    returnService
  );

  const app = createApp({ authService, returnService, pickupService });

  return {
    app,
    authService,
    qrService,
    users,
    packages,
    returns,
    pickups,
    partnerSchedules,
    centres,
    packageEvents,
    auditEntries,
  };
}

async function seedActors(h: ReturnType<typeof buildPickupHarness>) {
  const mkUser = async (
    email: string,
    role: StoredUserRecord['role'],
    name: string,
    businessId?: string,
    collectionCenterId?: string
  ) => {
    const id = newId();
    const u: StoredUserRecord = {
      id,
      name,
      email,
      passwordHash: 'hashed',
      role,
      status: 'ACTIVE',
      businessId,
      collectionCenterId,
    };
    h.users.set(id, u);
    const token = signAuthToken({
      userId: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      businessId: u.businessId,
      collectionCenterId: u.collectionCenterId,
    });
    return { ...u, token };
  };

  const merchantAId = newId();
  const merchantBId = newId();
  const centreId = newId();

  const admin = await mkUser('admin@reboxify.test', 'ADMIN', 'Super Admin');
  const merchantAdminA = await mkUser('merchant-a@reboxify.test', 'MERCHANT_ADMIN', 'Merchant A', merchantAId);
  const merchantAdminB = await mkUser('merchant-b@reboxify.test', 'MERCHANT_ADMIN', 'Merchant B', merchantBId);
  const centreOp = await mkUser('centre@reboxify.test', 'COLLECTION_CENTRE', 'Centre Op', undefined, centreId);
  const partner1 = await mkUser('driver1@reboxify.test', 'DELIVERY_PARTNER', 'Driver Alpha');
  const partner2 = await mkUser('driver2@reboxify.test', 'DELIVERY_PARTNER', 'Driver Beta');
  const customer1 = await mkUser('cust1@reboxify.test', 'CUSTOMER', 'Customer One');
  const customer2 = await mkUser('cust2@reboxify.test', 'CUSTOMER', 'Customer Two');

  h.centres.set(centreId, {
    id: centreId,
    code: 'HUB-CENTRAL',
    name: 'Central Hub',
    operatorUserId: centreOp.id,
    address: '10 Green Lane',
    serviceZones: ['CENTRAL', 'NORTH'],
    hours: '08:00-20:00',
    capacity: 20,
    currentWorkload: 0,
    status: 'ACTIVE',
  });

  h.partnerSchedules.set(partner1.id, {
    userId: partner1.id,
    displayName: partner1.name,
    email: partner1.email,
    serviceZones: ['CENTRAL'],
    timeZone: 'UTC',
    workingHours: { startHour: 9, endHour: 17, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
    unavailablePeriods: [
      {
        start: new Date('2026-12-01T12:00:00.000Z'),
        end: new Date('2026-12-01T13:00:00.000Z'),
        reason: 'Lunch break',
      },
    ],
    dailyCapacity: 2,
    maxConcurrentCapacity: 1,
    bookingLockVersion: 0,
    status: 'ACTIVE',
  });

  h.partnerSchedules.set(partner2.id, {
    userId: partner2.id,
    displayName: partner2.name,
    email: partner2.email,
    serviceZones: ['NORTH', 'CENTRAL'],
    timeZone: 'UTC',
    workingHours: { startHour: 8, endHour: 20, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
    unavailablePeriods: [],
    dailyCapacity: 5,
    maxConcurrentCapacity: 2,
    bookingLockVersion: 0,
    status: 'ACTIVE',
  });

  return {
    merchantAId,
    merchantBId,
    centreId,
    admin,
    merchantAdminA,
    merchantAdminB,
    centreOp,
    partner1,
    partner2,
    customer1,
    customer2,
  };
}

function seedEligibleReturn(
  h: ReturnType<typeof buildPickupHarness>,
  params: {
    merchantId: string;
    customerId: string;
    packageId: string;
    returnNumber: string;
  }
) {
  const pkgRef = newId();
  const orderId = newId();
  const returnId = newId();
  const issued = h.qrService.issuePackageToken(params.packageId, 1);

  h.packages.set(params.packageId, {
    id: pkgRef,
    packageId: params.packageId,
    qrTokenHash: issued.tokenHash,
    qrTokenVersion: 1,
    qrRevoked: false,
    ownerType: 'REBOXIFY_POOL',
    packageClass: 'M',
    dimensionsCm: { length: 30, width: 20, height: 15 },
    maxWeightKg: 10,
    protectionCategory: 'STANDARD',
    supportsLiquidContainment: false,
    material: 'REUSABLE_PP',
    replacementValue: 20,
    depositAmount: 5,
    currency: 'USD',
    status: 'RETURN_REQUESTED',
    condition: 'GOOD',
    reuseCount: 1,
    maxLifecycleLimit: 50,
    fulfilmentLocation: 'HUB-CENTRAL',
    currentCustodian: {
      custodianType: 'CUSTOMER',
      custodianId: params.customerId,
      label: 'Customer',
      assignedAt: new Date(),
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  h.returns.set(returnId, {
    id: returnId,
    returnNumber: params.returnNumber,
    orderId,
    packageRef: pkgRef,
    packageId: params.packageId,
    merchantId: params.merchantId,
    customerId: params.customerId,
    mode: 'PICKUP',
    status: 'REQUESTED',
    isLateReturn: false,
    daysLate: 0,
    disputed: false,
    evidenceFiles: [],
    refundEligibility: {
      eligible: true,
      originalDeposit: 5,
      totalDeductions: 0,
      calculatedAmount: 5,
      currency: 'USD',
      deductionBreakdown: [],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { returnId, qrToken: issued.token, packageId: params.packageId };
}

describe('Pickup Scheduling & Bryntum Backend API', () => {
  it('enforces working hours, unavailable periods, service zones, overlap & daily capacity, self-reschedule, and QR-verified completion', async () => {
    const h = buildPickupHarness();
    const actors = await seedActors(h);
    const r1 = seedEligibleReturn(h, {
      merchantId: actors.merchantAId,
      customerId: actors.customer1.id,
      packageId: 'RBX-PK-001',
      returnNumber: 'RET-PK-001',
    });
    const r2 = seedEligibleReturn(h, {
      merchantId: actors.merchantAId,
      customerId: actors.customer2.id,
      packageId: 'RBX-PK-002',
      returnNumber: 'RET-PK-002',
    });
    const r3 = seedEligibleReturn(h, {
      merchantId: actors.merchantAId,
      customerId: actors.customer2.id,
      packageId: 'RBX-PK-003',
      returnNumber: 'RET-PK-003',
    });

    // 1. Customer cannot assign a partner directly when creating a pickup
    const custAssignAttempt = await request(h.app)
      .post('/api/pickups')
      .set('Authorization', `Bearer ${actors.customer1.token}`)
      .send({
        returnId: r1.returnId,
        partnerId: actors.partner1.id,
        slotStart: '2026-12-01T09:00:00.000Z',
        slotEnd: '2026-12-01T11:00:00.000Z',
        serviceZone: 'CENTRAL',
        addressSummary: '101 Eco St',
      });
    expect(custAssignAttempt.status).toBe(403);

    // 2. Customer creates an UNASSIGNED pickup cleanly
    const createRes = await request(h.app)
      .post('/api/pickups')
      .set('Authorization', `Bearer ${actors.customer1.token}`)
      .send({
        returnId: r1.returnId,
        collectionCenterId: actors.centreId,
        slotStart: '2026-12-01T09:00:00.000Z',
        slotEnd: '2026-12-01T11:00:00.000Z',
        serviceZone: 'CENTRAL',
        addressSummary: '101 Eco St',
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.pickup.status).toBe('UNASSIGNED');
    const pickup1Id = createRes.body.pickup.id;

    // 3. Reject assigning Partner 1 to wrong zone
    const rNorth = seedEligibleReturn(h, {
      merchantId: actors.merchantAId,
      customerId: actors.customer2.id,
      packageId: 'RBX-PK-NORTH',
      returnNumber: 'RET-NORTH',
    });
    const northPickupRes = await request(h.app)
      .post('/api/pickups')
      .set('Authorization', `Bearer ${actors.admin.token}`)
      .send({
        returnId: rNorth.returnId,
        partnerId: actors.partner1.id,
        slotStart: '2026-12-01T14:00:00.000Z',
        slotEnd: '2026-12-01T15:00:00.000Z',
        serviceZone: 'NORTH',
        addressSummary: '22 North Ave',
      });
    expect(northPickupRes.status).toBe(409);
    expect(northPickupRes.body.error.code).toBe('PARTNER_ZONE_MISMATCH');

    // 4. Reject slot outside Partner 1 working hours (17:00+ in UTC)
    const lateAssign = await request(h.app)
      .patch(`/api/pickups/${pickup1Id}`)
      .set('Authorization', `Bearer ${actors.admin.token}`)
      .send({
        partnerId: actors.partner1.id,
        slotStart: '2026-12-01T17:00:00.000Z',
        slotEnd: '2026-12-01T19:00:00.000Z',
      });
    expect(lateAssign.status).toBe(409);
    expect(lateAssign.body.error.code).toBe('PARTNER_OUTSIDE_WORKING_HOURS');

    // 5. Reject slot overlapping Partner 1 unavailablePeriod (12:00-13:00 UTC)
    const lunchConflict = await request(h.app)
      .patch(`/api/pickups/${pickup1Id}`)
      .set('Authorization', `Bearer ${actors.admin.token}`)
      .send({
        partnerId: actors.partner1.id,
        slotStart: '2026-12-01T11:30:00.000Z',
        slotEnd: '2026-12-01T13:00:00.000Z',
      });
    expect(lunchConflict.status).toBe(409);
    expect(lunchConflict.body.error.code).toBe('PARTNER_UNAVAILABLE');

    // 6. Valid assignment of Partner 1 at 09:00-11:00 UTC
    const assignOk = await request(h.app)
      .post(`/api/pickups/${pickup1Id}/assign`)
      .set('Authorization', `Bearer ${actors.centreOp.token}`)
      .send({ partnerId: actors.partner1.id });
    expect(assignOk.status).toBe(200);
    expect(assignOk.body.pickup.status).toBe('ASSIGNED');
    expect(assignOk.body.pickup.version).toBe(2);

    // 7. Concurrent capacity conflict: scheduling Pickup 2 on Partner 1 overlapping 10:00-11:30 fails
    const overlapCreate = await request(h.app)
      .post('/api/pickups')
      .set('Authorization', `Bearer ${actors.merchantAdminA.token}`)
      .send({
        returnId: r2.returnId,
        partnerId: actors.partner1.id,
        slotStart: '2026-12-01T10:00:00.000Z',
        slotEnd: '2026-12-01T11:30:00.000Z',
        serviceZone: 'CENTRAL',
        addressSummary: '202 Overlap Rd',
      });
    expect(overlapCreate.status).toBe(409);
    expect(overlapCreate.body.error.code).toBe('PICKUP_OVERLAP_CONFLICT');

    // 8. Reschedule Pickup 1 slightly later (10:00-11:30) — MUST NOT conflict with itself!
    const selfReschedule = await request(h.app)
      .post(`/api/pickups/${pickup1Id}/reschedule`)
      .set('Authorization', `Bearer ${actors.admin.token}`)
      .send({
        slotStart: '2026-12-01T10:00:00.000Z',
        slotEnd: '2026-12-01T11:30:00.000Z',
        reason: 'Customer requested 1hr shift',
        expectedVersion: 2,
      });
    expect(selfReschedule.status).toBe(200);
    expect(selfReschedule.body.pickup.status).toBe('RESCHEDULED');
    expect(selfReschedule.body.pickup.version).toBe(3);
    expect(selfReschedule.body.pickup.rescheduleHistory).toHaveLength(1);

    // 9. Stale expectedVersion check rejects with OPTIMISTIC_LOCK_CONFLICT
    const staleUpdate = await request(h.app)
      .patch(`/api/pickups/${pickup1Id}`)
      .set('Authorization', `Bearer ${actors.admin.token}`)
      .send({ notes: 'Stale edit', expectedVersion: 2 });
    expect(staleUpdate.status).toBe(409);
    expect(staleUpdate.body.error.code).toBe('OPTIMISTIC_LOCK_CONFLICT');

    // 10. Non-overlapping Pickup 2 fills Partner 1's dailyCapacity = 2 (at 14:00-15:30 UTC)
    const p2Create = await request(h.app)
      .post('/api/pickups')
      .set('Authorization', `Bearer ${actors.admin.token}`)
      .send({
        returnId: r2.returnId,
        partnerId: actors.partner1.id,
        slotStart: '2026-12-01T14:00:00.000Z',
        slotEnd: '2026-12-01T15:30:00.000Z',
        serviceZone: 'CENTRAL',
        addressSummary: '202 NonOverlap Ave',
      });
    expect(p2Create.status).toBe(201);

    // 11. Third pickup on same day for Partner 1 exceeds dailyCapacity (2)
    const p3DailyExceeded = await request(h.app)
      .post('/api/pickups')
      .set('Authorization', `Bearer ${actors.admin.token}`)
      .send({
        returnId: r3.returnId,
        partnerId: actors.partner1.id,
        slotStart: '2026-12-01T15:30:00.000Z',
        slotEnd: '2026-12-01T16:30:00.000Z',
        serviceZone: 'CENTRAL',
        addressSummary: '303 Cap Blvd',
      });
    expect(p3DailyExceeded.status).toBe(409);
    expect(p3DailyExceeded.body.error.code).toBe('PARTNER_DAILY_CAPACITY_EXCEEDED');

    // 12. Completing pickup requires valid signed QR token (rejects bad token, accepts valid token)
    const badComplete = await request(h.app)
      .post(`/api/pickups/${pickup1Id}/complete`)
      .set('Authorization', `Bearer ${actors.partner1.token}`)
      .send({ scanMode: 'QR_TOKEN', qrToken: 'FORGED.TOKEN' });
    expect(badComplete.status).toBe(401);

    const goodComplete = await request(h.app)
      .post(`/api/pickups/${pickup1Id}/complete`)
      .set('Authorization', `Bearer ${actors.partner1.token}`)
      .send({ scanMode: 'QR_TOKEN', qrToken: r1.qrToken, locationRef: 'Doorstep-101' });
    expect(goodComplete.status).toBe(200);
    expect(goodComplete.body.pickup.status).toBe('COMPLETED');
    expect(goodComplete.body.returnRecord.status).toBe('COLLECTED');
    expect(h.packages.get(r1.packageId)?.status).toBe('COLLECTED');
  });

  it('prevents concurrent race condition when two bookings contend for last capacity slot', async () => {
    const h = buildPickupHarness();
    const actors = await seedActors(h);
    // Reduce Partner 2 to maxConcurrentCapacity = 1 for strict contention test
    h.partnerSchedules.get(actors.partner2.id)!.maxConcurrentCapacity = 1;

    const rA = seedEligibleReturn(h, {
      merchantId: actors.merchantAId,
      customerId: actors.customer1.id,
      packageId: 'RBX-RACE-1',
      returnNumber: 'RET-RACE-1',
    });
    const rB = seedEligibleReturn(h, {
      merchantId: actors.merchantAId,
      customerId: actors.customer2.id,
      packageId: 'RBX-RACE-2',
      returnNumber: 'RET-RACE-2',
    });

    const [resA, resB] = await Promise.all([
      request(h.app)
        .post('/api/pickups')
        .set('Authorization', `Bearer ${actors.admin.token}`)
        .send({
          returnId: rA.returnId,
          partnerId: actors.partner2.id,
          slotStart: '2026-12-02T10:00:00.000Z',
          slotEnd: '2026-12-02T12:00:00.000Z',
          serviceZone: 'CENTRAL',
          addressSummary: 'Race A St',
        }),
      request(h.app)
        .post('/api/pickups')
        .set('Authorization', `Bearer ${actors.admin.token}`)
        .send({
          returnId: rB.returnId,
          partnerId: actors.partner2.id,
          slotStart: '2026-12-02T10:30:00.000Z',
          slotEnd: '2026-12-02T12:00:00.000Z',
          serviceZone: 'CENTRAL',
          addressSummary: 'Race B St',
        }),
    ]);

    const statuses = [resA.status, resB.status].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 409]);
  });

  it('enforces RBAC & tenant isolation on pickup list, resources, and cancel operations', async () => {
    const h = buildPickupHarness();
    const actors = await seedActors(h);
    const rA = seedEligibleReturn(h, {
      merchantId: actors.merchantAId,
      customerId: actors.customer1.id,
      packageId: 'RBX-TEN-A',
      returnNumber: 'RET-TEN-A',
    });
    const rB = seedEligibleReturn(h, {
      merchantId: actors.merchantBId,
      customerId: actors.customer2.id,
      packageId: 'RBX-TEN-B',
      returnNumber: 'RET-TEN-B',
    });

    const createdA = await request(h.app)
      .post('/api/pickups')
      .set('Authorization', `Bearer ${actors.merchantAdminA.token}`)
      .send({
        returnId: rA.returnId,
        partnerId: actors.partner2.id,
        slotStart: '2026-12-03T10:00:00.000Z',
        slotEnd: '2026-12-03T12:00:00.000Z',
        serviceZone: 'CENTRAL',
        addressSummary: 'Merchant A Address',
      });
    expect(createdA.status).toBe(201);

    const createdB = await request(h.app)
      .post('/api/pickups')
      .set('Authorization', `Bearer ${actors.merchantAdminB.token}`)
      .send({
        returnId: rB.returnId,
        slotStart: '2026-12-03T13:00:00.000Z',
        slotEnd: '2026-12-03T15:00:00.000Z',
        serviceZone: 'NORTH',
        addressSummary: 'Merchant B Address',
      });
    expect(createdB.status).toBe(201);

    // Merchant A only sees Merchant A's pickup, and gets 403 trying to view or cancel Merchant B's pickup
    const listA = await request(h.app)
      .get('/api/pickups')
      .set('Authorization', `Bearer ${actors.merchantAdminA.token}`);
    expect(listA.status).toBe(200);
    expect(listA.body.items).toHaveLength(1);
    expect(listA.body.items[0].packageId).toBe('RBX-TEN-A');

    const crossTenantGet = await request(h.app)
      .get(`/api/pickups/${createdB.body.pickup.id}`)
      .set('Authorization', `Bearer ${actors.merchantAdminA.token}`);
    expect(crossTenantGet.status).toBe(403);

    const crossTenantCancel = await request(h.app)
      .post(`/api/pickups/${createdB.body.pickup.id}/cancel`)
      .set('Authorization', `Bearer ${actors.merchantAdminA.token}`)
      .send({ reason: 'Unauthorized attempt' });
    expect(crossTenantCancel.status).toBe(403);

    // Customer resources call hides raw partner PII while returning availableSlots
    const custResources = await request(h.app)
      .get('/api/pickups/resources?date=2026-12-04&serviceZone=CENTRAL')
      .set('Authorization', `Bearer ${actors.customer1.token}`);
    expect(custResources.status).toBe(200);
    expect(custResources.body.partners).toEqual([]);
    expect(Array.isArray(custResources.body.availableSlots)).toBe(true);
    expect(custResources.body.availableSlots.length).toBeGreaterThan(0);

    // Delivery partner can update their own availability schedule, but not another partner's
    const ownSched = await request(h.app)
      .patch(`/api/pickups/partners/${actors.partner1.id}/schedule`)
      .set('Authorization', `Bearer ${actors.partner1.token}`)
      .send({ dailyCapacity: 10 });
    expect(ownSched.status).toBe(200);
    expect(ownSched.body.partner.dailyCapacity).toBe(10);

    const otherSched = await request(h.app)
      .patch(`/api/pickups/partners/${actors.partner2.id}/schedule`)
      .set('Authorization', `Bearer ${actors.partner1.token}`)
      .send({ dailyCapacity: 1 });
    expect(otherSched.status).toBe(403);
  });
});

