import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { validateRequest, wrapAsync } from '../middleware/validate.js';
import { ProductService } from '../services/productService.js';

const upsertProductBody = z.object({
  merchantId: z.string().optional(),
  sku: z.string().min(2).max(64),
  name: z.string().min(2).max(160),
  dimensionsCm: z.object({
    length: z.number().positive().max(300),
    width: z.number().positive().max(300),
    height: z.number().positive().max(300),
  }),
  weightKg: z.number().positive().max(200),
  allowedOrientations: z.array(z.string()).optional(),
  rotatable: z.boolean().optional(),
  fragility: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  restrictions: z
    .object({
      liquidContainment: z.boolean().optional(),
      temperatureControlled: z.boolean().optional(),
      contaminationSensitive: z.boolean().optional(),
      notes: z.string().max(300).optional(),
    })
    .optional(),
  unitPrice: z.number().min(0),
  currency: z.string().length(3).optional(),
  active: z.boolean().optional(),
});

const listProductsQuery = z.object({
  merchantId: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function createProductRouter(productService: ProductService): Router {
  const router = Router();
  router.use(requireAuth);

  router.post(
    '/',
    requireRoles('MERCHANT_ADMIN', 'MERCHANT_STAFF', 'ADMIN'),
    validateRequest({ body: upsertProductBody }),
    wrapAsync(async (req, res) => {
      const product = await productService.upsertProduct(req.body, req.auth!, {
        ip: req.ip,
        correlationId: req.correlationId,
      });
      res.status(201).json({ product });
    })
  );

  router.get(
    '/',
    validateRequest({ query: listProductsQuery }),
    wrapAsync(async (req, res) => {
      const { merchantId, search, page, pageSize } = req.query as unknown as z.infer<
        typeof listProductsQuery
      >;
      const result = await productService.listProducts(
        { merchantId, search, page, pageSize },
        req.auth!
      );
      res.json(result);
    })
  );

  return router;
}

