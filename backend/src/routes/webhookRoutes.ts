import { Router } from 'express';
import { wrapAsync } from '../middleware/validate.js';
import { WebhookService } from '../services/webhookService.js';

export function createWebhookRouter(webhookService: WebhookService): Router {
  const router = Router();

  router.post(
    '/paypal',
    wrapAsync(async (req, res) => {
      const headers = {
        authAlgo: req.header('paypal-auth-algo'),
        certUrl: req.header('paypal-cert-url'),
        transmissionId: req.header('paypal-transmission-id'),
        transmissionSig: req.header('paypal-transmission-sig'),
        transmissionTime: req.header('paypal-transmission-time'),
      };

      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
        string,
        unknown
      >;
      const result = await webhookService.processPayPalWebhook(headers, body, {
        ip: req.ip,
        correlationId: req.correlationId,
      });

      res.status(200).json(result);
    })
  );

  return router;
}

