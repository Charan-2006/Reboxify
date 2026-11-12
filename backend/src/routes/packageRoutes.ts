import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { passportScanRateLimiter } from '../middleware/rateLimit.js';
import { requireRoles } from '../middleware/rbac.js';
import { validateRequest, wrapAsync } from '../middleware/validate.js';
import { PassportService, SCAN_ACTIONS } from '../services/passportService.js';
import { PACKAGE_STATUSES } from '../types/domain.js';

const packageIdParams = z.object({
  packageId: z.string().min(4).max(40),
});

const scanBody = z.object({
  action: z.enum(SCAN_ACTIONS),
  scanMode: z.enum(['QR_TOKEN', 'MANUAL_SUPERVISED']).default('QR_TOKEN'),
  qrToken: z.string().max(1024).optional(),
  scanId: z.string().min(4).max(120).optional(),
  assignedPartnerUserId: z.string().min(4).max(80).optional(),
  locationRef: z.string().max(160).optional(),
  notes: z.string().max(400).optional(),
  manualReason: z.string().max(300).optional(),
});

const assignPartnerBody = z.object({
  partnerUserId: z.string().min(4).max(80),
});

const qrReasonBody = z.object({
  reason: z.string().min(4).max(300),
});

const assignedListQuery = z.object({
  status: z.enum(PACKAGE_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function createPackageRouter(passportService: PassportService): Router {
  const router = Router();
  router.use(requireAuth);
  router.use(passportScanRateLimiter);

  router.get(
    '/partners',
    requireRoles('MERCHANT_ADMIN', 'MERCHANT_STAFF', 'COLLECTION_CENTRE', 'ADMIN'),
    wrapAsync(async (_req, res) => {
      const partners = await passportService.listDeliveryPartners(_req.auth!);
      res.json({ partners });
    })
  );

  router.get(
    '/assigned/me',
    requireRoles('DELIVERY_PARTNER', 'ADMIN'),
    validateRequest({ query: assignedListQuery }),
    wrapAsync(async (req, res) => {
      const q = req.query as unknown as z.infer<typeof assignedListQuery>;
      const result = await passportService.listMyAssignedPackages(q, req.auth!);
      res.json(result);
    })
  );

  router.get(
    '/:packageId/passport',
    requireRoles(
      'CUSTOMER',
      'MERCHANT_ADMIN',
      'MERCHANT_STAFF',
      'DELIVERY_PARTNER',
      'COLLECTION_CENTRE',
      'ADMIN'
    ),
    validateRequest({ params: packageIdParams }),
    wrapAsync(async (req, res) => {
      const passport = await passportService.getPassport(String(req.params.packageId), req.auth!);
      res.json({ passport });
    })
  );

  router.post(
    '/:packageId/scan',
    validateRequest({ params: packageIdParams, body: scanBody }),
    wrapAsync(async (req, res) => {
      const result = await passportService.executeScan(
        String(req.params.packageId),
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

  router.post(
    '/:packageId/assign-partner',
    requireRoles('MERCHANT_ADMIN', 'MERCHANT_STAFF', 'ADMIN'),
    validateRequest({ params: packageIdParams, body: assignPartnerBody }),
    wrapAsync(async (req, res) => {
      const result = await passportService.assignDeliveryPartner(
        String(req.params.packageId),
        req.body.partnerUserId,
        req.auth!,
        {
          ip: req.ip,
          correlationId: req.correlationId,
        }
      );
      res.json(result);
    })
  );

  router.post(
    '/:packageId/qr/reprint',
    requireRoles('MERCHANT_ADMIN', 'COLLECTION_CENTRE', 'ADMIN'),
    validateRequest({ params: packageIdParams, body: qrReasonBody }),
    wrapAsync(async (req, res) => {
      const result = await passportService.reprintQrLabel(
        String(req.params.packageId),
        req.body.reason,
        req.auth!,
        {
          ip: req.ip,
          correlationId: req.correlationId,
        }
      );
      res.json(result);
    })
  );

  router.post(
    '/:packageId/qr/revoke',
    requireRoles('MERCHANT_ADMIN', 'COLLECTION_CENTRE', 'ADMIN'),
    validateRequest({ params: packageIdParams, body: qrReasonBody }),
    wrapAsync(async (req, res) => {
      const result = await passportService.revokeQrToken(
        String(req.params.packageId),
        req.body.reason,
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

