# ReBoxify Implementation Roadmap

This roadmap aligns **Blueprint v2.0 Appendix B (15-step checklist)** and **Section 23.1 (P0 -> P1 -> P2 priorities)** with a safe migration of the existing `d:\Projects\Reboxify` repository.

---

## Priority & Scope Overview

- **P0 (Core Vertical Slice — Mandatory):** Auth & 6 RBAC roles -> Merchant Product & Order Intake -> Deterministic Fit & Allocation -> PayPal Sandbox Checkout & Capture -> QR Digital Passport -> Customer Return Request -> Collection-Centre Intake & Inspection -> PayPal Partial Refund + Webhooks -> Render HTTPS Deployment.
- **P1 (Operational Visibility, Scheduling, Search & Assistant):** Gemini Operations Assistant (Tool Gateway + draft confirmation) -> Gemini Packaging Explanations -> AG Grid Operational Tables -> Bryntum Pickup Scheduling & Rescheduling -> Elasticsearch Outbox Search.
- **P2 (Insights & Reliability Polish):** Gemini Merchant Operational Report -> Scheduled PayPal Webhook/Pending Reconciliation Worker -> Automated Failure Simulations & Demo Readiness.
- **Out of Scope (Post-MVP):** Green Tokens loyalty execution, Amazon/Flipkart/Shopify live checkout hooks, multi-centre routing automation, geographic route optimization, custom ML/CV/blockchain, live non-Sandbox PayPal payments.

---

## Phased Execution Plan

### Phase 0: Git Safety Checkpoint & Repository Hygiene — **COMPLETED & VERIFIED**
- **Step 0.1:** Verified clean `main` (`b39ab85`) and created branch `rebuild/v2-mvp` without altering `main` or merging `origin/ashwin`.
- **Step 0.2:** Updated `.gitignore` to ignore `.env`, `.env.*` (keeping `.env.example`), `.npmrc`, `dist`, `node_modules`, and `coverage`.
- **Step 0.3:** Migrated frontend into `frontend/` and fixed build hygiene:
  - Installed `tailwindcss`, `postcss`, `autoprefixer` with `tailwind.config.js` (`darkMode: 'class'`).
  - Imported `./index.css` in `frontend/src/index.tsx`; removed `cdn.tailwindcss.com` and conflicting `esm.sh` `importmap` from `frontend/index.html`.
  - Removed `GEMINI_API_KEY` from `frontend/vite.config.ts` `define`.
  - Removed unused `TechStack.tsx`, obsolete `localStorage` stores (`boxStore.ts`, `issueStore.ts`), Green Tokens UI, random Leaflet pickup pins, and 20s auto-issue deletion timers.
  - Added `docker-compose.yml` (MongoDB 7 `rs0` replica set + Elasticsearch 8) and `render.yaml` (Static Site + Web Service + Background Worker).

### Phase 1: Backend Foundation, State Machines & MongoDB Models (Appendix B #1–#2, P0) — **IMPLEMENTED (Verified with unit & HTTP tests; live MongoDB connection pending)**
- **Step 1.1:** Created `backend/` (Node.js + Express + TypeScript + Mongoose + Zod + Helmet + Express Rate Limit + CORS + safe startup with missing optional credentials).
- **Step 1.2:** Implemented all **5 independent state machines** (`Package`, `Order`, `Return`, `Payment`, `Pickup`) and cross-machine gates (`backend/src/stateMachines/*`), verified by Vitest.
- **Step 1.3:** Implemented all **18 Mongoose schemas** with unique & compound indexes (`backend/src/models/*`), including append-only mutation guards on `packageEvents` and TTL on `idempotencyKeys`.
- **Step 1.4:** Implemented `authService`, JWT Bearer auth, 6 RBAC roles (`CUSTOMER`, `MERCHANT_ADMIN`, `MERCHANT_STAFF`, `DELIVERY_PARTNER`, `COLLECTION_CENTRE`, `ADMIN`), tenant isolation (`resolveMerchantScope`), `auditLogs` writer, `/api/health`, `/api/auth/*`, `backend/src/worker.ts` skeleton, and `frontend` real auth + `CollectionCentrePortal` route shell (7/7 backend tests passing; live MongoDB persistence test pending local/Atlas MongoDB startup).

### Phase 2: Merchant, Products, Packaging Catalogue & Deterministic Engine (Appendix B #3–#4, P0) — **IMPLEMENTED (Verified with unit & HTTP tests; live MongoDB Atlas verification pending)**
- **Step 2.1:** Implemented `businessService.ts` + `businessRoutes.ts` (`POST /api/businesses`, `GET /api/businesses`, `GET /api/businesses/:id`, `PATCH /status` Admin approval, `PATCH /policies`).
- **Step 2.2:** Implemented `productService.ts` + `productRoutes.ts` (`POST /api/products`, `GET /api/products`) with tenant isolation and positive SKU measurement checks.
- **Step 2.3:** Implemented `packagingCatalogue.ts`, `packagingService.ts` & `inventoryRoutes.ts` (`S`/`M`/`L`/`XL` specs, `POST /api/inventory`, `GET /api/inventory`, `GET /api/inventory/catalogue`) enforcing `REBOXIFY_POOL`, `MERCHANT`, and `HYBRID` ownership separately from `currentCustodian`.
- **Step 2.4:** Implemented pure **Deterministic Packaging Allocation Engine** (`allocationEngine.ts`) covering dimension validation, 3D/upright orientation, fragility clearance & protection, liquid containment, weight limits, ownership priority, simple stacking, split shipments, and configurable deposit calculations.
- **Step 2.5:** Implemented `orderService.ts` + `orderRoutes.ts` (`POST /api/orders`, `GET /api/orders`, `GET /api/orders/:id`, `POST /api/orders/:id/allocate-package`) with atomic reservation, idempotency against duplicate allocations, and frontend integration in `AdminDashboard.tsx`, `CompanyAdminPortal.tsx`, and `UserPortal.tsx` (16/16 backend tests passing; live MongoDB persistence pending Atlas URI since Docker/`mongod` are unavailable locally).

### Phase 3: PayPal Sandbox Checkout & Capture (Appendix B #5, P0) — **IMPLEMENTED (Verified with mocked PayPal HTTP tests; live Sandbox & Atlas DB verification pending credentials)**
- **Step 3.1:** Implemented server-side PayPal REST v2 client (`paypalClient.ts`: OAuth2 token caching, `createOrder`, `captureOrder`, `getOrder` reconciliation, timeout classification) and `MongooseTransactionRepository` (`phase3Repositories.ts`) storing `paypalOrderId`, `captureId`, currency, and per-package `depositAllocations` inside MongoDB transactions.
- **Step 3.2:** Exposed `GET /api/payments/config`, `POST /api/payments/paypal/create-order`, `POST /api/payments/paypal/capture/:id`, `POST /api/payments/paypal/cancel/:id`, `GET /api/payments/:id`, and `GET /api/transactions` (`paymentService.ts`, `paymentRoutes.ts`) with strict backend amount calculation, currency/amount/reference verification, `Idempotency-Key` middleware, and uncertain-capture reconciliation (`19/19` backend tests passing).
- **Step 3.3:** Installed `@paypal/react-paypal-js` and implemented `PayPalOrderCheckout.tsx` in `UserPortal.tsx` (plus live transaction ledgers in `CompanyAdminPortal.tsx` and `AdminDashboard.tsx`), showing pre-payment deposit disclosure, return policy, and safe pending/cancelled/failed/captured states without exposing PayPal secrets. Live PayPal Sandbox & Atlas verification await `.env` credentials.

### Phase 4: Digital Packaging Passport, QR Security & Scan Workflows (Appendix B #6, P0) — **IMPLEMENTED (Verified with unit & HTTP tests; live Atlas DB & camera browser verification pending)**
- **Step 4.1:** Implemented cryptographically signed HMAC-SHA256 `RBXQR:v1` tokens (`qrService.ts`) with zero PII in QR payloads, key-rotation key-ring (`QR_KEY_ID`, `QR_PREVIOUS_KEY_ID`, `QR_PREVIOUS_SIGNING_SECRET`), expiration (`QR_TOKEN_TTL_SECONDS`), printable label data, and token reprinting (`tokenVersion` increment) / revocation (`qrRevoked`) in `Package.ts` & `packagingService.ts`.
- **Step 4.2:** Implemented `phase4Repositories.ts`, `passportService.ts`, and `packageRoutes.ts` (`GET /api/packages/partners`, `GET /api/packages/assigned/me`, `GET /api/packages/:packageId/passport`, `POST /api/packages/:packageId/scan`, `POST /api/packages/:packageId/assign-partner`, `POST /api/packages/:packageId/qr/reprint`, `POST /api/packages/:packageId/qr/revoke`) enforcing strict RBAC, cross-merchant isolation, delivery-partner assignment, Gate 1 `CAPTURED` payment before `DISPATCH`, duplicate/replay `scanId` rejection via unique partial index (`{ packageId: 1, scanId: 1 }`, `partialFilterExpression: { scanId: { $exists: true } }`), supervised `MANUAL_SUPERVISED` fallback reason checks, append-only `packageEvents` (`ACCEPTED` and `REJECTED`), atomic `searchOutbox` writes, and verified-only reuse counting (`packageEventScanIdIndex.test.ts` + `phase4PassportsAndQr.test.ts`). Note for pre-existing MongoDB collections: drop any legacy sparse `packageId_1_scanId_1` index cleanly after checking for null/duplicate `scanId`s before recreating the partial index so MongoDB does not raise `IndexOptionsConflict` (code `85`).
- **Step 4.3:** Installed `html5-qrcode` in `frontend/`, removed external CDN script from `index.html`, added `QrLabelModal.tsx` (`qrcode.react` SVG + print view), `PassportViewerModal.tsx`, and `PackageScannerPanel.tsx` (camera + clean unmount + manual fallback), and integrated Phase 4 workflows across `CompanyAdminPortal.tsx`, `AdminDashboard.tsx`, `DeliveryPartnerApp.tsx`, `CollectionCentrePortal.tsx`, and `UserPortal.tsx`. Live MongoDB Atlas persistence, live PayPal Sandbox verification, and interactive Chrome camera/UI runtime checks await environment setup.

### Phase 5: Returns, Collection-Centre Inspection & Partial Refunds (Appendix B #7–#8, P0) — **IMPLEMENTED (Verified with unit & HTTP tests; live Atlas/GridFS, PayPal Sandbox & webhook URL verification pending)**
- **Step 5.1:** Implemented `returnService.ts`, `phase5Repositories.ts`, `returnRoutes.ts`, and `evidenceStorage.ts` (`GridFsEvidenceStorage` on `returnEvidence` bucket with JPEG/PNG/WebP magic-byte + 5 MB validation): customer & merchant-on-behalf return initiation (`PICKUP`, `DROP_OFF`, `NEXT_DELIVERY_SWAP`), deadline/late tracking, duplicate return blocking, partner assignment (`POST /api/returns/:id/assign-partner`), QR-authorised collection (`/collect`), centre intake (`/receive`), private evidence upload/download (`/evidence`, `/evidence/:fileId`), and `packageEvents` / `searchOutbox` recording.
- **Step 5.2:** Updated `CollectionCentrePortal.tsx`, `DeliveryPartnerApp.tsx`, `UserPortal.tsx`, `CompanyAdminPortal.tsx`, and `AdminDashboard.tsx` (plus `ReturnEvidenceUploader.tsx`, `ReturnDetailModal.tsx`, `ReturnsManagementSection.tsx`) for intake scanning, evidence upload & authorized image viewing, 4-point structured inspection, Gate 3 independent cleaning/recirculation (`AVAILABLE` with `reuseCount + 1` only upon passing inspection), and zero fake 20s deletion timers.
- **Step 5.3:** Implemented deterministic server-side refund calculation (`refundCalculation.ts`, `REBOXIFY_REFUND_RULES_V2`) across all 8 blueprint conditions (`GOOD`, `MINOR_WEAR`, `MINOR_DAMAGE`, `MAJOR_DAMAGE`, `CONTAMINATED`, `MISSING_PACKAGING`, `UNUSABLE`, `WRONG_PACKAGE`), rejecting client-supplied amounts (`400 CLIENT_REFUND_AMOUNT_FORBIDDEN`), routing `NEEDS_REVIEW` cases safely, separating customer/inspector/approver actions, reserving `pendingRefundAmount`, calling `POST /v2/payments/captures/{capture_id}/refund` with unique `PayPal-Request-Id`, and handling timeouts (`reconcile-refund`) and failed retries cleanly.
- **Step 5.4:** Implemented `webhookService.ts` & `webhookRoutes.ts` (`POST /api/webhooks/paypal`) enforcing PayPal cryptographic signature verification (`POST /v1/notifications/verify-webhook-signature`), `WebhookEventModel` (`providerEventId` unique deduplication), live `getOrder`/`getRefund` reconciliation (supporting out-of-order capture & refund finalization while ignoring forged/unsolicited refunds), verified in `phase5ReturnsRefundsWebhooks.test.ts` (`35/35` backend tests passing). Live MongoDB Atlas transactions/GridFS, live PayPal Sandbox refunds, and live HTTPS Render webhook delivery remain pending external credentials & Phase 6 deployment.

### Phase 6: Early Render Deployment & Worker Setup (Appendix B #9, P0)
- **Step 6.1:** Add `render.yaml` defining Render Static Site (`frontend`), Web Service (`backend/src/server.ts`), and Background Worker (`backend/src/worker.ts`).
- **Step 6.2:** Configure Render environment variables and register the live HTTPS Render webhook URL in the PayPal Developer Sandbox dashboard.
- **Step 6.3:** Implement Background Worker PayPal reconciliation loop (query `GET /v2/checkout/orders/{id}` / captures for stuck `CAPTURE_PENDING` and `REFUND_PENDING` states, P2).

### Phase 7: AG Grid, Bryntum Scheduler & Elasticsearch (Appendix B #10–#12, P1)
- **Step 7.1 (AG Grid):** Replace plain HTML tables in Merchant, Collection Centre, and Admin portals with `ag-grid-react` across all 6 tables (Merchant Inventory, Orders & Packages, Returns, Transactions & Refunds, Inspection Queues, Audit Log) with server pagination/filter/sort + CSV export.
- **Step 7.2 (Bryntum Scheduler):** Implement `GET /api/pickups`, `POST /api/pickups`, `PATCH /api/pickups/:id` with backend validation (zone match, working hours, daily capacity, double-booking prevention, collection-centre capacity, optimistic version conflict detection) and integrate Bryntum Scheduler React UI (or confirm licence/trial setup first).
- **Step 7.3 (Elasticsearch):** Implement outbox worker indexing into `passports`, `package-events`, `returns`, and sanitised `payments`; expose `/api/search/passports`, `/events`, `/returns` with server-enforced tenant filtering, investigation queries (duplicate/replayed scans, stuck packages, failed refunds), rebuild CLI, and graceful degraded notice when ES is unreachable.

### Phase 8: Gemini AI Integration Service & Sustainability Reporting (Appendix B #13, P1–P2)
- **Step 8.1:** Implement `backend/src/services/aiService.ts` using `@google/genai` function calling + role-scoped Tool Gateway (7 read tools + 2 confirmation-gated proposal tools: `draft_return_request`, `draft_pickup_reschedule`), input/output validation, prompt-injection delimiters, `aiInteractions` logging, and template fallbacks.
- **Step 8.2:** Implement AI endpoints (`POST /api/ai/assistant/chat`, `/actions/:id/confirm`, `/packaging/explain`, `/returns/:id/summary`, `/insights/merchant-report`) and Customer/Merchant/Centre UI panels with AI labels and cited record links.
- **Step 8.3:** Implement `GET /api/sustainability/summary` (verified reuse metrics + documented lifecycle emissions formula + methodology disclosure) and update `CompanyAdminPortal` ESG report to consume real backend figures.

### Phase 9: Verification, Failure Simulations, Seeding & Demo Readiness (Appendix B #14–#15, P2)
- **Step 9.1:** Write automated tests covering state machines, deterministic fit engine, partial refund balance math, webhook signature/deduplication, AI tool-gateway authorization, and simulated outages (duplicate webhook, refund timeout reconciliation, Gemini outage fallback, Elasticsearch outage fallback).
- **Step 9.2:** Create idempotent synthetic seed script (`backend/src/seeds/seedDemo.ts`) for Sandbox demo accounts, merchant, products, S/M/L/XL packages, delivery partners, collection centres, and sample events (current 2026 dates).
- **Step 9.3:** Rewrite `README.md` (architecture, env vars, local & Render runbooks, Sandbox test instructions, open-source licence, explicit marketplace limitation notice) and rehearse the 3-minute Section 24 demo flow.

