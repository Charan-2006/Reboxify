import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { validateRequest, wrapAsync } from '../middleware/validate.js';
import { BusinessService } from '../services/businessService.js';
import { OWNERSHIP_MODELS } from '../types/domain.js';

const createBusinessBody = z.object({
  name: z.string().min(2).max(120),
  legalName: z.string().min(2).max(160),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/i, 'Slug must contain only letters, numbers, and hyphens.'),
  ownerUserId: z.string().optional(),
  currency: z.string().length(3).optional(),
  packagingModel: z.enum(OWNERSHIP_MODELS).optional(),
  allowCrossMerchantPool: z.boolean().optional(),
  policies: z
    .object({
      returnWindowDays: z.number().int().min(1).max(90).optional(),
      autoApproveOnPass: z.boolean().optional(),
      depositMultiplier: z.number().min(0).max(2.5).optional(),
      allowedReturnApprovers: z.array(z.string()).optional(),
    })
    .optional(),
  subscription: z
    .object({
      plan: z.enum(['STARTER', 'BUSINESS', 'ENTERPRISE']),
    })
    .optional(),
  status: z.enum(['ACTIVE', 'ONBOARDING']).optional(),
});

const listBusinessQuery = z.object({
  status: z.enum(['ACTIVE', 'ONBOARDING', 'SUSPENDED']).optional(),
  packagingModel: z.enum(OWNERSHIP_MODELS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const statusUpdateBody = z.object({
  status: z.enum(['ACTIVE', 'ONBOARDING', 'SUSPENDED']),
});

const policiesUpdateBody = z.object({
  packagingModel: z.enum(OWNERSHIP_MODELS).optional(),
  allowCrossMerchantPool: z.boolean().optional(),
  currency: z.string().length(3).optional(),
  policies: z
    .object({
      returnWindowDays: z.number().int().min(1).max(90).optional(),
      autoApproveOnPass: z.boolean().optional(),
      depositMultiplier: z.number().min(0).max(2.5).optional(),
      allowedReturnApprovers: z.array(z.string()).optional(),
    })
    .optional(),
});

const idParam = z.object({ id: z.string().min(1) });

export function createBusinessRouter(businessService: BusinessService): Router {
  const router = Router();

  router.use(requireAuth);

  router.post(
    '/',
    validateRequest({ body: createBusinessBody }),
    wrapAsync(async (req, res) => {
      const created = await businessService.createBusiness(req.body, req.auth!, {
        ip: req.ip,
        correlationId: req.correlationId,
      });
      res.status(201).json({ business: created });
    })
  );

  router.get(
    '/',
    validateRequest({ query: listBusinessQuery }),
    wrapAsync(async (req, res) => {
      const { status, packagingModel, page, pageSize } = req.query as unknown as z.infer<
        typeof listBusinessQuery
      >;
      const result = await businessService.listBusinesses(
        { status, packagingModel, page, pageSize },
        req.auth!
      );
      res.json(result);
    })
  );

  router.get(
    '/:id',
    validateRequest({ params: idParam }),
    wrapAsync(async (req, res) => {
      const business = await businessService.getBusinessById(String(req.params.id), req.auth!);
      res.json({ business });
    })
  );

  router.patch(
    '/:id/status',
    requireRoles('ADMIN'),
    validateRequest({ params: idParam, body: statusUpdateBody }),
    wrapAsync(async (req, res) => {
      const business = await businessService.approveOrUpdateStatus(
        String(req.params.id),
        req.body.status,
        req.auth!,
        { ip: req.ip, correlationId: req.correlationId }
      );
      res.json({ business });
    })
  );

  router.patch(
    '/:id/policies',
    requireRoles('MERCHANT_ADMIN', 'ADMIN'),
    validateRequest({ params: idParam, body: policiesUpdateBody }),
    wrapAsync(async (req, res) => {
      const business = await businessService.updatePolicies(
        String(req.params.id),
        req.body,
        req.auth!,
        {
          ip: req.ip,
          correlationId: req.correlationId,
        }
      );
      res.json({ business });
    })
  );

  return router;
}
