import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { IdempotencyStore, requireIdempotency } from '../middleware/idempotency.js';
import { requireRoles } from '../middleware/rbac.js';
import { validateRequest, wrapAsync } from '../middleware/validate.js';
import { OrderService } from '../services/orderService.js';
import { ORDER_STATUSES } from '../types/domain.js';

const createOrderBody = z.object({
  merchantId: z.string().min(1),
  customerId: z.string().optional(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().int().min(1).max(100),
      })
    )
    .min(1),
  shippingReference: z.object({
    recipientName: z.string().min(2).max(120),
    zone: z.string().min(2).max(80),
    addressLine: z.string().min(4).max(240),
    fulfilmentLocation: z.string().min(2).max(120),
  }),
  shippingTotal: z.number().min(0).optional(),
  taxRate: z.number().min(0).max(0.5).optional(),
  autoAllocate: z.boolean().optional(),
  allowSplit: z.boolean().optional(),
});

const allocateBody = z.object({
  allowSplit: z.boolean().optional(),
});

const listOrdersQuery = z.object({
  merchantId: z.string().optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(['orderNumber', 'status', 'createdAt', 'updatedAt']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

const idParam = z.object({ id: z.string().min(1) });

export function createOrderRouter(
  orderService: OrderService,
  idempotencyStore?: IdempotencyStore
): Router {
  const router = Router();
  router.use(requireAuth);

  router.post(
    '/',
    requireRoles('CUSTOMER', 'MERCHANT_ADMIN', 'MERCHANT_STAFF', 'ADMIN'),
    requireIdempotency('ORDER_CREATE', { optional: true, store: idempotencyStore }),
    validateRequest({ body: createOrderBody }),
    wrapAsync(async (req, res) => {
      const result = await orderService.createOrder(req.body, req.auth!, {
        ip: req.ip,
        correlationId: req.correlationId,
      });
      res.status(201).json(result);
    })
  );

  router.get(
    '/',
    requireRoles('CUSTOMER', 'MERCHANT_ADMIN', 'MERCHANT_STAFF', 'ADMIN'),
    validateRequest({ query: listOrdersQuery }),
    wrapAsync(async (req, res) => {
      const q = req.query as unknown as z.infer<typeof listOrdersQuery>;
      const result = await orderService.listOrders(q, req.auth!);
      res.json(result);
    })
  );

  router.get(
    '/:id',
    requireRoles('CUSTOMER', 'MERCHANT_ADMIN', 'MERCHANT_STAFF', 'ADMIN'),
    validateRequest({ params: idParam }),
    wrapAsync(async (req, res) => {
      const order = await orderService.getOrderById(String(req.params.id), req.auth!);
      res.json({ order });
    })
  );

  router.post(
    '/:id/allocate-package',
    requireRoles('CUSTOMER', 'MERCHANT_ADMIN', 'MERCHANT_STAFF', 'ADMIN'),
    requireIdempotency('ORDER_ALLOCATE', { optional: true, store: idempotencyStore }),
    validateRequest({ params: idParam, body: allocateBody }),
    wrapAsync(async (req, res) => {
      const result = await orderService.allocatePackage(String(req.params.id), req.body, req.auth!, {
        ip: req.ip,
        correlationId: req.correlationId,
      });
      res.json(result);
    })
  );

  return router;
}
