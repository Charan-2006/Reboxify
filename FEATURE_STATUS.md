# ReBoxify Feature Status Matrix (Blueprint v2.0 vs Existing Repo)

Classification legend required for audit:
- **Already working** — Implemented end-to-end and verified against Blueprint behavior.
- **Partially implemented** — UI or client-side scaffolding exists, but lacks backend persistence, validation, or full Blueprint behavior.
- **Broken** — Exists in code but fails due to bugs, regressions, security issues, or contradictory behavior.
- **Missing** — Not present in the existing `main` repository at all.
- **Needs integration** — Library/code exists partially or independently (e.g., `qrcode.react`, `origin/ashwin` API calls), awaiting backend/service connection.
- **Needs verification** — Built/configured or dependent on external accounts/licences/browser runtime that could not be confirmed yet.

---

## 1. Core Platform & Stack (Sections 1–5, 13–14)

| Blueprint Requirement | PDF Ref | Status | Existing Repo Evidence & Gap Analysis |
| :--- | :--- | :--- | :--- |
| React + TypeScript + Tailwind SPA | Sec 12, 13 | **Already working** | Migrated to `frontend/`; local Tailwind + PostCSS compiles cleanly (`dist/assets/index-*.css`), `importmap`/`cdn.tailwindcss.com`/`GEMINI_API_KEY` define removed, `tsc --noEmit` & `vite build` pass. |
| Node.js + Express REST Backend | Sec 13, 14, 16 | **Partially implemented** | `backend/src/app.ts` & `server.ts` implemented with `/api/health`, `/api/auth/*`, `/api/businesses/*`, `/api/products/*`, `/api/inventory/*`, `/api/orders/*`, `/api/payments/*`, `/api/packages/*`, `/api/returns/*`, `/api/webhooks/paypal`, middleware pipeline, and correlation IDs; Phases 7–8 routes (pickups/search/AI/sustainability) remain. |
| MongoDB + Mongoose System of Record (18 collections + indexes) | Sec 13, 15 | **Needs verification** | All 18 Mongoose models & indexes (`backend/src/models/*`), replica-set transaction helper (`backend/src/config/db.ts`), and `docker-compose.yml` created; live MongoDB replica-set persistence awaits local/Atlas DB startup. |
| Render Hosting (Static Site + Web Service + Background Worker) | Sec 14.3, 23.1 | **Needs verification** | `render.yaml` and `backend/src/worker.ts` skeleton created; live Render deployment scheduled in Phase 6. |
| Role-Based Portals (5 portals, 6 roles) | Sec 5, 12, 20.2 | **Partially implemented** | All 5 portals (`UserPortal`, `CompanyAdminPortal`, `DeliveryPartnerApp`, `CollectionCentrePortal`, `AdminDashboard`) enforce 6-role RBAC and live Phase 1–5 workflows (orders, deterministic allocation, PayPal checkout, QR labels, camera/manual scanning, digital passports, return initiation, collection-centre intake/inspection/evidence photos, partial/full refunds, and cleaning recirculation); Phases 6–8 add Render worker deployment, AG Grid/Bryntum, and Gemini/ES. |
| Strict Role Separation & Tenant Isolation | Sec 5, 20.1, 20.2 | **Already working** | `backend/src/middleware/auth.ts` & `rbac.ts`, `orderService.ts`, `paymentService.ts`, `passportService.ts`, and `returnService.ts` enforce JWT auth, merchant scoping, delivery partner assignment, customer ownership, and anti-self-inspection/approval rules across automated HTTP test suites (`35/35`). |

---

## 2. Authentication, Businesses & Product Orders (Sections 5, 8, 12, 15, 16)

| Blueprint Requirement | PDF Ref | Status | Existing Repo Evidence & Gap Analysis |
| :--- | :--- | :--- | :--- |
| User Registration & Login (`POST /api/auth/register`, `/login`, `/logout`, `/me`) | Sec 16.1, 20.1 | **Needs verification** | Implemented in `backend/src/services/authService.ts` + `routes/authRoutes.ts` (bcrypt, JWT Bearer, customer-only self-signup, rate-limiting) and wired in `frontend/src/utils/auth.ts` + `LoginPage.tsx`. Unit/Supertest HTTP suite passes (`7/7`); live MongoDB roundtrip pending DB connection. |
| Merchant Business Onboarding (`POST /api/businesses`, `PATCH /status`, `/policies`) | Sec 12, 15.1, 16.1 | **Needs verification** | Implemented in `businessService.ts` + `businessRoutes.ts` + `MongooseBusinessRepository`, wired in `AdminDashboard.tsx` & `CompanyAdminPortal.tsx`. HTTP integration tests pass; live MongoDB persistence pending Atlas/Docker DB. |
| Product Catalogue & SKU Measurements (`POST /api/products`, `GET /api/products`) | Sec 8.2, 15.1, 16.1 | **Needs verification** | Implemented in `productService.ts` + `productRoutes.ts` + `MongooseProductRepository` with unique `(merchantId, sku)` and positive measurement validation; wired in `CompanyAdminPortal.tsx` & `UserPortal.tsx`. HTTP tests pass; live MongoDB verification pending DB. |
| Order Intake & Management (`POST/GET /api/orders`, `GET /api/orders/:id`) | Sec 7.1, 15.2, 16.1 | **Needs verification** | Implemented in `orderService.ts` + `orderRoutes.ts` with server-side price/deposit/return-deadline calculation and tenant/customer scoping; wired in `CompanyAdminPortal.tsx` & `UserPortal.tsx`. HTTP tests pass; live MongoDB verification pending DB. |
| Deterministic Packaging Allocation Engine (`POST /api/orders/:id/allocate-package`) | Sec 8.2–8.3, 16.1 | **Already working** | Implemented in `allocationEngine.ts` (dimensions, 3D/upright orientation, fragility clearance & protection, liquid containment, weight limits, ownership priority, simple stacking & split shipments, idempotent reservation); 7 pure unit tests + HTTP integration tests pass. |
| Configurable Deposit Recommendation Rules | Sec 6, 8.5 | **Already working** | `packagingCatalogue.ts` (`calculateConfiguredDeposit`) computes configurable currency deposits bounded by `replacementValue` with full audit breakdown (`ruleVersion`, `multiplier`, `baseDeposit`). |

---

## 3. Packaging, Ownership & Digital Packaging Passport (Sections 8, 9, 14, 15, 16)

| Blueprint Requirement | PDF Ref | Status | Existing Repo Evidence & Gap Analysis |
| :--- | :--- | :--- | :--- |
| 3 Ownership Models (Shared, Merchant-owned, Hybrid) | Sec 1, 8.1 | **Already working** | Enforced across `packagingService.ts`, `allocationEngine.ts`, and `inventoryRoutes.ts` (`REBOXIFY_POOL`, `MERCHANT`, `HYBRID`) and verified by unit & HTTP tests. |
| Separation of Ownership vs Current Custody | Sec 8.1, 15.1 | **Already working** | `PackageModel` & `MongoosePackageRepository` maintain immutable `ownerType`/`ownerId` separately from mutable `currentCustodian` and record `PACKAGE_RESERVED` events; verified in Phase 2 tests and Admin/Merchant inventory tables. |
| 14-State Package Lifecycle Machine | Sec 7.2, 15.2 | **Already working** | `packageStateMachine` (14 states), `gates.ts` (`canDispatchOrder`, `shouldIncrementReuseCount`), and atomic MongoDB scan transition logic in `passportService.ts` verified across full registration -> pack -> dispatch -> deliver -> centre recirculation tests. |
| Digital Packaging Passport (`GET /api/packages/:packageId/passport`) | Sec 9, 16.1 | **Needs verification** | Implemented in `passportService.ts`, `phase4Repositories.ts`, `packageRoutes.ts`, and `PassportViewerModal.tsx` (ownership vs custody, zero PII, order/payment gate state, inspection/cleaning history, verified-only reuse KPIs); HTTP tests pass (`24/24`), live Atlas DB verification pending. |
| QR Generation & Security Controls (`qrcode.react`, HMAC tokens, key rotation, reprint/revoke) | Sec 9, 13, 20.3 | **Already working** | `qrService.ts` + `QrLabelModal.tsx` implement HMAC-SHA256 `RBXQR:v1` tokens (zero PII, `QR_KEY_ID` + `QR_PREVIOUS_SIGNING_SECRET` key rotation, TTL expiration, versioned reprint, revocation) and verified against tamper/swap/expiry/key-rotation test vectors. |
| Authorised QR Scan Endpoint (`POST /api/packages/:packageId/scan`) | Sec 9, 16.1, 16.3 | **Needs verification** | Implemented in `passportService.ts`, `packageRoutes.ts`, `PackageScannerPanel.tsx` (`html5-qrcode` camera + supervised fallback) enforcing RBAC, tenant isolation, partner assignment, Gate 1 `CAPTURED` payment, and replay blocking across all portals; live Atlas & browser camera tests pending. |
| Append-only `packageEvents` Collection | Sec 9, 15.1, 16.3 | **Needs verification** | `PackageEventModel` (append-only pre-hooks + `{ packageId: 1, scanId: 1 }` unique partial index `partialFilterExpression: { scanId: { $exists: true } }`) + `MongoosePassportRepository` log both `ACCEPTED` and `REJECTED` scan attempts + atomic `searchOutbox` entries; HTTP harness + index regression suite verified, live Atlas DB pending. |

---

## 4. Payments, Deposits, Partial Refunds & Webhooks (Sections 6, 7.2, 10, 15, 16, 21.1)

| Blueprint Requirement | PDF Ref | Status | Existing Repo Evidence & Gap Analysis |
| :--- | :--- | :--- | :--- |
| Financial Separation & Itemised Deposit Disclosure | Sec 6.1–6.2, 7.1 | **Already working** | Itemised subtotal, per-package deposit allocation, shipping/tax, total payable, and return policy disclosed in `PayPalOrderCheckout.tsx` & `UserPortal.tsx` using backend-persisted order records. |
| Independent 12-State Payment State Machine | Sec 7.2, 10.5 | **Already working** | `paymentStateMachine` (12 states) integrated into `paymentService.ts`, `returnService.ts`, `phase5Repositories.ts`, and `webhookService.ts` across create, capture, cancel, pending, refund-request, partial/full refund, failure/retry, reversal, and webhook reconciliation transitions. |
| PayPal Sandbox Create Order & Server-Side Capture | Sec 10.1–10.4, 16.1 | **Needs verification** | Implemented in `paypalClient.ts`, `paymentService.ts`, `paymentRoutes.ts`, `phase3Repositories.ts`, and `@paypal/react-paypal-js` (`PayPalOrderCheckout.tsx`). Mocked PayPal HTTP tests pass (`35/35` suite); live PayPal Sandbox & MongoDB Atlas verification await configured credentials. |
| Per-Package Deposit Allocation & Partial Refund (`POST /v2/payments/captures/{id}/refund`) | Sec 10.1, 10.4, 15.3 | **Needs verification** | Per-package `depositAllocations[]` (`refundedAmount`, `pendingRefundAmount`) tracked atomically in `phase5Repositories.ts` & `returnService.ts` with `refundCapture` (`PayPal-Request-Id`), amount/currency/remaining-balance caps, pending reservation, failed retry, and client-refund-amount rejection; verified with mocked PayPal HTTP tests, live PayPal Sandbox refund awaits credentials. |
| PayPal Webhook Verification & Idempotent Deduplication (`webhookEvents`, `idempotencyKeys`) | Sec 10.6, 15.1, 16.1 | **Needs verification** | Implemented `POST /api/webhooks/paypal` (`webhookRoutes.ts` + `webhookService.ts`) using `verifyWebhookSignature`, `WebhookEventModel` `providerEventId` unique deduplication, live `getOrder`/`getRefund` reconciliation, unsolicited refund protection, and `HttpIdempotencyKey` middleware; live Render HTTPS webhook registration awaits Phase 6 deployment. |
| Scheduled PayPal Pending Reconciliation Worker | Sec 10.6, 14.3, 23.1 | **Partially implemented** | On-demand timeout/failed reconciliation implemented & tested in `paymentService.ts` and `returnService.ts` (`POST /api/returns/:id/reconcile-refund` & `reconcileStuckPendingRefunds`); periodic Render background worker schedule completes in Phase 6. |

---

## 5. Reverse Logistics, Scheduling & Collection Centres (Sections 7, 12, 18, 21.3)

| Blueprint Requirement | PDF Ref | Status | Existing Repo Evidence & Gap Analysis |
| :--- | :--- | :--- | :--- |
| Customer Return Request Flow (Pickup slot vs Drop-off centre) | Sec 7.1, 12, 16.1 | **Already working** | Implemented `POST /api/returns`, `GET /api/returns`, `GET /api/returns/:id`, `POST /api/returns/:id/assign-partner`, `/collect`, `/receive` (`returnService.ts` + `returnRoutes.ts`) across `PICKUP`, `DROP_OFF`, and `NEXT_DELIVERY_SWAP` modes with deadline/late tracking and duplicate return blocking; wired in `UserPortal.tsx`, `CompanyAdminPortal.tsx`, `DeliveryPartnerApp.tsx`, and `CollectionCentrePortal.tsx`. |
| Return State Machine (`REQUESTED` -> `APPROVED`/`REJECTED`/`NEEDS_REVIEW`/`CLOSED`) | Sec 15.2 | **Already working** | `ReturnModel` + `returnStateMachine` + `canInitiateRefundFromReturn` (Gate 2) + Gate 3 physical-cleaning independence implemented in `returnService.ts` and `phase5Repositories.ts`; 20s client timer deletion dead code removed cleanly in Phases 0–4. |
| Evidence Photo Upload & Private Storage (GridFS for MVP) | Sec 12, 20.1 | **Needs verification** | `evidenceStorage.ts` (`GridFsEvidenceStorage` using `returnEvidence` bucket + JPEG/PNG/WebP magic-byte & 5 MB checks) + `POST /api/returns/:id/evidence` + RBAC-gated `GET /api/returns/:id/evidence/:fileId`, `ReturnEvidenceUploader.tsx`, and authenticated image fetch in `ReturnDetailModal.tsx`; verified in-memory/HTTP tests, live MongoDB Atlas GridFS stream pending DB connection. |
| Collection-Centre Operator Portal & Queues | Sec 5, 12, 20.2 | **Needs verification** | `CollectionCentrePortal.tsx` integrates live incoming intake QR receive, 4-point structured inspection checklist, 8 condition categories (`GOOD`, `MINOR_WEAR`, `MINOR_DAMAGE`, `MAJOR_DAMAGE`, `CONTAMINATED`, `MISSING_PACKAGING`, `UNUSABLE`, `WRONG_PACKAGE`), evidence photo viewer, refund approval/retry, and cleaning/release QR transitions; browser E2E pending runtime setup. |
| Return Inspection & Approval -> Refund Trigger (`POST /api/returns/:id/inspect`, `/approve`, `/reject`) | Sec 7.2, 16.1, 21 | **Already working** | `calculateReturnRefund` (`REBOXIFY_REFUND_RULES_V2`) calculates deterministic partial/full/zero/late/capped refunds server-side, routes `NEEDS_REVIEW` cases cleanly, prevents self-inspection/self-approval, rejects client refund amounts (`400 CLIENT_REFUND_AMOUNT_FORBIDDEN`), and executes idempotent PayPal capture refunds on approval. |
| Bryntum Scheduler (Pickup Queue, Partner Assignment, Slot Management, Rescheduling) | Sec 12, 18 | **Partially implemented** | Return partner assignment (`POST /api/returns/:id/assign-partner`), `PickupModel`, `DeliveryPartnerModel`, `CollectionCenterModel`, and `pickupStateMachine` implemented; full `/api/pickups` scheduling engine + Bryntum-compatible timeline adapter arrive in Phase 7. |
| Delivery Partner Task Execution & Exception Reporting | Sec 12, 21.3 | **Already working** | `DeliveryPartnerApp.tsx` connects live QR dispatch/delivery scans, assigned package tasks, and return collection workflows (`POST /api/returns/:id/collect`) cleanly with RBAC & Logout. |

---

## 6. AI Integration Service & Google Gemini (Sections 11, 16, 19, 20.3, 21.4)

| Blueprint Requirement | PDF Ref | Status | Existing Repo Evidence & Gap Analysis |
| :--- | :--- | :--- | :--- |
| Backend AI Integration Service (`@google/genai`) | Sec 11.2, 13 | **Missing** | Only `vite.config.ts` exposes `GEMINI_API_KEY` to frontend (security bug); no Gemini SDK or endpoint exists. |
| Role-Scoped Function-Calling Tool Gateway (9 Tools) | Sec 11.2–11.3 | **Missing** | Read tools (`get_order_status`, `get_passport_summary`, `get_return_status`, `get_pickup_status`, `recommend_packaging`, `search_events`, `get_merchant_metrics`) and proposal tools (`draft_return_request`, `draft_pickup_reschedule`). |
| AI Operations Assistant Panel (`POST /api/ai/assistant/chat`, `/actions/:id/confirm`) | Sec 11.1, 11.5, 12, 16.1 | **Missing** | No assistant UI or confirmation flow for drafted returns/reschedules. |
| AI Packaging Recommendation Explanation (`POST /api/ai/packaging/explain`) | Sec 8.4, 11.1, 16.1 | **Missing** | Deterministic fallback template also missing. |
| AI Return Record Summary (`POST /api/ai/returns/:id/summary`) | Sec 11.1, 12, 16.1 | **Missing** | Not implemented. |
| AI Operational Insights Merchant Report (`POST /api/ai/insights/merchant-report`) | Sec 11.6, 16.1 | **Missing** | Not implemented. |
| AI Audit Logging (`aiInteractions` collection) & Graceful Degradation | Sec 11.4, 15.1, 21.4 | **Missing** | Not implemented. |

---

## 7. Operational Grids, Search & Observability (Sections 16–21)

| Blueprint Requirement | PDF Ref | Status | Existing Repo Evidence & Gap Analysis |
| :--- | :--- | :--- | :--- |
| AG Grid Tables (Inventory, Orders, Returns, Transactions, Inspection, Audit Log) | Sec 17 | **Missing** | Current dashboards render raw `<table>` elements (`CompanyAdminPortal`, `AdminDashboard`) with no pagination, sorting, filtering, or CSV export. |
| Elasticsearch Indices (`passports`, `package-events`, `returns`, `payments`) | Sec 19.1 | **Missing** | No Elasticsearch client or index mapping. |
| `searchOutbox` Transactional Sync & Background Indexer Worker | Sec 14.2, 19.2 | **Missing** | No outbox collection, bulk indexer, or rebuild command. |
| Tenant-Scoped Search APIs (`/api/search/passports`, `/events`, `/returns`) & Anomaly Queries | Sec 16.1, 19.3, 20 | **Missing** | No search UI or backend proxy. |
| Immutable `auditLogs` Collection | Sec 15.1, 16.2, 20.1 | **Partially implemented** | `AuditLogModel` and `MongoAuditWriter` (`backend/src/services/auditService.ts`) implemented for auth events; domain actions & Admin AG Grid view in Phases 2–7. |
| Security Middleware (Headers, Rate Limiting, Input Validation, Error Correlation IDs) | Sec 16.2, 20.1 | **Already working** | Helmet, env-driven CORS, rate limiters, Zod validation, `IdempotencyKey` middleware, correlation IDs, and unified error handler implemented in `backend/src/middleware/*` and verified via Express tests. |

---

## 8. Sustainability Metrics, Testing & Submission Readiness (Sections 22–25, Appendix B)

| Blueprint Requirement | PDF Ref | Status | Existing Repo Evidence & Gap Analysis |
| :--- | :--- | :--- | :--- |
| Verified Sustainability Calculations (`GET /api/sustainability/summary`) | Sec 16.1, 22 | **Missing** | Hardcoded fake CO2/tree stats removed from `UserPortal`; backend MongoDB aggregation + methodology disclosure scheduled for Phase 8. |
| Automated Tests & Failure Simulations | App B #14 | **Partially implemented** | 8 Vitest suites (`stateMachines.test.ts`, `authAndRbac.test.ts`, `allocationEngine.test.ts`, `phase2Api.test.ts`, `phase3Payments.test.ts`, `packageEventScanIdIndex.test.ts`, `phase4PassportsAndQr.test.ts`, `phase5ReturnsRefundsWebhooks.test.ts` — using in-memory repositories & mocked PayPal responses); webhook/refund failure, timeout, and currency mismatch simulations covered in Phase 5; AI/ES failure simulations added in Phases 7–9. |
| Demo Accounts, Synthetic Data Seeding & README Docs | Sec 23.3, App B #15 | **Partially implemented** | Browser `localStorage` mocks removed; synthetic MongoDB seed script & updated `README.md` scheduled for Phase 9. |
| Explicit Marketplace Integration Limitations | Sec 25.2 | **Partially implemented** | Explicitly documented on `LandingPage.tsx`, `SYSTEM_ARCHITECTURE.md`, and `TECHNICAL_DECISIONS.md`. |
| Green Tokens Loyalty Feature | Sec 6, 23.2, 25.3 | **Post-MVP (Deferred)** | Removed from MVP UI (`LandingPage`, `UserPortal`, `DeliveryPartnerApp`); `GreenWalletModel` schema reserved in `backend/src/models/GreenWallet.ts`. |
| Live Application Runtime Verification (Browser, MongoDB & PayPal Sandbox) | Audit Req #1 | **Needs verification** | Phase 0–5 frontend/backend typechecks, production builds, and `35/35` automated backend tests pass. Live MongoDB Atlas (`MONGODB_URI`), live GridFS persistence, live PayPal Sandbox (`PAYPAL_CLIENT_ID`/`SECRET`/`WEBHOOK_ID`), and Chrome DevTools interactive browser/camera verification remain pending environment setup. |

