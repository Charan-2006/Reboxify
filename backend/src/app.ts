import cors from 'cors';
import express, { Express } from 'express';
import helmet from 'helmet';
import { config } from './config/env.js';
import { correlationIdMiddleware } from './middleware/correlationId.js';
import { errorHandlerMiddleware } from './middleware/errorHandler.js';
import { IdempotencyStore } from './middleware/idempotency.js';
import { apiRateLimiter } from './middleware/rateLimit.js';
import { createAiRouter } from './routes/aiRoutes.js';
import { createAuthRouter } from './routes/authRoutes.js';
import { createBusinessRouter } from './routes/businessRoutes.js';
import { createHealthRouter } from './routes/healthRoutes.js';
import { createInventoryRouter } from './routes/inventoryRoutes.js';
import { createOrderRouter } from './routes/orderRoutes.js';
import { createPackageRouter } from './routes/packageRoutes.js';
import { createPaymentRouter, createTransactionRouter } from './routes/paymentRoutes.js';
import { createPickupRouter } from './routes/pickupRoutes.js';
import { createProductRouter } from './routes/productRoutes.js';
import { createReturnRouter } from './routes/returnRoutes.js';
import { createSearchRouter } from './routes/searchRoutes.js';
import { createWebhookRouter } from './routes/webhookRoutes.js';
import { AiAssistantService } from './services/aiAssistantService.js';
import { AuthService } from './services/authService.js';
import { BusinessService } from './services/businessService.js';
import { SearchEngineClient } from './services/elasticsearchClient.js';
import { GeminiModelClient } from './services/geminiClient.js';
import { OrderService } from './services/orderService.js';
import { PackagingService } from './services/packagingService.js';
import { PassportService } from './services/passportService.js';
import { PaymentService } from './services/paymentService.js';
import { PickupService } from './services/pickupService.js';
import { ProductService } from './services/productService.js';
import { ReturnService } from './services/returnService.js';
import { SearchService } from './services/searchService.js';
import { WebhookService } from './services/webhookService.js';
import { notFound } from './utils/errors.js';

export interface AppDependencies {
  authService?: AuthService;
  businessService?: BusinessService;
  productService?: ProductService;
  packagingService?: PackagingService;
  orderService?: OrderService;
  paymentService?: PaymentService;
  passportService?: PassportService;
  pickupService?: PickupService;
  returnService?: ReturnService;
  webhookService?: WebhookService;
  searchService?: SearchService;
  aiAssistantService?: AiAssistantService;
  esClient?: SearchEngineClient;
  geminiClient?: GeminiModelClient;
  idempotencyStore?: IdempotencyStore;
}

export function createApp(deps: AppDependencies = {}): Express {
  const app = express();
  const authService = deps.authService ?? new AuthService();
  const businessService = deps.businessService ?? new BusinessService();
  const productService = deps.productService ?? new ProductService();
  const packagingService = deps.packagingService ?? new PackagingService();
  const orderService = deps.orderService ?? new OrderService();
  const paymentService = deps.paymentService ?? new PaymentService();
  const passportService = deps.passportService ?? new PassportService();
  const returnService = deps.returnService ?? new ReturnService();
  const pickupService =
    deps.pickupService ??
    new PickupService(undefined, undefined, undefined, undefined, returnService);
  const webhookService = deps.webhookService ?? new WebhookService();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || config.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} is not allowed by CORS configuration.`));
      },
      credentials: true,
    })
  );
  app.use(correlationIdMiddleware);
  // Bounded 8 MB JSON limit solely on /api/returns to support 5 MB base64 evidence image uploads; 2 MB elsewhere.
  app.use('/api/returns', express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRateLimiter);

  app.use('/api', createHealthRouter({ esClient: deps.esClient, geminiClient: deps.geminiClient }));
  app.use('/api/auth', createAuthRouter(authService));
  app.use('/api/businesses', createBusinessRouter(businessService));
  app.use('/api/products', createProductRouter(productService));
  app.use('/api/inventory', createInventoryRouter(packagingService));
  app.use('/api/packages', createPackageRouter(passportService));
  app.use('/api/orders', createOrderRouter(orderService, deps.idempotencyStore));
  app.use('/api/payments', createPaymentRouter(paymentService, deps.idempotencyStore));
  app.use('/api/transactions', createTransactionRouter(paymentService));
  app.use('/api/returns', createReturnRouter(returnService, deps.idempotencyStore));
  app.use('/api/pickups', createPickupRouter(pickupService, deps.idempotencyStore));
  app.use('/api/search', createSearchRouter(deps.searchService));
  app.use('/api/ai', createAiRouter(deps.aiAssistantService));
  app.use('/api/webhooks', createWebhookRouter(webhookService));

  app.use('/api/*', (req, _res, next) => {
    next(notFound(`API route ${req.method} ${req.originalUrl} is not implemented.`));
  });

  app.use(errorHandlerMiddleware);
  return app;
}
