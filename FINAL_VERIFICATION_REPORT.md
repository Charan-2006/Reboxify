# ReBoxify — Final Pre-Phase 6 Verification Report

**Date:** 2026-11-12  
**Scope:** Remaining Verification Milestones 1–3 (Return & Refund, Cleaning & Recirculation, and Final Regression)  
**Target Order & Package:** `ORD-MWDJGVRW-A094` (`6af5b46d9bc17eb3253be250`) / `RBX-CHN-3748BA` (`6af5afe0c20f69ce15247854`)  
**PayPal Capture ID:** `3FM91774FU1612010` (PayPal Order `69T8639186902252W`, `USD 30.00` captured, `USD 5.00` refundable deposit)  
**Verification Harness:** Real Express application ([app.ts](file:///d:/Projects/Reboxify/backend/src/app.ts)) over local HTTP (`127.0.0.1`) connected to **live MongoDB Atlas (`replicaSetSupported: true`)**, **live MongoDB GridFS (`returnEvidence`)**, and **live PayPal Sandbox REST API (`api-m.sandbox.paypal.com`)**. Zero source files were modified and zero refunds were mocked or simulated.

---

## Executive Summary

| Milestone | Status | Key Outcome |
| :--- | :--- | :--- |
| **1. Return & Refund (Live)** | **PASS** | Return `RET-20261112-6CA306` completed full `PICKUP` -> `COLLECTED` -> `RECEIVED` -> GridFS evidence -> `GOOD` inspection (`PASS`) -> **real PayPal Sandbox partial refund `8BW26311PS6941513` (`USD 5.00`, `COMPLETED`)**. |
| **2. Cleaning & Recirculation (Live)** | **PASS** | Package `RBX-CHN-3748BA` completed `MARK_CLEANING` -> `RELEASE_AVAILABLE`; status restored to `AVAILABLE`, `reuseCount` incremented **`0 -> 1` (exactly once)**, custody returned to `MERCHANT` (`EcoLoop Goods (CHN-HUB-01)`), and `21` append-only `packageEvents` verified. |
| **3. Final Regression & Gates** | **PASS (with documented Phase 6+ blockers)** | Backend Vitest **`9/9` files (`37/37` tests)**, backend `tsc --noEmit` + `tsc`, and frontend `tsc --noEmit` + `vite build` all passed. Critical gates verified; unverified external integrations & deployment blockers listed in Section 4. |

---

## 1. Milestone 1 — Return and Refund (Live MongoDB Atlas + Real PayPal Sandbox)

### 1.1 Pre-Return Fulfilment Completion
At the start of verification, paid order `ORD-MWDJGVRW-A094` was `PAID` and package `RBX-CHN-3748BA` was `PACKED` (`qrTokenVersion: 3`, `reuseCount: 0`). Because [returnService.ts](file:///d:/Projects/Reboxify/backend/src/services/returnService.ts#L222-L227) enforces that returns can only be initiated for `DELIVERED` orders (`WITH_CUSTOMER` package), the remaining forward-fulfilment steps were executed first through the live APIs:

1. **QR Label Reprint:** `POST /api/packages/RBX-CHN-3748BA/qr/reprint` (`MERCHANT_ADMIN`) -> `200 OK`, issued signed `RBXQR:v1` token (`tokenVersion: 4`, `keyId: k1`).
2. **Assign Delivery Partner:** `POST /api/packages/RBX-CHN-3748BA/assign-partner` (`MERCHANT_ADMIN`) -> `200 OK`, assigned `Preview Delivery Partner` (`6af5adcade16d8c25a9d6464`).
3. **Dispatch Scan (Gate 1 Verified):** `POST /api/packages/RBX-CHN-3748BA/scan` (`action: "DISPATCH"`, `scanMode: "QR_TOKEN"`, `MERCHANT_ADMIN`) -> `200 OK`. `Package.status` -> `DISPATCHED`, `Order.status` -> `DISPATCHED`, custodian -> `DELIVERY_PARTNER`.
4. **Delivery Scan:** `POST /api/packages/RBX-CHN-3748BA/scan` (`action: "DELIVER"`, `scanMode: "QR_TOKEN"`, `DELIVERY_PARTNER`) -> `200 OK`. `Package.status` -> `WITH_CUSTOMER`, `Order.status` -> `DELIVERED`, custodian -> `CUSTOMER`.

### 1.2 Return Initiation, Collection, Intake, Evidence & Inspection
1. **Initiate Return (`CUSTOMER` `cust@gmail.com`):** `POST /api/returns` (`mode: "PICKUP"`, `orderId: "6af5b46d9bc17eb3253be250"`, `packageId: "RBX-CHN-3748BA"`) -> `201 Created`
   - Return ID: `6af5ca6f36463abba854d70f` | Return Number: **`RET-20261112-6CA306`**
   - Return Status: `PICKUP_SCHEDULED` | Package Status: `RETURN_REQUESTED`
   - Pickup Record Created: `6af5ca6f36463abba854d711` | `originalDeposit`: `5` (`USD`)
2. **Assign Return Partner (`MERCHANT_ADMIN`):** `POST /api/returns/6af5ca6f36463abba854d70f/assign-partner` -> `200 OK` (`Preview Delivery Partner`).
3. **QR Collection (`DELIVERY_PARTNER`):** `POST /api/returns/6af5ca6f36463abba854d70f/collect` (`scanMode: "QR_TOKEN"`) -> `200 OK`
   - Return Status: `COLLECTED` | Package Status: `COLLECTED` | `collectedAt`: `2026-11-12T14:17:22.323Z`
4. **Collection Centre Receipt (`COLLECTION_CENTRE`):** `POST /api/returns/6af5ca6f36463abba854d70f/receive` (`scanMode: "QR_TOKEN"`) -> `200 OK`
   - Return Status: `RECEIVED` | Package Status: `AT_CENTRE` | `receivedAt`: `2026-11-12T14:17:23.565Z`
5. **GridFS Photo Evidence Upload & Download (`COLLECTION_CENTRE`):**
   - `POST /api/returns/6af5ca6f36463abba854d70f/evidence` (`intake-good.png`, `image/png`) -> `201 Created`, GridFS `fileId: "6af5ca7436463abba854d74f"`, `sizeBytes: 68`.
   - `GET /api/returns/6af5ca6f36463abba854d70f/evidence/6af5ca7436463abba854d74f` -> `200 OK`, `68 bytes` retrieved from MongoDB Atlas `returnEvidence` bucket.
6. **4-Point Inspection (`COLLECTION_CENTRE`):** `POST /api/returns/6af5ca6f36463abba854d70f/inspect` (`condition: "GOOD"`, all 4 checklist flags `true`) -> `200 OK`
   - Return Status: `UNDER_INSPECTION` | Package Status: `INSPECTED`
   - `inspection.outcome`: `PASS` | `inspectedAt`: `2026-11-12T14:17:26.545Z`
   - Server-calculated `refundEligibility`: `eligible: true`, `originalDeposit: 5`, `totalDeductions: 0`, **`calculatedAmount: 5`**, `currency: "USD"`, `ruleVersion: "REBOXIFY_REFUND_RULES_V2"`.

### 1.3 Real PayPal Partial Refund & Dual Verification (PayPal + MongoDB)
- **Trigger (`COLLECTION_CENTRE`):** `POST /api/returns/6af5ca6f36463abba854d70f/approve` (with `Idempotency-Key`) -> **`200 OK`** (`pending: false`, `alreadyRefunded: false`, `zeroRefundApproved: false`).
- **PayPal Sandbox API Verification (Direct `GET` calls against `api-m.sandbox.paypal.com`):**
  - `GET /v2/payments/refunds/8BW26311PS6941513` -> **`status: "COMPLETED"`**, `amount: { currency_code: "USD", value: "5.00" }`, `invoice_id: "RET-20261112-6CA306"`, `custom_id: "ORD-MWDJGVRW-A094"`, `payer.merchant_id: "NVR75FYDUP4R6"`, `total_refunded_amount: "5.00 USD"`.
  - `GET /v2/payments/captures/3FM91774FU1612010` -> `200 OK`, **`status: "PARTIALLY_REFUNDED"`**, original capture `USD 30.00` (`update_time: 2026-11-12T14:17:30Z`).
  - `GET /v2/checkout/orders/69T8639186902252W` -> confirms capture `3FM91774FU1612010` (`PARTIALLY_REFUNDED`) and refund `8BW26311PS6941513` (`COMPLETED`, `USD 5.00`).
- **MongoDB Atlas Persistence Verification:**
  - `refunds` (`6af5ca7736463abba854d776`): `state: "REFUNDED"`, `captureId: "3FM91774FU1612010"`, `providerRefundId: "8BW26311PS6941513"`, `providerStatus: "COMPLETED"`, `amount: 5`, `currency: "USD"`, `confirmedAt: "2026-11-12T14:17:33.599Z"`.
  - `transactions` (`6af5c79ae71a2bf868e0050f`): `state: "PARTIALLY_REFUNDED"`, `depositAllocations: [{ packageId: "RBX-CHN-3748BA", allocatedDeposit: 5, refundedAmount: 5, pendingRefundAmount: 0 }]`.
  - `returns` (`6af5ca6f36463abba854d70f`): `status: "CLOSED"`, `decision.outcome: "APPROVED"`, `refundId: "6af5ca7736463abba854d776"`.
  - `GET /api/returns/6af5ca6f36463abba854d70f/refund` (`CUSTOMER`) -> `200 OK`, returns persisted `REFUNDED` record.

---

## 2. Milestone 2 — Cleaning and Recirculation

1. **QR Reprint at Centre (`COLLECTION_CENTRE`):** `POST /api/packages/RBX-CHN-3748BA/qr/reprint` -> `200 OK` (`tokenVersion: 5`, `keyId: k1`).
2. **Mark Cleaning (`COLLECTION_CENTRE`):** `POST /api/packages/RBX-CHN-3748BA/scan` (`action: "MARK_CLEANING"`, `scanMode: "QR_TOKEN"`) -> `200 OK`
   - `Package.status`: `INSPECTED -> CLEANING` | `reuseCount`: `0`
3. **Release to Available (`COLLECTION_CENTRE`):** `POST /api/packages/RBX-CHN-3748BA/scan` (`action: "RELEASE_AVAILABLE"`, `scanMode: "QR_TOKEN"`) -> `200 OK`
   - `Package.status`: `CLEANING -> AVAILABLE`
   - **`reuseCount`: `1`** (incremented from `0` to `1` **exactly once**)
   - `currentOrderId`: cleared (`undefined`) | `assignedPartnerUserId`: cleared
   - `lastCleanedAt`: `2026-11-12T14:19:03.316Z` | `lastInspectionOutcome`: `"PASS"`
4. **Passport & Custody History (`GET /api/packages/RBX-CHN-3748BA/passport` + MongoDB `packageEvents`):**
   - `ownership`: `{ ownerType: "MERCHANT", ownerId: "6af5adcade16d8c25a9d6471", ownerLabel: "EcoLoop Goods" }`
   - `currentCustodian`: `{ custodianType: "MERCHANT", custodianId: "6af5adcade16d8c25a9d6471", label: "EcoLoop Goods (CHN-HUB-01)", assignedAt: "2026-11-12T14:19:03.316Z" }`
   - `sustainability`: `{ verified: true, verifiedReuseCycles: 1, remainingLifecycleCycles: 49, singleUsePackagingAvoided: 1 }`
   - **Full Append-Only `packageEvents` (`21` events in MongoDB Atlas):**
     1. `PACKAGE_CREATED` (`ADMIN`, `2026-11-12T12:24:00.641Z`)
     2. `LABEL_REPRINTED` v2 (`MERCHANT_ADMIN`, `12:26:58.805Z`)
     3. `PACKAGE_RESERVED` (`CUSTOMER`, `12:43:25.786Z`)
     4. `LABEL_REPRINTED` v3 (`MERCHANT_ADMIN`, `12:45:53.839Z`)
     5. `PACKAGE_PACKED` (`MERCHANT_ADMIN`, `12:46:17.222Z`)
     6. `SCAN_REJECTED` (`MERCHANT_ADMIN`, `12:47:48.882Z` — `DISPATCH_PAYMENT_GATE_BLOCKED` before PayPal capture)
     7. `LABEL_REPRINTED` v4 (`MERCHANT_ADMIN`, `14:17:11.338Z`)
     8. `PARTNER_ASSIGNED` (`MERCHANT_ADMIN`, `14:17:12.731Z`)
     9. `PACKAGE_DISPATCHED` (`MERCHANT_ADMIN`, `14:17:14.904Z`)
     10. `PACKAGE_DELIVERED` (`DELIVERY_PARTNER`, `14:17:17.059Z`)
     11. `RETURN_REQUESTED` (`CUSTOMER`, `14:17:19.032Z`)
     12. `RETURN_PARTNER_ASSIGNED` (`MERCHANT_ADMIN`, `14:17:21.349Z`)
     13. `PACKAGE_RETURN_COLLECTED` (`DELIVERY_PARTNER`, `14:17:22.323Z`)
     14. `RETURN_RECEIVED_AT_CENTRE` (`COLLECTION_CENTRE`, `14:17:23.565Z`)
     15. `RETURN_EVIDENCE_UPLOADED` (`COLLECTION_CENTRE`, `14:17:24.957Z`)
     16. `RETURN_INSPECTED` (`COLLECTION_CENTRE`, `14:17:26.545Z`)
     17. `REFUND_REQUESTED` (`COLLECTION_CENTRE`, `14:17:27.602Z`)
     18. `REFUND_CONFIRMED` (`COLLECTION_CENTRE`, `14:17:33.599Z`)
     19. `LABEL_REPRINTED` v5 (`COLLECTION_CENTRE`, `14:19:00.385Z`)
     20. `PACKAGE_MARKED_CLEANING` (`COLLECTION_CENTRE`, `14:19:01.038Z`)
     21. `PACKAGE_RELEASED_AVAILABLE` (`COLLECTION_CENTRE`, `14:19:03.316Z`)
   - **Audit & Outbox Persistence:** `auditLogs` recorded all corresponding actions (`QR_LABEL_REPRINTED`, `DELIVERY_PARTNER_ASSIGNED`, `PACKAGE_SCAN_ACCEPTED`, `RETURN_INITIATED`, `RETURN_PARTNER_ASSIGNED`, `RETURN_COLLECTED`, `RETURN_RECEIVED_AT_CENTRE`, `RETURN_EVIDENCE_UPLOADED`, `RETURN_INSPECTED`, `REFUND_CONFIRMED`), and `39` recent `searchOutbox` entries were queued atomically.

---

## 3. Milestone 3 — Final Regression & Gate Verification

### 3.1 Automated Test Suites, Typechecks & Production Builds

| Check | Command | Scope / Environment | Result |
| :--- | :--- | :--- | :--- |
| Backend Unit & HTTP Regression | `npm test` (`vitest run` in `backend/`) | `9` test files, `37` tests (in-memory repositories & mocked `PayPalClient`; run with localhost socket permission outside sandbox — inside sandbox `supertest` socket tests fail with `connect EACCES 127.0.0.1`) | **PASS (`9/9` files, `37/37` tests)** |
| Backend Typecheck | `npm run typecheck` (`tsc --noEmit` in `backend/`) | Strict TypeScript check across `backend/src` | **PASS (`exit 0`)** |
| Backend Production Build | `npm run build` (`tsc` in `backend/`) | Emits `backend/dist` | **PASS (`exit 0`)** |
| Frontend Typecheck | `npm run typecheck` (`tsc --noEmit` in `frontend/`) | Strict TypeScript check across `frontend/src` | **PASS (`exit 0`)** |
| Frontend Production Build | `npm run build` (`vite build` in `frontend/`) | `95` modules bundled (`dist/index.html`, `dist/assets/index-DyhgijfA.css` `39.85 kB`, `dist/assets/index-zjdzXaU3.js` `783.29 kB`) | **PASS (`exit 0`)** |

**Vitest File Breakdown (`37/37` passed):**
- [stateMachines.test.ts](file:///d:/Projects/Reboxify/backend/tests/stateMachines.test.ts): `3/3`
- [allocationEngine.test.ts](file:///d:/Projects/Reboxify/backend/tests/allocationEngine.test.ts): `7/7`
- [packageEventScanIdIndex.test.ts](file:///d:/Projects/Reboxify/backend/tests/packageEventScanIdIndex.test.ts): `4/4`
- [authAndRbac.test.ts](file:///d:/Projects/Reboxify/backend/tests/authAndRbac.test.ts): `4/4`
- [phase2Api.test.ts](file:///d:/Projects/Reboxify/backend/tests/phase2Api.test.ts): `2/2`
- [orderCreationTransaction.test.ts](file:///d:/Projects/Reboxify/backend/tests/orderCreationTransaction.test.ts): `2/2`
- [phase3Payments.test.ts](file:///d:/Projects/Reboxify/backend/tests/phase3Payments.test.ts): `3/3`
- [phase4PassportsAndQr.test.ts](file:///d:/Projects/Reboxify/backend/tests/phase4PassportsAndQr.test.ts): `6/6`
- [phase5ReturnsRefundsWebhooks.test.ts](file:///d:/Projects/Reboxify/backend/tests/phase5ReturnsRefundsWebhooks.test.ts): `6/6`

### 3.2 Critical Gate Verification Matrix

| Gate Category | Mechanism Verified | Verification Evidence |
| :--- | :--- | :--- |
| **Payment Gate (Gate 1)** | [canDispatchOrder](file:///d:/Projects/Reboxify/backend/src/stateMachines/gates.ts#L16-L34) requires `CAPTURED` payment before `DISPATCH` | **Live:** `evt_2dfa8e5f...` rejected `DISPATCH` (`DISPATCH_PAYMENT_GATE_BLOCKED`) when `CREATED`; `evt_478d6af3...` allowed `DISPATCH` after capture `3FM91774FU1612010`. **Tests:** `stateMachines.test.ts`, `phase4PassportsAndQr.test.ts`. |
| **Return & Refund Gate (Gate 2)** | [canInitiateRefundFromReturn](file:///d:/Projects/Reboxify/backend/src/stateMachines/gates.ts#L39-L62), [calculateReturnRefund](file:///d:/Projects/Reboxify/backend/src/services/refundCalculation.ts#L57-L269), anti-self-inspection/approval, `CLIENT_REFUND_AMOUNT_FORBIDDEN` | **Live:** Return `RET-20261112-6CA306` required `DELIVERED` order, `PASS` inspection, non-customer inspector/approver, and capped refund to `$5.00`. **Tests:** `phase5ReturnsRefundsWebhooks.test.ts` (`6/6`). |
| **Cleaning & Reuse Gate (Gate 3)** | [canCleanAndRecirculatePackage](file:///d:/Projects/Reboxify/backend/src/stateMachines/gates.ts#L67-L78), [shouldIncrementReuseCount](file:///d:/Projects/Reboxify/backend/src/stateMachines/gates.ts#L83-L93) | **Live:** `RBX-CHN-3748BA` transitioned `INSPECTED -> CLEANING -> AVAILABLE` with `reuseCount` `0 -> 1`. **Tests:** `phase4PassportsAndQr.test.ts`, `phase5ReturnsRefundsWebhooks.test.ts` (including cleaning during `REFUND_PENDING`). |
| **QR Security & Replay Gate** | [qrService.ts](file:///d:/Projects/Reboxify/backend/src/services/qrService.ts), [PackageEvent.ts](file:///d:/Projects/Reboxify/backend/src/models/PackageEvent.ts) partial unique `{ packageId: 1, scanId: 1 }` | **Live:** Signed `RBXQR:v1` tokens (`k1`), versioned reprints (`v3 -> v4 -> v5`), and unique `scanId` scans verified. **Tests:** `phase4PassportsAndQr.test.ts`, `packageEventScanIdIndex.test.ts`. |
| **Inventory & Allocation Gate** | [allocationEngine.ts](file:///d:/Projects/Reboxify/backend/src/services/allocationEngine.ts), [orderService.ts](file:///d:/Projects/Reboxify/backend/src/services/orderService.ts) | **Live:** `ORD-MWDJGVRW-A094` allocated `RBX-CHN-3748BA` (`MERCHANT` class `M`) and returned it to `AVAILABLE` after recirculation. **Tests:** `allocationEngine.test.ts`, `phase2Api.test.ts`, `orderCreationTransaction.test.ts`. |
| **State-Machine Gates** | [machines.ts](file:///d:/Projects/Reboxify/backend/src/stateMachines/machines.ts) (`Package`, `Order`, `Return`, `Payment`, `Pickup`) | **Tests:** `stateMachines.test.ts` (`3/3`). *(See Section 4.2 for zero-refund bypass bug in `returnService.ts`.)* |

---

## 4. Unverified External Integrations & Deployment Blockers

### 4.1 Unverified External Integrations
1. **PayPal Live Webhook Delivery & Signature Verification (`POST /api/webhooks/paypal`):** `PAYPAL_WEBHOOK_ID` is empty in [backend/.env](file:///d:/Projects/Reboxify/backend/.env#L21) and local verification has no public HTTPS URL registered in PayPal Developer Dashboard. `verifyWebhookSignature` is only covered with mocked responses in `phase5ReturnsRefundsWebhooks.test.ts`.
2. **Google Gemini AI (`@google/genai`):** `GEMINI_API_KEY` is unset in [backend/.env](file:///d:/Projects/Reboxify/backend/.env#L24), and Phase 8 AI service/tool-gateway routes (`/api/ai/*`) are not yet implemented.
3. **Elasticsearch (`ELASTICSEARCH_URL` / `ELASTICSEARCH_API_KEY`):** Unset in [backend/.env](file:///d:/Projects/Reboxify/backend/.env#L28-L29); transactional `searchOutbox` entries are persisted in MongoDB Atlas (`39` recent documents observed), but no Phase 7 indexer consumer or `/api/search/*` endpoint exists yet.
4. **Render Background Worker Scheduling ([worker.ts](file:///d:/Projects/Reboxify/backend/src/worker.ts)):** Currently an empty heartbeat loop; periodic `reconcileStuckPendingRefunds()` and `searchOutbox` polling are deferred to Phases 6–7.
5. **Interactive Browser UI Walkthrough for Return/Refund/Cleaning Portals:** Milestones 1–2 were verified via live HTTP requests against Express (`createApp()`), MongoDB Atlas, GridFS, and PayPal Sandbox REST APIs rather than manual browser clicks across `UserPortal`, `DeliveryPartnerApp`, and `CollectionCentrePortal`.

### 4.2 Deployment Blockers & Known Technical Risks
1. **CRITICAL — `reboxify-worker` Production Crash in [render.yaml](file:///d:/Projects/Reboxify/render.yaml#L43-L65):** `reboxify-worker` omits `JWT_SECRET`, `SESSION_SECRET`, and `QR_SIGNING_SECRET`, while [worker.ts](file:///d:/Projects/Reboxify/backend/src/worker.ts#L2) imports [env.ts](file:///d:/Projects/Reboxify/backend/src/config/env.ts#L76-L78), which throws when `NODE_ENV=production` and any of those secrets is absent. Must be fixed before Phase 6 Render deploy.
2. **Zero-Refund State Machine Bypass ([returnService.ts](file:///d:/Projects/Reboxify/backend/src/services/returnService.ts#L1589-L1678)):** When `refundAmount <= 0` for `GOOD`/`MINOR_WEAR`, execution falls through `UNDER_INSPECTION -> CLOSED` without enforcing `returnStateMachine` rejection, and `NEEDS_REVIEW` writes `REJECTED`. (Did not affect this `$5.00` GOOD return, but should be fixed.)
3. **`runInTransaction` Standalone Fallback ([db.ts](file:///d:/Projects/Reboxify/backend/src/config/db.ts#L62-L75)):** Services do not pass `{ requireReplicaSet: config.nodeEnv === 'production' }`, so a non-replica-set MongoDB URI would silently run non-atomically.
4. **`PickupModel` Status Sync Gap:** `PickupModel` (`6af5ca6f36463abba854d711`) created during `PICKUP` return initiation remained `status: "UNASSIGNED"` after `assignReturnPartner` and `collectReturn` (awaits Phase 7 `/api/pickups` integration).
5. **Dual Scan Path (`PackageScannerPanel` vs `/api/returns/:id/*`):** Scanning `COLLECT_RETURN` or `RECEIVE_CENTRE` via `/api/packages/:packageId/scan` transitions `Package` without transitioning the linked `Return` record.
6. **Production Environment Secrets:** [backend/.env](file:///d:/Projects/Reboxify/backend/.env) uses placeholder dev values for `JWT_SECRET`, `SESSION_SECRET`, and `QR_SIGNING_SECRET`; real generated secrets and `NODE_ENV=production` are required on Render (`reboxify-api` generates them via `render.yaml`).

---

**Next Step:** Awaiting user approval before starting **Phase 6**.

