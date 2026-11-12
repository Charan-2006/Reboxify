import crypto from 'node:crypto';
import {
  MongooseReturnRepository,
  ReturnDto,
  ReturnRepository,
} from '../repositories/phase5Repositories.js';
import {
  defaultTransactionRunner,
  PaginatedResult,
} from '../repositories/phase2Repositories.js';
import {
  CollectionCentreDto,
  MongoosePickupRepository,
  PartnerScheduleDto,
  PickupDto,
  PickupRepository,
} from '../repositories/pickupRepository.js';
import { pickupStateMachine } from '../stateMachines/machines.js';
import { AuthPrincipal, PickupStatus, ReturnMode } from '../types/domain.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { AuditWriter, defaultAuditWriter } from './auditService.js';
import { TransactionRunner } from './businessService.js';
import { ReturnQrActionInput, ReturnService } from './returnService.js';

export interface CreatePickupInput {
  returnId: string;
  collectionCenterId?: string;
  partnerId?: string;
  slotStart: string;
  slotEnd: string;
  timeZone?: string;
  pickupMethod?: ReturnMode;
  serviceZone: string;
  addressSummary: string;
  location?: { lat: number; lng: number };
  notes?: string;
}

export interface UpdatePickupInput {
  slotStart?: string;
  slotEnd?: string;
  timeZone?: string;
  partnerId?: string | null;
  collectionCenterId?: string | null;
  serviceZone?: string;
  addressSummary?: string;
  location?: { lat: number; lng: number };
  status?: PickupStatus;
  notes?: string;
  missedReason?: string;
  reason?: string;
  expectedVersion?: number;
}

export interface PartnerAvailabilitySlot {
  slotStart: string;
  slotEnd: string;
  availablePartners: number;
  serviceZone?: string;
}

export interface PickupResourcesResponse {
  roleScope: string;
  partners: Array<
    PartnerScheduleDto & {
      activeLoad?: number;
    }
  >;
  collectionCentres: CollectionCentreDto[];
  availableSlots?: PartnerAvailabilitySlot[];
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getZonedDateParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
  second: number;
  dayKey: string;
} {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw badRequest(`Invalid IANA time zone "${timeZone}".`);
  }

  const parts = formatter.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    map[part.type] = part.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour === '24' ? '0' : map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);
  const weekday = WEEKDAY_INDEX[map.weekday ?? 'Sun'] ?? date.getUTCDay();
  const dayKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { year, month, day, weekday, hour, minute, second, dayKey };
}

function getLocalDayBoundsUtc(referenceDate: Date, timeZone: string): { startUtc: Date; endUtc: Date } {
  const tz = timeZone || 'UTC';
  const parts = getZonedDateParts(referenceDate, tz);

  // Determine exact UTC instant corresponding to 00:00:00 of local calendar date
  const approxMidnight = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
  const atRefUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  );
  const offsetMs = atRefUtc - Math.floor(referenceDate.getTime() / 1000) * 1000;
  let startMs = approxMidnight - offsetMs;

  // Refine once for DST transitions
  const check = getZonedDateParts(new Date(startMs), tz);
  if (check.hour !== 0 || check.minute !== 0) {
    const checkUtc = Date.UTC(
      check.year,
      check.month - 1,
      check.day,
      check.hour,
      check.minute,
      check.second,
      0
    );
    const desiredUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
    startMs += desiredUtc - checkUtc;
  }

  return {
    startUtc: new Date(startMs),
    endUtc: new Date(startMs + 24 * 60 * 60 * 1000),
  };
}

function validateSlotWindow(startInput: Date | string, endInput: Date | string): {
  slotStart: Date;
  slotEnd: Date;
} {
  const slotStart = new Date(startInput);
  const slotEnd = new Date(endInput);
  if (Number.isNaN(slotStart.getTime()) || Number.isNaN(slotEnd.getTime())) {
    throw badRequest('Invalid slotStart or slotEnd timestamp.');
  }
  const durationMs = slotEnd.getTime() - slotStart.getTime();
  if (durationMs < 15 * 60 * 1000) {
    throw badRequest('Pickup window must be at least 15 minutes long.');
  }
  if (durationMs > 8 * 60 * 60 * 1000) {
    throw badRequest('Pickup window cannot exceed 8 hours.');
  }
  return { slotStart, slotEnd };
}

function assertPartnerScheduleCompatible(
  partner: PartnerScheduleDto,
  slotStart: Date,
  slotEnd: Date,
  serviceZone: string
): void {
  if (partner.status !== 'ACTIVE') {
    throw conflict(`Delivery partner "${partner.displayName}" is currently ${partner.status}.`);
  }

  const zone = serviceZone.trim().toUpperCase();
  if (
    partner.serviceZones.length > 0 &&
    !partner.serviceZones.some((z) => {
      const normalized = z.trim().toUpperCase();
      return normalized === '*' || normalized === 'ALL' || normalized === zone;
    })
  ) {
    throw conflict(
      `Delivery partner "${partner.displayName}" does not cover service zone "${serviceZone}".`,
      'PARTNER_ZONE_MISMATCH'
    );
  }

  const tz = partner.timeZone || 'UTC';
  const startParts = getZonedDateParts(slotStart, tz);
  const endParts = getZonedDateParts(slotEnd, tz);

  if (!partner.workingHours.daysOfWeek.includes(startParts.weekday)) {
    throw conflict(
      `Delivery partner "${partner.displayName}" does not work on that weekday (${tz}).`,
      'PARTNER_OUTSIDE_WORKING_DAYS'
    );
  }

  const startMinutes = startParts.hour * 60 + startParts.minute;
  let endMinutes = endParts.hour * 60 + endParts.minute;
  if (startParts.dayKey !== endParts.dayKey) {
    // Allow exact end-of-day midnight (00:00 of next day when endHour === 24)
    const startMidnight = Date.UTC(startParts.year, startParts.month - 1, startParts.day);
    const endMidnight = Date.UTC(endParts.year, endParts.month - 1, endParts.day);
    const dayDiff = Math.round((endMidnight - startMidnight) / (24 * 60 * 60 * 1000));
    if (dayDiff === 1 && endMinutes === 0 && partner.workingHours.endHour === 24) {
      endMinutes = 24 * 60;
    } else {
      throw conflict(
        `Pickup window must fall within "${partner.displayName}" working hours (${partner.workingHours.startHour}:00–${partner.workingHours.endHour}:00 ${tz}).`,
        'PARTNER_OUTSIDE_WORKING_HOURS'
      );
    }
  }

  if (
    startMinutes < partner.workingHours.startHour * 60 ||
    endMinutes > partner.workingHours.endHour * 60
  ) {
    throw conflict(
      `Pickup window (${String(startParts.hour).padStart(2, '0')}:${String(startParts.minute).padStart(2, '0')}–${String(endParts.hour).padStart(2, '0')}:${String(endParts.minute).padStart(2, '0')} ${tz}) is outside "${partner.displayName}" working hours (${partner.workingHours.startHour}:00–${partner.workingHours.endHour}:00).`,
      'PARTNER_OUTSIDE_WORKING_HOURS'
    );
  }

  for (const period of partner.unavailablePeriods ?? []) {
    const pStart = new Date(period.start);
    const pEnd = new Date(period.end);
    if (pStart < slotEnd && pEnd > slotStart) {
      throw conflict(
        `Delivery partner "${partner.displayName}" is unavailable during the requested slot${period.reason ? ` (${period.reason})` : ''}.`,
        'PARTNER_UNAVAILABLE'
      );
    }
  }
}

export class PickupService {
  constructor(
    private readonly pickups: PickupRepository = new MongoosePickupRepository(),
    private readonly returns: ReturnRepository = new MongooseReturnRepository(),
    private readonly audit: AuditWriter = defaultAuditWriter,
    private readonly runTx: TransactionRunner = defaultTransactionRunner,
    private readonly returnService?: ReturnService
  ) {}

  private assertPickupReadAccess(caller: AuthPrincipal, pickup: PickupDto): void {
    if (caller.role === 'ADMIN') return;
    if (caller.role === 'CUSTOMER') {
      if (pickup.customerId !== caller.userId) {
        throw forbidden('Cannot access another customer pickup appointment.');
      }
      return;
    }
    if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      if (!caller.businessId || pickup.merchantId !== caller.businessId) {
        throw forbidden('Cannot access pickups belonging to another merchant.');
      }
      return;
    }
    if (caller.role === 'DELIVERY_PARTNER') {
      if (pickup.partnerId !== caller.userId) {
        throw forbidden('Delivery partner can only view assigned pickups.');
      }
      return;
    }
    if (caller.role === 'COLLECTION_CENTRE') {
      if (
        caller.collectionCenterId &&
        pickup.collectionCenterId &&
        pickup.collectionCenterId !== caller.collectionCenterId
      ) {
        throw forbidden('Cannot access pickups assigned to another collection centre.');
      }
      return;
    }
    throw forbidden('Unauthorized role for pickup access.');
  }

  private async validatePartnerCapacityInTx(
    partnerUserId: string,
    fallbackName: string,
    slotStart: Date,
    slotEnd: Date,
    serviceZone: string,
    excludePickupId: string | undefined,
    session: any
  ): Promise<PartnerScheduleDto> {
    const lockedPartner = await this.pickups.lockPartnerForScheduling(
      partnerUserId,
      fallbackName,
      session
    );

    assertPartnerScheduleCompatible(lockedPartner, slotStart, slotEnd, serviceZone);

    const overlapping = await this.pickups.countPartnerOverlappingPickups(
      partnerUserId,
      slotStart,
      slotEnd,
      excludePickupId,
      session
    );
    if (overlapping >= (lockedPartner.maxConcurrentCapacity ?? 1)) {
      throw conflict(
        `Scheduling conflict: "${lockedPartner.displayName}" already has ${overlapping}/${lockedPartner.maxConcurrentCapacity ?? 1} overlapping pickup(s) in this window.`,
        'PICKUP_OVERLAP_CONFLICT'
      );
    }

    const { startUtc, endUtc } = getLocalDayBoundsUtc(slotStart, lockedPartner.timeZone);
    const dailyCount = await this.pickups.countPartnerPickupsInRange(
      partnerUserId,
      startUtc,
      endUtc,
      excludePickupId,
      session
    );
    if (dailyCount >= lockedPartner.dailyCapacity) {
      throw conflict(
        `Daily capacity exceeded: "${lockedPartner.displayName}" has ${dailyCount}/${lockedPartner.dailyCapacity} pickups scheduled on that day.`,
        'PARTNER_DAILY_CAPACITY_EXCEEDED'
      );
    }

    return lockedPartner;
  }

  async listPickups(
    params: {
      merchantId?: string;
      status?: PickupStatus;
      serviceZone?: string;
      partnerId?: string;
      collectionCenterId?: string;
      from?: string;
      to?: string;
      search?: string;
      page: number;
      pageSize: number;
      sortBy?: string;
      sortDir?: 'asc' | 'desc';
    },
    caller: AuthPrincipal
  ): Promise<PaginatedResult<PickupDto>> {
    const fromDate = params.from ? new Date(params.from) : undefined;
    const toDate = params.to ? new Date(params.to) : undefined;
    if (fromDate && Number.isNaN(fromDate.getTime())) throw badRequest('Invalid "from" date filter.');
    if (toDate && Number.isNaN(toDate.getTime())) throw badRequest('Invalid "to" date filter.');

    const base = {
      status: params.status,
      serviceZone: params.serviceZone,
      from: fromDate,
      to: toDate,
      search: params.search,
      page: params.page,
      pageSize: params.pageSize,
      sortBy: params.sortBy,
      sortDir: params.sortDir,
    };

    if (caller.role === 'ADMIN') {
      return this.pickups.list({
        ...base,
        merchantId: params.merchantId,
        partnerId: params.partnerId,
        collectionCenterId: params.collectionCenterId,
      });
    }

    if (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') {
      if (!caller.businessId) throw forbidden('Merchant account is not linked to a business.');
      return this.pickups.list({
        ...base,
        merchantId: caller.businessId,
        partnerId: params.partnerId,
        collectionCenterId: params.collectionCenterId,
      });
    }

    if (caller.role === 'COLLECTION_CENTRE') {
      return this.pickups.list({
        ...base,
        partnerId: params.partnerId,
        collectionCenterId: caller.collectionCenterId ?? params.collectionCenterId,
        includeUnassignedForCentre: Boolean(caller.collectionCenterId),
      });
    }

    if (caller.role === 'DELIVERY_PARTNER') {
      return this.pickups.list({
        ...base,
        partnerId: caller.userId,
      });
    }

    if (caller.role === 'CUSTOMER') {
      return this.pickups.list({
        ...base,
        customerId: caller.userId,
      });
    }

    throw forbidden('Unauthorized role for listing pickups.');
  }

  async listResources(
    params: {
      serviceZone?: string;
      date?: string;
      includeSlots?: boolean;
    },
    caller: AuthPrincipal
  ): Promise<PickupResourcesResponse> {
    const [partners, centres] = await Promise.all([
      this.pickups.listPartnerResources({
        serviceZone: params.serviceZone,
        partnerUserId: caller.role === 'DELIVERY_PARTNER' ? caller.userId : undefined,
        includeUnavailable: caller.role === 'ADMIN' || caller.role === 'COLLECTION_CENTRE',
      }),
      this.pickups.listCollectionCentres({
        serviceZone: params.serviceZone,
        status: caller.role === 'CUSTOMER' ? 'ACTIVE' : undefined,
      }),
    ]);

    let availableSlots: PartnerAvailabilitySlot[] | undefined;
    if (params.includeSlots || params.date || caller.role === 'CUSTOMER') {
      const targetDate = params.date ? new Date(params.date) : new Date(Date.now() + 24 * 60 * 60 * 1000);
      if (Number.isNaN(targetDate.getTime())) {
        throw badRequest('Invalid availability date query.');
      }
      const activePartners = partners.filter((p) => p.status === 'ACTIVE');
      const dayStart = new Date(targetDate);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      const existingResult = await this.pickups.list({
        from: dayStart,
        to: dayEnd,
        page: 1,
        pageSize: 200,
      });
      const activeBookings = existingResult.items.filter(
        (b) => !['CANCELLED', 'COMPLETED', 'MISSED'].includes(b.status)
      );

      availableSlots = [];
      for (const hour of [9, 11, 13, 15, 17]) {
        const sStart = new Date(dayStart.getTime() + hour * 60 * 60 * 1000);
        const sEnd = new Date(sStart.getTime() + 2 * 60 * 60 * 1000);
        let readyCount = 0;
        for (const partner of activePartners) {
          try {
            assertPartnerScheduleCompatible(
              partner,
              sStart,
              sEnd,
              params.serviceZone || partner.serviceZones[0] || 'GENERAL'
            );
            const partnerOverlap = activeBookings.filter(
              (b) => b.partnerId === partner.userId && b.slotStart < sEnd && b.slotEnd > sStart
            ).length;
            const partnerDayCount = activeBookings.filter((b) => b.partnerId === partner.userId).length;
            if (
              partnerOverlap < (partner.maxConcurrentCapacity ?? 1) &&
              partnerDayCount < partner.dailyCapacity
            ) {
              readyCount += 1;
            }
          } catch {
            // Partner unavailable for this candidate slot
          }
        }
        availableSlots.push({
          slotStart: sStart.toISOString(),
          slotEnd: sEnd.toISOString(),
          availablePartners: readyCount,
          ...(params.serviceZone ? { serviceZone: params.serviceZone } : {}),
        });
      }
    }

    if (caller.role === 'CUSTOMER') {
      return {
        roleScope: 'CUSTOMER',
        partners: [],
        collectionCentres: centres,
        availableSlots: availableSlots ?? [],
      };
    }

    return {
      roleScope: caller.role,
      partners,
      collectionCentres: centres,
      ...(availableSlots ? { availableSlots } : {}),
    };
  }

  async getPickupById(pickupId: string, caller: AuthPrincipal): Promise<PickupDto> {
    const pickup = await this.pickups.findById(pickupId);
    if (!pickup) throw notFound('Pickup appointment not found.');
    this.assertPickupReadAccess(caller, pickup);
    return pickup;
  }

  async createPickup(
    input: CreatePickupInput,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<PickupDto> {
    const { slotStart, slotEnd } = validateSlotWindow(input.slotStart, input.slotEnd);
    const timeZone = input.timeZone?.trim() || 'UTC';
    getZonedDateParts(slotStart, timeZone);

    if (
      caller.role === 'CUSTOMER' &&
      input.partnerId
    ) {
      throw forbidden('Customers cannot directly assign a delivery partner when booking.');
    }

    const ret = await this.returns.findById(input.returnId.trim());
    if (!ret) throw notFound('Return record not found.');

    if (caller.role === 'CUSTOMER' && ret.customerId !== caller.userId) {
      throw forbidden('Cannot schedule a pickup for another customer return.');
    }
    if (
      (caller.role === 'MERCHANT_ADMIN' || caller.role === 'MERCHANT_STAFF') &&
      ret.merchantId !== caller.businessId
    ) {
      throw forbidden('Cannot schedule a pickup for another merchant return.');
    }
    if (caller.role === 'DELIVERY_PARTNER') {
      throw forbidden('Delivery partners cannot create new pickup appointments.');
    }

    if (['COLLECTED', 'RECEIVED', 'UNDER_INSPECTION', 'APPROVED', 'REJECTED', 'CLOSED'].includes(ret.status)) {
      throw conflict(`Cannot schedule pickup when return is already ${ret.status}.`);
    }

    const existing = await this.pickups.findByReturnId(ret.id);
    if (existing && existing.status !== 'CANCELLED') {
      throw conflict(`An active pickup (${existing.status}) already exists for return ${ret.returnNumber}.`);
    }

    const targetCentreId = input.collectionCenterId?.trim() || ret.collectionCenterId;
    if (targetCentreId) {
      const centre = await this.pickups.findCollectionCentreById(targetCentreId);
      if (!centre) throw badRequest('Referenced collection centre does not exist.');
      if (centre.status !== 'ACTIVE') {
        throw conflict(`Collection centre "${centre.name}" is currently ${centre.status}.`);
      }
    }

    const partnerUserId = input.partnerId?.trim();
    const initialPartner = partnerUserId
      ? await this.pickups.findPartnerSchedule(partnerUserId)
      : null;
    if (partnerUserId && !initialPartner) {
      throw badRequest('Target partner must be a registered DELIVERY_PARTNER.');
    }

    const created = await this.runTx(async (session) => {
      let lockedPartner: PartnerScheduleDto | undefined;
      if (partnerUserId && initialPartner) {
        lockedPartner = await this.validatePartnerCapacityInTx(
          partnerUserId,
          initialPartner.displayName,
          slotStart,
          slotEnd,
          input.serviceZone,
          undefined,
          session
        );
      }

      if (targetCentreId) {
        const centre = await this.pickups.findCollectionCentreById(targetCentreId, session);
        if (!centre || centre.status !== 'ACTIVE') {
          throw conflict('Selected collection centre is no longer available.');
        }
        const activeAtCentre = await this.pickups.countCentreOverlappingPickups(
          targetCentreId,
          slotStart,
          slotEnd,
          undefined,
          session
        );
        if (centre.currentWorkload + activeAtCentre >= centre.capacity) {
          throw conflict(`Collection centre "${centre.name}" has reached scheduling capacity.`);
        }
      }

      const pickup = await this.pickups.create(
        {
          returnId: ret.id,
          orderId: ret.orderId,
          packageId: ret.packageId,
          merchantId: ret.merchantId,
          customerId: ret.customerId,
          ...(targetCentreId ? { collectionCenterId: targetCentreId } : {}),
          slotStart,
          slotEnd,
          timeZone,
          pickupMethod: input.pickupMethod ?? ret.mode ?? 'PICKUP',
          serviceZone: input.serviceZone,
          addressSummary: input.addressSummary,
          ...(input.location ? { location: input.location } : {}),
          ...(lockedPartner
            ? { partnerId: lockedPartner.userId, assignedPartnerName: lockedPartner.displayName }
            : {}),
          status: lockedPartner ? 'ASSIGNED' : 'UNASSIGNED',
          ...(input.notes ? { notes: input.notes } : {}),
          createdBy: caller.userId,
        },
        session
      );

      await this.pickups.syncReturnAndRecordEvent(
        {
          returnId: ret.id,
          returnSet: {
            pickupId: pickup.id,
            ...(ret.status === 'REQUESTED' || ret.status === 'DROP_OFF_SELECTED'
              ? { status: 'PICKUP_SCHEDULED' }
              : {}),
            ...(targetCentreId ? { collectionCenterId: targetCentreId } : {}),
            ...(lockedPartner
              ? {
                  assignedPartnerUserId: lockedPartner.userId,
                  assignedPartnerName: lockedPartner.displayName,
                }
              : {}),
            'returnMethodDetails.pickupWindowStart': slotStart,
            'returnMethodDetails.pickupWindowEnd': slotEnd,
            'returnMethodDetails.serviceZone': input.serviceZone.trim(),
            'returnMethodDetails.addressSummary': input.addressSummary.trim(),
          },
          event: {
            eventId: `evt_${crypto.randomUUID()}`,
            packageId: ret.packageId,
            merchantId: ret.merchantId,
            type: 'RETURN_PICKUP_SCHEDULED',
            actor: { userId: caller.userId, role: caller.role },
            occurredAt: new Date(),
            sourceSystem: 'REBOXIFY_API',
            correlationId: meta?.correlationId ?? pickup.id,
            outcome: 'ACCEPTED',
            evidence: [
              {
                type: 'NOTE',
                detail: `Pickup ${pickup.id} scheduled (${slotStart.toISOString()}–${slotEnd.toISOString()})${lockedPartner ? `, partner ${lockedPartner.displayName}` : ''}`,
              },
            ],
            metadata: {
              pickupId: pickup.id,
              returnId: ret.id,
              serviceZone: input.serviceZone.trim(),
            },
          },
        },
        session
      );

      return pickup;
    });

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'PICKUP_SCHEDULED',
      entityType: 'Pickup',
      entityId: created.id,
      businessId: ret.merchantId,
      afterSummary: {
        returnId: ret.id,
        slotStart: created.slotStart.toISOString(),
        slotEnd: created.slotEnd.toISOString(),
        partnerId: created.partnerId,
        status: created.status,
      },
      correlationId: meta?.correlationId,
    });

    return created;
  }

  async assignPickup(
    pickupId: string,
    input: { partnerId?: string; collectionCenterId?: string; expectedVersion?: number; notes?: string },
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<PickupDto> {
    if (
      caller.role !== 'MERCHANT_ADMIN' &&
      caller.role !== 'MERCHANT_STAFF' &&
      caller.role !== 'COLLECTION_CENTRE' &&
      caller.role !== 'ADMIN'
    ) {
      throw forbidden('Not authorized to assign pickup partners.');
    }
    return this.updatePickup(
      pickupId,
      {
        partnerId: input.partnerId,
        collectionCenterId: input.collectionCenterId,
        expectedVersion: input.expectedVersion,
        notes: input.notes,
        status: input.partnerId ? 'ASSIGNED' : undefined,
        reason: 'Partner dispatch assignment',
      },
      caller,
      meta
    );
  }

  async reschedulePickup(
    pickupId: string,
    input: {
      slotStart: string;
      slotEnd: string;
      timeZone?: string;
      partnerId?: string | null;
      reason: string;
      expectedVersion?: number;
    },
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<PickupDto> {
    return this.updatePickup(
      pickupId,
      {
        slotStart: input.slotStart,
        slotEnd: input.slotEnd,
        timeZone: input.timeZone,
        partnerId: input.partnerId,
        reason: input.reason,
        expectedVersion: input.expectedVersion,
      },
      caller,
      meta
    );
  }

  async updatePickup(
    pickupId: string,
    patch: UpdatePickupInput,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<PickupDto> {
    const existing = await this.pickups.findById(pickupId);
    if (!existing) throw notFound('Pickup appointment not found.');
    this.assertPickupReadAccess(caller, existing);

    if (patch.expectedVersion !== undefined && patch.expectedVersion !== existing.version) {
      throw conflict(
        `Pickup appointment was modified concurrently (expected version ${patch.expectedVersion}, actual ${existing.version}).`,
        'OPTIMISTIC_LOCK_CONFLICT'
      );
    }

    if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
      throw conflict(`Cannot modify pickup when status is ${existing.status}.`);
    }

    if (caller.role === 'CUSTOMER') {
      if (existing.status === 'IN_PROGRESS') {
        throw conflict('Cannot reschedule or modify pickup once collection is IN_PROGRESS.');
      }
      if (patch.partnerId !== undefined) {
        throw forbidden('Customers cannot assign or change delivery partners.');
      }
      if (patch.status && patch.status !== 'CANCELLED' && patch.status !== 'RESCHEDULED') {
        throw forbidden('Customers can only reschedule or cancel their pickup.');
      }
    }

    if (caller.role === 'DELIVERY_PARTNER') {
      if (patch.partnerId !== undefined && patch.partnerId !== caller.userId) {
        throw forbidden('Delivery partners cannot reassign pickups to other partners.');
      }
      if (patch.slotStart || patch.slotEnd) {
        throw forbidden('Delivery partners cannot alter booked customer pickup slots.');
      }
    }

    const nextSlotStart = patch.slotStart ? new Date(patch.slotStart) : existing.slotStart;
    const nextSlotEnd = patch.slotEnd ? new Date(patch.slotEnd) : existing.slotEnd;
    validateSlotWindow(nextSlotStart, nextSlotEnd);

    const nextTimeZone = patch.timeZone?.trim() || existing.timeZone || 'UTC';
    getZonedDateParts(nextSlotStart, nextTimeZone);

    const nextServiceZone = patch.serviceZone?.trim() || existing.serviceZone;
    const nextAddress = patch.addressSummary?.trim() || existing.addressSummary;

    const slotChanged =
      nextSlotStart.getTime() !== existing.slotStart.getTime() ||
      nextSlotEnd.getTime() !== existing.slotEnd.getTime();

    const targetPartnerId =
      patch.partnerId === null
        ? undefined
        : patch.partnerId !== undefined
          ? patch.partnerId.trim()
          : existing.partnerId;

    const targetCentreId =
      patch.collectionCenterId === null
        ? undefined
        : patch.collectionCenterId !== undefined
          ? patch.collectionCenterId.trim()
          : existing.collectionCenterId;

    let nextStatus: PickupStatus = patch.status ?? existing.status;
    if (patch.partnerId === null && !patch.status) {
      nextStatus = 'UNASSIGNED';
    } else if (slotChanged && !patch.status) {
      nextStatus = existing.status === 'UNASSIGNED' ? 'UNASSIGNED' : 'RESCHEDULED';
    } else if (
      targetPartnerId &&
      !patch.status &&
      (existing.status === 'UNASSIGNED' || existing.status === 'MISSED')
    ) {
      nextStatus = 'ASSIGNED';
    }

    if (nextStatus === 'COMPLETED') {
      throw badRequest(
        'Pickups must be completed through QR/supervised collection verification (/api/pickups/:id/complete).'
      );
    }

    if (nextStatus !== existing.status) {
      const check = pickupStateMachine.validateTransition(existing.status, nextStatus);
      if (!check.allowed) {
        throw conflict(check.reason ?? `Cannot transition pickup from ${existing.status} to ${nextStatus}.`);
      }
    }

    if (nextStatus === 'ASSIGNED' || nextStatus === 'IN_PROGRESS') {
      if (!targetPartnerId) {
        throw badRequest(`Cannot transition pickup to ${nextStatus} without an assigned partner.`);
      }
    }

    const initialPartner = targetPartnerId
      ? await this.pickups.findPartnerSchedule(targetPartnerId)
      : null;
    if (targetPartnerId && !initialPartner) {
      throw badRequest('Target partner must be a registered DELIVERY_PARTNER.');
    }

    const updated = await this.runTx(async (session) => {
      const current = await this.pickups.findById(existing.id, session);
      if (!current) throw notFound('Pickup appointment not found.');
      if (current.version !== existing.version) {
        throw conflict('Pickup appointment was updated by another request.', 'OPTIMISTIC_LOCK_CONFLICT');
      }

      let lockedPartner: PartnerScheduleDto | undefined;
      if (targetPartnerId && initialPartner && nextStatus !== 'CANCELLED') {
        lockedPartner = await this.validatePartnerCapacityInTx(
          targetPartnerId,
          initialPartner.displayName,
          nextSlotStart,
          nextSlotEnd,
          nextServiceZone,
          existing.id,
          session
        );
      }

      if (targetCentreId && targetCentreId !== existing.collectionCenterId) {
        const centre = await this.pickups.findCollectionCentreById(targetCentreId, session);
        if (!centre || centre.status !== 'ACTIVE') {
          throw conflict('Selected collection centre is unavailable.');
        }
      }

      const setFields: Record<string, unknown> = {
        slotStart: nextSlotStart,
        slotEnd: nextSlotEnd,
        timeZone: nextTimeZone,
        serviceZone: nextServiceZone,
        addressSummary: nextAddress,
        status: nextStatus,
        updatedBy: caller.userId,
      };
      if (patch.location) setFields.location = patch.location;
      if (patch.notes !== undefined) setFields.notes = patch.notes;
      if (patch.missedReason !== undefined) setFields.missedReason = patch.missedReason;
      if (targetCentreId) setFields.collectionCenterId = targetCentreId;

      const unsetFields: string[] = [];
      if (patch.collectionCenterId === null) unsetFields.push('collectionCenterId');
      if (lockedPartner) {
        setFields.partnerId = lockedPartner.userId;
        setFields.assignedPartnerName = lockedPartner.displayName;
      } else if (patch.partnerId === null) {
        unsetFields.push('partnerId', 'assignedPartnerName');
      }

      const saved = await this.pickups.updateOptimistic(
        existing.id,
        current.version,
        setFields,
        {
          ...(slotChanged
            ? {
                pushReschedule: {
                  previousStart: current.slotStart,
                  previousEnd: current.slotEnd,
                  newStart: nextSlotStart,
                  newEnd: nextSlotEnd,
                  reason: patch.reason?.trim() || 'Schedule adjusted via dispatcher',
                  changedBy: caller.userId,
                  changedAt: new Date(),
                },
              }
            : {}),
          ...(unsetFields.length > 0 ? { unsetFields } : {}),
        },
        session
      );

      if (!saved) {
        throw conflict('Pickup update collided with a concurrent modification.', 'OPTIMISTIC_LOCK_CONFLICT');
      }

      const returnSet: Record<string, unknown> = {
        'returnMethodDetails.pickupWindowStart': nextSlotStart,
        'returnMethodDetails.pickupWindowEnd': nextSlotEnd,
        'returnMethodDetails.serviceZone': nextServiceZone,
        'returnMethodDetails.addressSummary': nextAddress,
      };
      const unsetReturnFields: string[] = [];
      if (lockedPartner) {
        returnSet.assignedPartnerUserId = lockedPartner.userId;
        returnSet.assignedPartnerName = lockedPartner.displayName;
      } else if (patch.partnerId === null) {
        unsetReturnFields.push('assignedPartnerUserId', 'assignedPartnerName');
      }
      if (targetCentreId) returnSet.collectionCenterId = targetCentreId;

      const eventType = slotChanged
        ? 'RETURN_PICKUP_RESCHEDULED'
        : nextStatus === 'IN_PROGRESS'
          ? 'RETURN_PICKUP_IN_PROGRESS'
          : nextStatus === 'MISSED'
            ? 'RETURN_PICKUP_MISSED'
            : 'RETURN_PICKUP_ASSIGNED';

      await this.pickups.syncReturnAndRecordEvent(
        {
          returnId: existing.returnId,
          returnSet,
          unsetReturnFields,
          event: {
            eventId: `evt_${crypto.randomUUID()}`,
            packageId: existing.packageId,
            merchantId: existing.merchantId,
            type: eventType,
            actor: { userId: caller.userId, role: caller.role },
            occurredAt: new Date(),
            sourceSystem: 'REBOXIFY_API',
            correlationId: meta?.correlationId ?? existing.id,
            outcome: 'ACCEPTED',
            evidence: [
              {
                type: 'NOTE',
                detail: `${eventType}: status=${saved.status}, partner=${saved.assignedPartnerName ?? 'UNASSIGNED'}, slot=${nextSlotStart.toISOString()}–${nextSlotEnd.toISOString()}`,
              },
            ],
            metadata: {
              pickupId: saved.id,
              status: saved.status,
              partnerId: saved.partnerId,
              slotChanged,
            },
          },
        },
        session
      );

      return saved;
    });

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: slotChanged ? 'PICKUP_RESCHEDULED' : 'PICKUP_UPDATED',
      entityType: 'Pickup',
      entityId: updated.id,
      businessId: updated.merchantId,
      beforeSummary: {
        slotStart: existing.slotStart.toISOString(),
        slotEnd: existing.slotEnd.toISOString(),
        partnerId: existing.partnerId,
        status: existing.status,
      },
      afterSummary: {
        slotStart: updated.slotStart.toISOString(),
        slotEnd: updated.slotEnd.toISOString(),
        partnerId: updated.partnerId,
        status: updated.status,
      },
      correlationId: meta?.correlationId,
    });

    return updated;
  }

  async cancelPickup(
    pickupId: string,
    input: { reason: string; expectedVersion?: number },
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<PickupDto> {
    const existing = await this.pickups.findById(pickupId);
    if (!existing) throw notFound('Pickup appointment not found.');
    this.assertPickupReadAccess(caller, existing);

    if (caller.role === 'DELIVERY_PARTNER') {
      throw forbidden('Delivery partners should mark missed pickups instead of cancelling bookings.');
    }
    if (caller.role === 'CUSTOMER' && existing.status === 'IN_PROGRESS') {
      throw conflict('Cannot cancel a pickup while driver collection is IN_PROGRESS.');
    }

    const check = pickupStateMachine.validateTransition(existing.status, 'CANCELLED');
    if (!check.allowed) {
      throw conflict(check.reason ?? `Cannot cancel pickup in status ${existing.status}.`);
    }

    if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
      throw conflict('Pickup appointment version conflict.', 'OPTIMISTIC_LOCK_CONFLICT');
    }

    const cancelled = await this.runTx(async (session) => {
      const saved = await this.pickups.updateOptimistic(
        existing.id,
        existing.version,
        {
          status: 'CANCELLED',
          cancelReason: input.reason.trim(),
          updatedBy: caller.userId,
        },
        { unsetFields: ['partnerId', 'assignedPartnerName'] },
        session
      );
      if (!saved) {
        throw conflict('Pickup cancellation collided with concurrent update.');
      }

      await this.pickups.syncReturnAndRecordEvent(
        {
          returnId: existing.returnId,
          unsetReturnFields: ['assignedPartnerUserId', 'assignedPartnerName'],
          event: {
            eventId: `evt_${crypto.randomUUID()}`,
            packageId: existing.packageId,
            merchantId: existing.merchantId,
            type: 'RETURN_PICKUP_CANCELLED',
            actor: { userId: caller.userId, role: caller.role },
            occurredAt: new Date(),
            sourceSystem: 'REBOXIFY_API',
            correlationId: meta?.correlationId ?? existing.id,
            outcome: 'ACCEPTED',
            evidence: [{ type: 'NOTE', detail: `Pickup cancelled: ${input.reason.trim()}` }],
            metadata: { pickupId: existing.id, reason: input.reason.trim() },
          },
        },
        session
      );

      return saved;
    });

    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'PICKUP_CANCELLED',
      entityType: 'Pickup',
      entityId: cancelled.id,
      businessId: cancelled.merchantId,
      beforeSummary: { status: existing.status, partnerId: existing.partnerId },
      afterSummary: { status: cancelled.status, cancelReason: cancelled.cancelReason },
      correlationId: meta?.correlationId,
    });

    return cancelled;
  }

  async completePickup(
    pickupId: string,
    qrInput: ReturnQrActionInput,
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<{ pickup: PickupDto; returnRecord: ReturnDto }> {
    if (caller.role !== 'DELIVERY_PARTNER' && caller.role !== 'ADMIN') {
      throw forbidden('Only an assigned delivery partner or admin can complete pickup collection.');
    }
    const existing = await this.pickups.findById(pickupId);
    if (!existing) throw notFound('Pickup appointment not found.');
    this.assertPickupReadAccess(caller, existing);

    const check = pickupStateMachine.validateTransition(existing.status, 'COMPLETED');
    if (!check.allowed) {
      throw conflict(check.reason ?? `Cannot complete pickup in status ${existing.status}.`);
    }

    if (caller.role === 'DELIVERY_PARTNER' && existing.partnerId !== caller.userId) {
      throw forbidden('You are not the assigned delivery partner for this pickup.');
    }

    if (!this.returnService) {
      throw badRequest('Return collection handler is not attached to PickupService.');
    }

    // Ensures signed QR token / manual supervised fallback & single-collection package gates execute authoritatively
    const collected = await this.returnService.collectReturn(
      existing.returnId,
      qrInput,
      caller,
      meta
    );

    const freshPickup = await this.pickups.findById(existing.id);
    if (freshPickup && freshPickup.status === 'COMPLETED') {
      return { pickup: freshPickup, returnRecord: collected.returnRecord };
    }

    const updatedPickup = await this.pickups.updateOptimistic(
      existing.id,
      freshPickup?.version ?? existing.version,
      {
        status: 'COMPLETED',
        updatedBy: caller.userId,
      }
    );

    return {
      pickup: updatedPickup ?? freshPickup ?? { ...existing, status: 'COMPLETED' },
      returnRecord: collected.returnRecord,
    };
  }

  async updatePartnerSchedule(
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
    caller: AuthPrincipal,
    meta?: { ip?: string; correlationId?: string }
  ): Promise<PartnerScheduleDto> {
    if (
      caller.role !== 'ADMIN' &&
      caller.role !== 'COLLECTION_CENTRE' &&
      !(caller.role === 'DELIVERY_PARTNER' && caller.userId === partnerUserId)
    ) {
      throw forbidden('Not authorized to update delivery partner availability.');
    }

    const existing = await this.pickups.findPartnerSchedule(partnerUserId);
    if (!existing) throw notFound('Target delivery partner user not found.');

    if (input.timeZone) {
      getZonedDateParts(new Date(), input.timeZone);
    }
    if (input.workingHours) {
      if (input.workingHours.endHour <= input.workingHours.startHour) {
        throw badRequest('Working hours endHour must be greater than startHour.');
      }
    }

    const saved = await this.pickups.upsertPartnerSchedule(partnerUserId, input);
    await this.audit.record({
      actor: { userId: caller.userId, role: caller.role, ip: meta?.ip },
      action: 'PARTNER_SCHEDULE_UPDATED',
      entityType: 'DeliveryPartner',
      entityId: partnerUserId,
      afterSummary: {
        serviceZones: saved.serviceZones,
        timeZone: saved.timeZone,
        dailyCapacity: saved.dailyCapacity,
        maxConcurrentCapacity: saved.maxConcurrentCapacity,
        status: saved.status,
      },
      correlationId: meta?.correlationId,
    });
    return saved;
  }
}
