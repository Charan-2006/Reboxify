import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { IdempotencyStore, requireIdempotency } from '../middleware/idempotency.js';
import { requireRoles } from '../middleware/rbac.js';
import { validateRequest, wrapAsync } from '../middleware/validate.js';
import { PickupService } from '../services/pickupService.js';
import { PICKUP_STATUSES, RETURN_MODES } from '../types/domain.js';

const idParams = z.object({
  id: z.string().min(4).max(60),
});

const partnerIdParams = z.object({
  partnerId: z.string().min(4).max(60),
});

const listPickupsQuery = z.object({
  merchantId: z.string().optional(),
  status: z.enum(PICKUP_STATUSES).optional(),
  serviceZone: z.string().optional(),
  partnerId: z.string().optional(),
  collectionCenterId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  sortBy: z.enum(['slotStart', 'status', 'serviceZone', 'createdAt', 'updatedAt']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

const listResourcesQuery = z.object({
  serviceZone: z.string().optional(),
  date: z.string().optional(),
  includeSlots: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
});

const createPickupBody = z.object({
  returnId: z.string().min(4).max(60),
  collectionCenterId: z.string().min(4).max(60).optional(),
  partnerId: z.string().min(4).max(60).optional(),
  slotStart: z.string().min(8),
  slotEnd: z.string().min(8),
  timeZone: z.string().min(2).max(64).optional(),
  pickupMethod: z.enum(RETURN_MODES).optional(),
  serviceZone: z.string().min(2).max(100),
  addressSummary: z.string().min(4).max(250),
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })
    .optional(),
  notes: z.string().max(400).optional(),
});

const updatePickupBody = z.object({
  slotStart: z.string().min(8).optional(),
  slotEnd: z.string().min(8).optional(),
  timeZone: z.string().min(2).max(64).optional(),
  partnerId: z.string().min(4).max(60).nullable().optional(),
  collectionCenterId: z.string().min(4).max(60).nullable().optional(),
  serviceZone: z.string().min(2).max(100).optional(),
  addressSummary: z.string().min(4).max(250).optional(),
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })
    .optional(),
  status: z.enum(PICKUP_STATUSES).optional(),
  notes: z.string().max(400).optional(),
  missedReason: z.string().max(300).optional(),
  reason: z.string().max(300).optional(),
  expectedVersion: z.number().int().min(1).optional(),
});

const assignPickupBody = z.object({
  partnerId: z.string().min(4).max(60).optional(),
  collectionCenterId: z.string().min(4).max(60).optional(),
  notes: z.string().max(400).optional(),
  expectedVersion: z.number().int().min(1).optional(),
});

const reschedulePickupBody = z.object({
  slotStart: z.string().min(8),
  slotEnd: z.string().min(8),
  timeZone: z.string().min(2).max(64).optional(),
  partnerId: z.string().min(4).max(60).nullable().optional(),
  reason: z.string().min(3).max(300),
  expectedVersion: z.number().int().min(1).optional(),
});

const cancelPickupBody = z.object({
  reason: z.string().min(3).max(300),
  expectedVersion: z.number().int().min(1).optional(),
});

const completePickupBody = z.object({
  scanMode: z.enum(['QR_TOKEN', 'MANUAL_SUPERVISED']).default('QR_TOKEN'),
  qrToken: z.string().max(1024).optional(),
  scanId: z.string().min(4).max(120).optional(),
  locationRef: z.string().max(160).optional(),
  notes: z.string().max(400).optional(),
  manualReason: z.string().max(300).optional(),
});

const updatePartnerScheduleBody = z.object({
  displayName: z.string().min(2).max(120).optional(),
  serviceZones: z.array(z.string().min(1).max(64)).max(50).optional(),
  timeZone: z.string().min(2).max(64).optional(),
  workingHours: z
    .object({
      startHour: z.number().int().min(0).max(23),
      endHour: z.number().int().min(1).max(24),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    })
    .optional(),
  unavailablePeriods: z
    .array(
      z.object({
        start: z.coerce.date(),
        end: z.coerce.date(),
        reason: z.string().max(200).optional(),
      })
    )
    .max(100)
    .optional(),
  dailyCapacity: z.number().int().min(1).max(200).optional(),
  maxConcurrentCapacity: z.number().int().min(1).max(25).optional(),
  status: z.enum(['ACTIVE', 'UNAVAILABLE', 'SUSPENDED']).optional(),
});

export function createPickupRouter(
  pickupService: PickupService,
  idempotencyStore?: IdempotencyStore
): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    validateRequest({ query: listPickupsQuery }),
    wrapAsync(async (req, res) => {
      const q = req.query as unknown as z.infer<typeof listPickupsQuery>;
      const result = await pickupService.listPickups(q, req.auth!);
      res.json(result);
    })
  );

  router.get(
    '/resources',
    validateRequest({ query: listResourcesQuery }),
    wrapAsync(async (req, res) => {
      const q = req.query as unknown as z.infer<typeof listResourcesQuery>;
      const result = await pickupService.listResources(q, req.auth!);
      res.json(result);
    })
  );

  router.patch(
    '/partners/:partnerId/schedule',
    requireRoles('DELIVERY_PARTNER', 'COLLECTION_CENTRE', 'ADMIN'),
    validateRequest({ params: partnerIdParams, body: updatePartnerScheduleBody }),
    wrapAsync(async (req, res) => {
      const partner = await pickupService.updatePartnerSchedule(
        String(req.params.partnerId),
        req.body,
        req.auth!,
        { ip: req.ip, correlationId: req.correlationId }
      );
      res.json({ partner });
    })
  );

  router.get(
    '/:id',
    validateRequest({ params: idParams }),
    wrapAsync(async (req, res) => {
      const pickup = await pickupService.getPickupById(String(req.params.id), req.auth!);
      res.json({ pickup });
    })
  );

  router.post(
    '/',
    requireRoles('CUSTOMER', 'MERCHANT_ADMIN', 'MERCHANT_STAFF', 'COLLECTION_CENTRE', 'ADMIN'),
    requireIdempotency('PICKUP_CREATE', { optional: true, store: idempotencyStore }),
    validateRequest({ body: createPickupBody }),
    wrapAsync(async (req, res) => {
      const pickup = await pickupService.createPickup(req.body, req.auth!, {
        ip: req.ip,
        correlationId: req.correlationId,
      });
      res.status(201).json({ pickup });
    })
  );

  router.patch(
    '/:id',
    validateRequest({ params: idParams, body: updatePickupBody }),
    wrapAsync(async (req, res) => {
      const pickup = await pickupService.updatePickup(String(req.params.id), req.body, req.auth!, {
        ip: req.ip,
        correlationId: req.correlationId,
      });
      res.json({ pickup });
    })
  );

  router.post(
    '/:id/assign',
    requireRoles('MERCHANT_ADMIN', 'MERCHANT_STAFF', 'COLLECTION_CENTRE', 'ADMIN'),
    requireIdempotency('PICKUP_ASSIGN', { optional: true, store: idempotencyStore }),
    validateRequest({ params: idParams, body: assignPickupBody }),
    wrapAsync(async (req, res) => {
      const pickup = await pickupService.assignPickup(String(req.params.id), req.body, req.auth!, {
        ip: req.ip,
        correlationId: req.correlationId,
      });
      res.json({ pickup });
    })
  );

  router.post(
    '/:id/reschedule',
    requireIdempotency('PICKUP_RESCHEDULE', { optional: true, store: idempotencyStore }),
    validateRequest({ params: idParams, body: reschedulePickupBody }),
    wrapAsync(async (req, res) => {
      const pickup = await pickupService.reschedulePickup(
        String(req.params.id),
        req.body,
        req.auth!,
        {
          ip: req.ip,
          correlationId: req.correlationId,
        }
      );
      res.json({ pickup });
    })
  );

  router.post(
    '/:id/cancel',
    requireIdempotency('PICKUP_CANCEL', { optional: true, store: idempotencyStore }),
    validateRequest({ params: idParams, body: cancelPickupBody }),
    wrapAsync(async (req, res) => {
      const pickup = await pickupService.cancelPickup(String(req.params.id), req.body, req.auth!, {
        ip: req.ip,
        correlationId: req.correlationId,
      });
      res.json({ pickup });
    })
  );

  router.post(
    '/:id/complete',
    requireRoles('DELIVERY_PARTNER', 'ADMIN'),
    requireIdempotency('PICKUP_COMPLETE', { optional: true, store: idempotencyStore }),
    validateRequest({ params: idParams, body: completePickupBody }),
    wrapAsync(async (req, res) => {
      const result = await pickupService.completePickup(
        String(req.params.id),
        req.body,
        req.auth!,
        {
          ip: req.ip,
          correlationId: req.correlationId,
        }
      );
      res.json(result);
    })
  );

  return router;
}

