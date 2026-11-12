import { Router } from 'express';
import { z } from 'zod';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { authRateLimiter } from '../middleware/rateLimit.js';
import { validateRequest, wrapAsync } from '../middleware/validate.js';
import { AuthService } from '../services/authService.js';
import { USER_ROLES } from '../types/domain.js';

const registerBodySchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(180),
  password: z.string().min(8).max(128),
  role: z.enum(USER_ROLES).optional(),
  businessId: z.string().optional(),
  collectionCenterId: z.string().optional(),
});

const loginBodySchema = z.object({
  email: z.string().email().max(180),
  password: z.string().min(1).max(128),
  expectedRole: z.enum(USER_ROLES).optional(),
});

export function createAuthRouter(authService: AuthService): Router {
  const router = Router();

  router.post(
    '/register',
    authRateLimiter,
    optionalAuth,
    validateRequest({ body: registerBodySchema }),
    wrapAsync(async (req, res) => {
      const result = await authService.register(req.body, req.auth, {
        ip: req.ip,
        correlationId: req.correlationId,
      });
      res.status(201).json(result);
    })
  );

  router.post(
    '/login',
    authRateLimiter,
    validateRequest({ body: loginBodySchema }),
    wrapAsync(async (req, res) => {
      const result = await authService.login(
        req.body.email,
        req.body.password,
        req.body.expectedRole,
        { ip: req.ip, correlationId: req.correlationId }
      );
      res.json(result);
    })
  );

  router.post(
    '/logout',
    requireAuth,
    wrapAsync(async (req, res) => {
      if (req.auth) {
        await authService.recordLogout(req.auth, {
          ip: req.ip,
          correlationId: req.correlationId,
        });
      }
      res.json({ success: true });
    })
  );

  router.get(
    '/me',
    requireAuth,
    wrapAsync(async (req, res) => {
      const profile = await authService.getProfile(req.auth!.userId);
      res.json({ user: profile });
    })
  );

  return router;
}

