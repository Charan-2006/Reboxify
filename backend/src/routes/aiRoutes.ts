import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { aiRateLimiter } from '../middleware/rateLimit.js';
import { requireRoles } from '../middleware/rbac.js';
import { validateRequest, wrapAsync } from '../middleware/validate.js';
import { AiAssistantService, defaultAiAssistantService } from '../services/aiAssistantService.js';

const askBodySchema = z.object({
  question: z.string().trim().min(3).max(800),
  merchantId: z.string().max(64).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(600),
      })
    )
    .max(6)
    .optional(),
});

const summaryBodySchema = z.object({
  focus: z.enum(['REUSE', 'RETURNS', 'PICKUPS', 'OVERVIEW']).optional(),
  merchantId: z.string().max(64).optional(),
});

const idParamSchema = z.object({
  id: z.string().min(4).max(64),
});

export function createAiRouter(
  aiService: AiAssistantService = defaultAiAssistantService
): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/status',
    requireRoles('MERCHANT_ADMIN', 'MERCHANT_STAFF', 'COLLECTION_CENTRE', 'ADMIN'),
    wrapAsync(async (_req, res) => {
      const status = await aiService.getStatus();
      res.json({ gemini: status });
    })
  );

  router.post(
    '/insights/ask',
    aiRateLimiter,
    requireRoles('MERCHANT_ADMIN', 'MERCHANT_STAFF', 'COLLECTION_CENTRE', 'ADMIN'),
    validateRequest({ body: askBodySchema }),
    wrapAsync(async (req, res) => {
      const result = await aiService.askOperationalQuestion(req.body, req.auth!, {
        correlationId: req.correlationId,
      });
      res.json(result);
    })
  );

  router.post(
    '/insights/summary',
    aiRateLimiter,
    requireRoles('MERCHANT_ADMIN', 'MERCHANT_STAFF', 'COLLECTION_CENTRE', 'ADMIN'),
    validateRequest({ body: summaryBodySchema }),
    wrapAsync(async (req, res) => {
      const result = await aiService.generateInsightsSummary(req.body, req.auth!, {
        correlationId: req.correlationId,
      });
      res.json(result);
    })
  );

  router.post(
    '/returns/:id/inspect-assist',
    aiRateLimiter,
    requireRoles('COLLECTION_CENTRE', 'MERCHANT_ADMIN', 'ADMIN'),
    validateRequest({ params: idParamSchema }),
    wrapAsync(async (req, res) => {
      const result = await aiService.assistReturnInspection(String(req.params.id), req.auth!, {
        correlationId: req.correlationId,
      });
      res.json(result);
    })
  );

  return router;
}

