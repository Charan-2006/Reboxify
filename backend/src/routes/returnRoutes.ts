import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireIdempotency } from '../middleware/idempotency.js';
import { requireRoles } from '../middleware/rbac.js';
import { validateRequest, wrapAsync } from '../middleware/validate.js';
import { ReturnService } from '../services/returnService.js';
import {
  INSPECTION_CONDITIONS,
  PAYMENT_STATUSES,
  RETURN_MODES,
  RETURN_STATUSES,
} from '../types/domain.js';

const idParams = z.object({
  id: z.string().min(4).max(60),
});

const evidenceDownloadParams = z.object({
  id: z.string().min(4).max(60),
  fileId: z.string().min(4).max(80),
});

const initiateReturnBody = z.object({
  orderId: z.string().min(4).max(64),
  packageId: z.string().min(4).max(40),
  mode: z.enum(RETURN_MODES),
  reason: z.string().max(400).optional(),
  dropoffLocationLabel: z.string().max(200).optional(),
  pickupWindowStart: z.string().optional(),
  pickupWindowEnd: z.string().optional(),
  serviceZone: z.string().max(100).optional(),
  addressSummary: z.string().max(250).optional(),
  swapOrderNumber: z.string().max(64).optional(),
});

const listReturnsQuery = z.object({
  status: z.enum(RETURN_STATUSES).optional(),
  mode: z.enum(RETURN_MODES).optional(),
  condition: z.enum(INSPECTION_CONDITIONS).optional(),
  refundStatus: z.enum(PAYMENT_STATUSES).optional(),
  search: z.string().optional(),
  merchantId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(['returnNumber', 'status', 'createdAt', 'updatedAt']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

const assignPartnerBody = z.object({
  partnerUserId: z.string().min(4).max(80),
});

const returnQrBody = z.object({
  scanMode: z.enum(['QR_TOKEN', 'MANUAL_SUPERVISED']).default('QR_TOKEN'),
  qrToken: z.string().max(1024).optional(),
  scanId: z.string().min(4).max(120).optional(),
  locationRef: z.string().max(160).optional(),
  notes: z.string().max(400).optional(),
  manualReason: z.string().max(300).optional(),
});

const uploadEvidenceBody = z.object({
  filename: z.string().min(1).max(120),
  mimeType: z.string().min(3).max(60),
  contentBase64: z.string().min(8),
});

const inspectBody = z.object({
  condition: z.enum(INSPECTION_CONDITIONS),
  checklist: z.object({
    identityVerified: z.boolean(),
    structuralIntegrity: z.boolean(),
    cleanlinessAcceptable: z.boolean(),
    completeComponents: z.boolean(),
  }),
  damageReason: z.string().max(400).optional(),
  notes: z.string().max(600).optional(),
  disputed: z.boolean().optional(),
  disputeReason: z.string().max(400).optional(),
  refundAmount: z.unknown().optional(),
  amount: z.unknown().optional(),
  calculatedAmount: z.unknown().optional(),
});

const approveBody = z.object({
  reason: z.string().max(400).optional(),
  refundAmount: z.unknown().optional(),
  amount: z.unknown().optional(),
  calculatedAmount: z.unknown().optional(),
});

const rejectBody = z.object({
  reason: z.string().min(4).max(400),
});

export function createReturnRouter(
  returnService: ReturnService,
  idempotencyStore?: import('../middleware/idempotency.js').IdempotencyStore
): Router {
  const router = Router();
  router.use(requireAuth);

  router.post(
    '/',
    requireRoles('CUSTOMER', 'MERCHANT_ADMIN', 'MERCHANT_STAFF', 'ADMIN'),
    requireIdempotency('RETURN_INITIATE', { optional: true, store: idempotencyStore }),
    validateRequest({ body: initiateReturnBody }),
    wrapAsync(async (req, res) => {
      const returnRecord = await returnService.initiateReturn(req.body, req.auth!, {
        ip: req.ip,
        correlationId: req.correlationId,
      });
      res.status(201).json({ returnRecord });
    })
  );

  router.get(
    '/',
    validateRequest({ query: listReturnsQuery }),
    wrapAsync(async (req, res) => {
      const q = req.query as unknown as z.infer<typeof listReturnsQuery>;
      const result = await returnService.listReturns(q, req.auth!);
      res.json(result);
    })
  );

  router.get(
    '/:id',
    validateRequest({ params: idParams }),
    wrapAsync(async (req, res) => {
      const returnRecord = await returnService.getReturnById(String(req.params.id), req.auth!);
      res.json({ returnRecord });
    })
  );

  router.get(
    '/:id/refund',
    validateRequest({ params: idParams }),
    wrapAsync(async (req, res) => {
      const refund = await returnService.getReturnRefund(String(req.params.id), req.auth!);
      res.json({ refund });
    })
  );

  router.post(
    '/:id/assign-partner',
    requireRoles('MERCHANT_ADMIN', 'MERCHANT_STAFF', 'COLLECTION_CENTRE', 'ADMIN'),
    validateRequest({ params: idParams, body: assignPartnerBody }),
    wrapAsync(async (req, res) => {
      const returnRecord = await returnService.assignReturnPartner(
        String(req.params.id),
        req.body.partnerUserId,
        req.auth!,
        { ip: req.ip, correlationId: req.correlationId }
      );
      res.json({ returnRecord });
    })
  );

  router.post(
    '/:id/collect',
    requireRoles('DELIVERY_PARTNER', 'ADMIN'),
    validateRequest({ params: idParams, body: returnQrBody }),
    wrapAsync(async (req, res) => {
      const result = await returnService.collectReturn(
        String(req.params.id),
        req.body,
        req.auth!,
        { ip: req.ip, correlationId: req.correlationId }
      );
      res.json(result);
    })
  );

  router.post(
    '/:id/receive',
    requireRoles('COLLECTION_CENTRE', 'ADMIN'),
    validateRequest({ params: idParams, body: returnQrBody }),
    wrapAsync(async (req, res) => {
      const result = await returnService.receiveAtCentre(
        String(req.params.id),
        req.body,
        req.auth!,
        { ip: req.ip, correlationId: req.correlationId }
      );
      res.json(result);
    })
  );

  router.post(
    '/:id/evidence',
    requireRoles('CUSTOMER', 'DELIVERY_PARTNER', 'COLLECTION_CENTRE', 'ADMIN'),
    validateRequest({ params: idParams, body: uploadEvidenceBody }),
    wrapAsync(async (req, res) => {
      const returnRecord = await returnService.uploadEvidence(
        String(req.params.id),
        req.body,
        req.auth!,
        { ip: req.ip, correlationId: req.correlationId }
      );
      res.status(201).json({ returnRecord });
    })
  );

  router.get(
    '/:id/evidence/:fileId',
    validateRequest({ params: evidenceDownloadParams }),
    wrapAsync(async (req, res) => {
      const file = await returnService.downloadEvidence(
        String(req.params.id),
        String(req.params.fileId),
        req.auth!
      );
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(file.buffer);
    })
  );

  router.post(
    '/:id/inspect',
    requireRoles('COLLECTION_CENTRE', 'ADMIN'),
    validateRequest({ params: idParams, body: inspectBody }),
    wrapAsync(async (req, res) => {
      const returnRecord = await returnService.inspectReturn(
        String(req.params.id),
        req.body,
        req.auth!,
        { ip: req.ip, correlationId: req.correlationId }
      );
      res.json({ returnRecord });
    })
  );

  router.post(
    '/:id/approve',
    requireRoles('COLLECTION_CENTRE', 'MERCHANT_ADMIN', 'ADMIN'),
    requireIdempotency('RETURN_APPROVE_REFUND', { optional: true, store: idempotencyStore }),
    validateRequest({ params: idParams, body: approveBody }),
    wrapAsync(async (req, res) => {
      const result = await returnService.approveAndInitiateRefund(
        String(req.params.id),
        req.body,
        req.auth!,
        {
          ip: req.ip,
          correlationId: req.correlationId,
          idempotencyKey: req.header('idempotency-key')?.trim(),
        }
      );
      res.status(result.pending ? 202 : 200).json(result);
    })
  );

  router.post(
    '/:id/reject',
    requireRoles('COLLECTION_CENTRE', 'MERCHANT_ADMIN', 'ADMIN'),
    validateRequest({ params: idParams, body: rejectBody }),
    wrapAsync(async (req, res) => {
      const returnRecord = await returnService.rejectReturn(
        String(req.params.id),
        req.body.reason,
        req.auth!,
        { ip: req.ip, correlationId: req.correlationId }
      );
      res.json({ returnRecord });
    })
  );

  router.post(
    '/:id/reconcile-refund',
    requireRoles('COLLECTION_CENTRE', 'MERCHANT_ADMIN', 'ADMIN'),
    validateRequest({ params: idParams }),
    wrapAsync(async (req, res) => {
      const result = await returnService.reconcileReturnRefund(
        String(req.params.id),
        req.auth!,
        { ip: req.ip, correlationId: req.correlationId }
      );
      res.status(result.pending ? 202 : 200).json(result);
    })
  );

  return router;
}
