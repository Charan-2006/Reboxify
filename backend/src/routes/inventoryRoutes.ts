import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { validateRequest, wrapAsync } from '../middleware/validate.js';
import { PackagingService } from '../services/packagingService.js';
import {
  PACKAGE_CLASSES,
  PACKAGE_OWNER_TYPES,
  PACKAGE_STATUSES,
} from '../types/domain.js';

const registerPackageBody = z.object({
  packageId: z
    .string()
    .regex(/^RBX-[A-Z0-9-]{4,24}$/i, 'Package ID must match RBX-... format.')
    .optional(),
  ownerType: z.enum(PACKAGE_OWNER_TYPES),
  ownerId: z.string().optional(),
  packageClass: z.enum(PACKAGE_CLASSES),
  fulfilmentLocation: z.string().min(2).max(120),
  currency: z.string().length(3).optional(),
  maxLifecycleLimit: z.number().int().min(1).max(500).optional(),
  initialCustodian: z
    .object({
      custodianType: z.enum(['REBOXIFY_CENTRE', 'MERCHANT']),
      custodianId: z.string().min(2),
      label: z.string().min(2),
    })
    .optional(),
});

const listInventoryQuery = z.object({
  merchantId: z.string().optional(),
  status: z.enum(PACKAGE_STATUSES).optional(),
  packageClass: z.enum(PACKAGE_CLASSES).optional(),
  ownerType: z.enum(PACKAGE_OWNER_TYPES).optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(['packageId', 'packageClass', 'status', 'reuseCount', 'updatedAt']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

export function createInventoryRouter(packagingService: PackagingService): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/catalogue', (req, res) => {
    const currency = typeof req.query.currency === 'string' ? req.query.currency : undefined;
    res.json({ classes: packagingService.getCatalogue(currency) });
  });

  router.post(
    '/',
    requireRoles('MERCHANT_ADMIN', 'ADMIN'),
    validateRequest({ body: registerPackageBody }),
    wrapAsync(async (req, res) => {
      const result = await packagingService.registerPackage(req.body, req.auth!, {
        ip: req.ip,
        correlationId: req.correlationId,
      });
      res.status(201).json(result);
    })
  );

  router.get(
    '/',
    requireRoles('MERCHANT_ADMIN', 'MERCHANT_STAFF', 'COLLECTION_CENTRE', 'ADMIN'),
    validateRequest({ query: listInventoryQuery }),
    wrapAsync(async (req, res) => {
      const q = req.query as unknown as z.infer<typeof listInventoryQuery>;
      const result = await packagingService.listInventory(q, req.auth!);
      res.json(result);
    })
  );

  return router;
}

