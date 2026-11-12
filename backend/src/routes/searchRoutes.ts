import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { validateRequest, wrapAsync } from '../middleware/validate.js';
import { SearchService, defaultSearchService } from '../services/searchService.js';
import {
  PACKAGE_CLASSES,
  PACKAGE_OWNER_TYPES,
  PAYMENT_STATUSES,
  RETURN_MODES,
} from '../types/domain.js';

const entityParam = z.object({
  entity: z.enum(['orders', 'packages', 'inventory', 'returns', 'transactions']),
});

const searchQuerySchema = z.object({
  q: z.string().max(120).optional(),
  merchantId: z.string().max(64).optional(),
  status: z.string().max(40).optional(),
  mode: z.enum(RETURN_MODES).optional(),
  condition: z.string().max(40).optional(),
  packageClass: z.enum(PACKAGE_CLASSES).optional(),
  ownerType: z.enum(PACKAGE_OWNER_TYPES).optional(),
  refundStatus: z.enum(PAYMENT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.string().max(32).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

const reindexBodySchema = z.object({
  entities: z
    .array(z.enum(['orders', 'packages', 'returns', 'transactions']))
    .min(1)
    .max(4)
    .optional(),
  merchantId: z.string().max(64).optional(),
  batchSize: z.number().int().min(10).max(250).optional(),
  resumeJobId: z.string().max(64).optional(),
});

export function createSearchRouter(searchService: SearchService = defaultSearchService): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/status',
    requireRoles('MERCHANT_ADMIN', 'MERCHANT_STAFF', 'COLLECTION_CENTRE', 'ADMIN'),
    wrapAsync(async (_req, res) => {
      const status = await searchService.getStatus();
      res.json(status);
    })
  );

  router.post(
    '/reindex',
    requireRoles('ADMIN'),
    validateRequest({ body: reindexBodySchema }),
    wrapAsync(async (req, res) => {
      const result = await searchService.triggerReindex(req.body, req.auth!);
      res.json({ reindex: result });
    })
  );

  router.get(
    '/:entity',
    validateRequest({ params: entityParam, query: searchQuerySchema }),
    wrapAsync(async (req, res) => {
      const { entity } = req.params as z.infer<typeof entityParam>;
      const q = req.query as unknown as z.infer<typeof searchQuerySchema>;
      if (entity === 'orders') {
        res.json(await searchService.searchOrders(q, req.auth!));
        return;
      }
      if (entity === 'packages' || entity === 'inventory') {
        res.json(await searchService.searchInventoryOrPackages(q, req.auth!));
        return;
      }
      if (entity === 'returns') {
        res.json(await searchService.searchReturns(q, req.auth!));
        return;
      }
      res.json(await searchService.searchTransactions(q, req.auth!));
    })
  );

  return router;
}

