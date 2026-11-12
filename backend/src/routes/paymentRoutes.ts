import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { IdempotencyStore, requireIdempotency } from '../middleware/idempotency.js';
import { requireRoles } from '../middleware/rbac.js';
import { validateRequest, wrapAsync } from '../middleware/validate.js';
import { PaymentService } from '../services/paymentService.js';
import { PAYMENT_STATUSES } from '../types/domain.js';

const createPayPalOrderBody = z.object({
  orderId: z.string().min(1),
});

const paypalOrderParam = z.object({
  id: z.string().min(1),
});

const listTransactionsQuery = z.object({
  merchantId: z.string().optional(),
  state: z.enum(PAYMENT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(['amount', 'state', 'createdAt', 'updatedAt']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

export function createPaymentRouter(
  paymentService: PaymentService,
  idempotencyStore?: IdempotencyStore
): Router {
  const router = Router();

  // Public non-secret PayPal browser SDK config (only client ID, currency, and readiness flag).
  router.get('/config', (_req, res) => {
    res.json({
      paypalConfigured: config.integrations.paypalConfigured,
      paypalClientId: config.paypalClientId ?? null,
      currency: config.defaultCurrency,
      environment: config.paypalEnv,
    });
  });

  router.use(requireAuth);

  router.post(
    '/paypal/create-order',
    requireRoles('CUSTOMER', 'MERCHANT_ADMIN', 'MERCHANT_STAFF', 'ADMIN'),
    requireIdempotency('paypal-create-order', { optional: true, store: idempotencyStore }),
    validateRequest({ body: createPayPalOrderBody }),
    wrapAsync(async (req, res) => {
      const result = await paymentService.createPayPalOrder(req.body.orderId, req.auth!, {
        ip: req.ip,
        correlationId: req.correlationId,
        idempotencyKey: req.header('idempotency-key')?.trim(),
      });
      res.status(result.alreadyCreated ? 200 : 201).json(result);
    })
  );

  router.post(
    '/paypal/capture/:id',
    requireRoles('CUSTOMER', 'MERCHANT_ADMIN', 'MERCHANT_STAFF', 'ADMIN'),
    requireIdempotency('paypal-capture-order', { optional: true, store: idempotencyStore }),
    validateRequest({ params: paypalOrderParam }),
    wrapAsync(async (req, res) => {
      const result = await paymentService.capturePayPalOrder(String(req.params.id), req.auth!, {
        ip: req.ip,
        correlationId: req.correlationId,
        idempotencyKey: req.header('idempotency-key')?.trim(),
      });
      res.status(result.pending ? 202 : 200).json(result);
    })
  );

  router.post(
    '/paypal/cancel/:id',
    requireRoles('CUSTOMER', 'MERCHANT_ADMIN', 'MERCHANT_STAFF', 'ADMIN'),
    validateRequest({ params: paypalOrderParam }),
    wrapAsync(async (req, res) => {
      const result = await paymentService.cancelCheckout(String(req.params.id), req.auth!, {
        ip: req.ip,
        correlationId: req.correlationId,
      });
      res.json(result);
    })
  );

  router.get(
    '/:id',
    requireRoles('CUSTOMER', 'MERCHANT_ADMIN', 'MERCHANT_STAFF', 'ADMIN'),
    validateRequest({ params: paypalOrderParam }),
    wrapAsync(async (req, res) => {
      const transaction = await paymentService.getPaymentById(String(req.params.id), req.auth!);
      res.json({ transaction });
    })
  );

  return router;
}

export function createTransactionRouter(paymentService: PaymentService): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    requireRoles('CUSTOMER', 'MERCHANT_ADMIN', 'MERCHANT_STAFF', 'ADMIN'),
    validateRequest({ query: listTransactionsQuery }),
    wrapAsync(async (req, res) => {
      const q = req.query as unknown as z.infer<typeof listTransactionsQuery>;
      const result = await paymentService.listTransactions(q, req.auth!);
      res.json(result);
    })
  );

  return router;
}

