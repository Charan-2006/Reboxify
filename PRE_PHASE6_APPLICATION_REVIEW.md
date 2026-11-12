# ReBoxify — Pre-Phase 6 Complete Application Preview & Audit

**Audit Scope:** Read-only inspection of branch `rebuild/v2-mvp` after Phases 0–5 (prior to Phase 6).  
**Important Rule Followed:** No source code, database schemas, indexes, or environment files were modified; no destructive DB actions or live PayPal transactions were triggered.

---

## 1. Overall Application Status

ReBoxify has been substantially rebuilt from the original `main` client-side `localStorage` prototype into a decoupled **React 19 + TypeScript + Tailwind CSS v3 + Vite 6** frontend (`frontend/`) and **Node.js + Express + TypeScript + Mongoose 8** backend (`backend/`) aligned with **Blueprint v2.0** across Phases 0–5:

- **Core Phases 0–5 Operational Scope (Implemented in Codebase & Covered by Mocked Unit/HTTP Tests):**
  - Authentication & 6-role RBAC (`CUSTOMER`, `MERCHANT_ADMIN`, `MERCHANT_STAFF`, `DELIVERY_PARTNER`, `COLLECTION_CENTRE`, `ADMIN`) with tenant isolation.
  - Merchant onboarding & policy controls, SKU product catalog, 3-model reusable PP inventory (`REBOXIFY_POOL`, `MERCHANT`, `HYBRID`), and the 8-step deterministic packaging allocation engine (`allocationEngine.ts`).
  - Backend-calculated itemised checkout & PayPal Sandbox REST API v2 order/capture lifecycle with per-package refundable deposit tracking (`depositAllocations[]`).
  - Cryptographically signed HMAC-SHA256 `RBXQR:v1` QR tokens (`qrService.ts`), key-ring rotation, print labels, revocation/reprint, camera/manual authorised scan workflows (`PackageScannerPanel.tsx`), and append-only `packageEvents` (including the corrected partial unique `{ packageId: 1, scanId: 1 }` index).
  - Reverse logistics return initiation (`PICKUP`, `DROP_OFF`, `NEXT_DELIVERY_SWAP`), QR collection & collection-centre intake, private GridFS photo evidence storage (`returnEvidence`), structured 4-point inspection, deterministic server-side partial/full/zero refund calculation, PayPal capture refunds (`POST /v2/payments/captures/{id}/refund`), and cryptographically verified PayPal webhook reconciliation (`POST /api/webhooks/paypal`).
- **Build & Automated Test Snapshot (Verified):**
  - Backend `tsc --noEmit` & `tsc` build: **Pass (`exit 0`)**.
  - Frontend `tsc --noEmit` & `vite build`: **Pass (`exit 0`, 95 modules transformed)**.
  - Backend `vitest run`: **`8` files, `35/35` tests pass** using in-memory repository implementations and mocked `PayPalClient` responses.
- **What Remains Unverified Live or Unbuilt (Phases 6–9):**
  - **Zero live database/provider verification on this host:** Local `docker`, `mongod`, `.env` credentials (`MONGODB_URI`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `GEMINI_API_KEY`, `ELASTICSEARCH_URL`), and Chrome remote debugging (`DevToolsActivePort`) were unavailable here.
  - **Phases 6–9 modules unbuilt:** Render background worker loops (`worker.ts` is an empty heartbeat; `SearchOutbox` has writers only and zero consumers), Pickup Scheduler API + Bryntum timeline integration, AG Grid Community tables, Elasticsearch search endpoints, Gemini AI Service/Tool Gateway, live Sustainability metrics aggregation, `GET /api/audit-logs`, demo database seeding (`seedDemo.ts`), and `README.md` update.

---

## 2. All Five Portal Reviews

Routing is managed in [App.tsx](file:///d:/Projects/Reboxify/frontend/src/App.tsx) via `HashRouter` with role-guarded routes and portal-specific login routes in [LoginPage.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/LoginPage.tsx) (`CUSTOMER` self-registration enabled only at `/#/user-login`; operational roles are admin/merchant provisioned).

### 2.1 UserPortal (`/#/user-portal` — `CUSTOMER`)
- **File:** [UserPortal.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/UserPortal.tsx)
- **Available Sections:**
  1. Sticky top header (`ReBoxify` logo -> `/`, `Customer Portal`, user name/email, `Sign Out`).
  2. Live [SystemStatusBanner.tsx](file:///d:/Projects/Reboxify/frontend/src/components/SystemStatusBanner.tsx) (`GET /api/health`).
  3. **Storefront Order & Packaging Allocation** form (`select` merchant, `select` product, quantity, fulfilment location, recipient name, delivery zone, address).
  4. Informational cards: **Digital Packaging Passports & Returns** and **Gemini Assistant (Phase 8)** placeholder notice.
  5. **Your Orders, Deposit Disclosure & PayPal Sandbox Checkout** cards (order status badge, allocated packages, inline per-package return initiation selector, embedded [PayPalOrderCheckout.tsx](file:///d:/Projects/Reboxify/frontend/src/components/PayPalOrderCheckout.tsx)).
  6. **Your Returns, Evidence & PayPal Partial Refund Status** cards (`ReturnDetailModal` + `ReturnEvidenceUploader`).
- **Buttons & Actions Connected to Real APIs:**
  - `Place Order & Allocate Reusable Package` -> `POST /api/orders` (`autoAllocate: true`).
  - `PayPalButtons` (`createOrder`, `onApprove`, `onCancel`) & `Reconcile Status` (when `CAPTURE_PENDING`) -> `POST /api/payments/paypal/create-order`, `POST /api/payments/paypal/capture/:id`, `POST /api/payments/paypal/cancel/:id`.
  - `Passport: RBX-...` -> `GET /api/packages/:packageId/passport` via [PassportViewerModal.tsx](file:///d:/Projects/Reboxify/frontend/src/components/PassportViewerModal.tsx).
  - `Request Return` -> `POST /api/returns` (`DROP_OFF`, `PICKUP`, or `NEXT_DELIVERY_SWAP`).
  - `Upload Evidence Photo (GridFS)` -> `POST /api/returns/:id/evidence`.
  - `Refund & Deduction Details` -> opens [ReturnDetailModal.tsx](file:///d:/Projects/Reboxify/frontend/src/components/ReturnDetailModal.tsx) (`GET /api/returns/:id/refund` + lazy `GET /api/returns/:id/evidence/:fileId` blob fetch).
  - `Sign Out` -> `POST /api/auth/logout`.
- **Placeholders / Incomplete Items:**
  - `Gemini Assistant (Phase 8)` card (`UserPortal.tsx:330-338`) is static informational copy with no chat or assistant action.
- **Loading, Empty, Success & Error States:**
  - **Missing initial page loading state:** `loadOrdersAndMerchants()` has no `loading` boolean (`UserPortal.tsx:59-80`), causing empty states (`No active merchants available yet`, `You have not placed any orders yet`) to flash before data arrives.
  - Passport modal (`passportLoading`, `passportError`), PayPal checkout (`busy`, `statusMessage`, `errorMessage`), return submission (`submittingReturnKey`), and page-level `error` / `notice` banners are handled cleanly.
- **UI Consistency, Responsiveness & Workflow Gaps:**
  - Clean `grid lg:grid-cols-3`, `sm:grid-cols-2`, and `md:grid-cols-2` responsive grids; **return pickup window start/end (`+24h` to `+26h`) is hardcoded on `PICKUP` requests (`UserPortal.tsx:159-160`)** without a customer slot picker (pending Phase 7 pickup scheduling).

### 2.2 CompanyAdminPortal (`/#/company-admin` — `MERCHANT_ADMIN`, `MERCHANT_STAFF`)
- **File:** [CompanyAdminPortal.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/CompanyAdminPortal.tsx)
- **Available Sections:**
  1. Sticky header (`business.name`, email/role/packagingModel badge, `Sign Out`) + `SystemStatusBanner`.
  2. **Packaging Policy & Ownership Mode** (`HYBRID`, `SHARED_POOL`, `MERCHANT_OWNED`).
  3. **Add / Update Product SKU** form (`sku`, `name`, `length`, `width`, `height`, `weightKg`, `unitPrice`, `fragility`, `rotatable`, `liquidContainment`).
  4. **Register Merchant-Owned PP Box** (`MERCHANT_ADMIN` only: class `S/M/L/XL`, `fulfilmentLocation`) + **Create Customer Order** (`customerId`, `productId`, `quantity`, `fulfilmentLocation`).
  5. **Orders & Deterministic Package Allocation** cards (`Allocate Package`, `Confirm Split Allocation` on `SPLIT_RECOMMENDED`, inline `Scan`, `Passport`, and partner `select` dropdown).
  6. **PayPal Sandbox Transactions & Deposit Allocations** plain HTML `<table>`.
  7. [PackageScannerPanel.tsx](file:///d:/Projects/Reboxify/frontend/src/components/PackageScannerPanel.tsx) (`PACK`, `DISPATCH`, `QUARANTINE`).
  8. **Eligible Inventory & Digital Passports** plain HTML `<table>` (`Passport`, `Scan`, `Reprint QR`, `Revoke`).
  9. [ReturnsManagementSection.tsx](file:///d:/Projects/Reboxify/frontend/src/components/ReturnsManagementSection.tsx) (`Details`, `Assign Partner`, `Approve & Refund`, `Reject`, `Reconcile Refund`).
- **Role-Based Visibility:**
  - Ownership policy buttons, `Register Merchant-Owned PP Box`, `Reprint QR`/`Revoke`, and return refund `canApprove` are hidden from `MERCHANT_STAFF` (`CompanyAdminPortal.tsx:367,493,752,785`).
- **Connected APIs vs Incomplete/Missing Workflows:**
  - All visible product/package/order/allocation/scan/return actions call real Phase 2–5 endpoints.
  - **Incomplete UX in `Create Customer Order` (`CompanyAdminPortal.tsx:96-104,528-577`):** Requires manually pasting a raw `Customer User ID` string (no customer lookup) and hardcodes `recipientName: 'Demo Recipient'`, `zone: 'Zone-A'`, and `addressLine: '100 Circular Way'`.
  - **Missing UI workflows:** No UI form for merchant admins to invite/create `MERCHANT_STAFF` (even though backend `authService.ts:150-169` supports it), and no editable return-window/deposit-multiplier inputs on policy controls (`updateBusinessPolicies` only toggles `packagingModel` here). Tables are plain HTML `<table>` (`AG Grid` deferred to Phase 7).

### 2.3 DeliveryPartnerApp (`/#/delivery-partner` — `DELIVERY_PARTNER`)
- **File:** [DeliveryPartnerApp.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/DeliveryPartnerApp.tsx)
- **Available Sections:**
  1. Sticky orange-accented header (`Delivery Partner App`, name/email, `Sign Out`) + `SystemStatusBanner`.
  2. `PackageScannerPanel` (`DISPATCH`, `DELIVER`, `COLLECT_RETURN`) with camera scanner (`html5-qrcode`) and `MANUAL_SUPERVISED` fallback.
  3. **Assigned Return Collections & Swaps** cards (token input + `Confirm Return Collection`, `View Return Details`, `ReturnEvidenceUploader`, `Refresh`).
  4. **My Assigned Reusable Packages** cards (`Select to Scan`, `View Passport`).
  5. **Assigned Pickup Slots & Schedule Sync** card (`Pending Phase 7 API` badge).
- **Connected APIs vs Placeholders:**
  - `PackageScannerPanel` -> `POST /api/packages/:id/scan`.
  - `Confirm Return Collection` -> `POST /api/returns/:id/collect` (always sends `scanMode: 'QR_TOKEN'`).
  - `Upload Evidence Photo` -> `POST /api/returns/:id/evidence`.
  - `View Return Details` -> `ReturnDetailModal` (`GET /api/returns/:id/refund` & evidence download).
  - `View Passport` -> `GET /api/packages/:id/passport`.
  - **Placeholder:** Pickup slots / exception reporting card (`DeliveryPartnerApp.tsx:298-308`) explicitly notes `Pending Phase 7 API`.
- **Important Interaction Hazard / Missing Flow:**
  - **Dual Return Collection Path Divergence:** `PackageScannerPanel` includes `COLLECT_RETURN` (`POST /api/packages/:id/scan`), which updates `Package.status` -> `COLLECTED` **without** advancing the linked `Return` record (`ReturnModel` remains `PICKUP_SCHEDULED` / `DROP_OFF_SELECTED`). Moreover, if a partner scans `COLLECT_RETURN` via `PackageScannerPanel` first, clicking `Confirm Return Collection` afterwards will fail package transition validation (`COLLECTED` -> `COLLECTED`). Also, unlike `PackageScannerPanel`, the return card's `Confirm Return Collection` input lacks camera decode integration and has no `MANUAL_SUPERVISED` mode in UI.

### 2.4 CollectionCentrePortal (`/#/collection-centre` — `COLLECTION_CENTRE`)
- **File:** [CollectionCentrePortal.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/CollectionCentrePortal.tsx)
- **Available Sections:**
  1. Sticky teal-accented header + `SystemStatusBanner`.
  2. **Returns Intake, Inspection & PayPal Partial Refund Queue** cards + inline collapsible **Inspection Checklist** form (`condition` 8-value selector, defect reason, 4 checklist checkboxes, notes, `Flag Dispute for Human Review`).
  3. `PackageScannerPanel` (`RECEIVE_CENTRE`, `INSPECT_PASS`, `MARK_CLEANING`, `RELEASE_AVAILABLE`, `QUARANTINE`).
  4. **Network Packages & QR Credential Controls** plain HTML `<table>` (`Scan`, `Passport`, `Reprint QR`, `Revoke`).
  5. **AG Grid Operational Ledger & CSV Export** card (`Pending Phase 7 API` badge).
- **Connected APIs vs Placeholders:**
  - `Receive at Centre` -> `POST /api/returns/:id/receive` (supports QR token or `manualReason` >= 8 chars).
  - `Assign Collection Partner...` -> `POST /api/returns/:id/assign-partner`.
  - `Save Deterministic Inspection` -> `POST /api/returns/:id/inspect`.
  - `Approve & Issue PayPal Refund` / `Reject Refund` / `Reconcile / Retry PayPal Refund` -> `POST /api/returns/:id/approve`, `/reject`, `/reconcile-refund`.
  - Evidence upload/download, QR scanner transitions, passport viewer, and QR label reprint/revoke all connect to live Phase 4–5 APIs.
  - **Placeholder:** `AG Grid Operational Ledger & CSV Export` (`CollectionCentrePortal.tsx:676-684`).
- **Observed Bug & Interaction Gaps:**
  - **Inspection Edit Reset Bug (`CollectionCentrePortal.tsx:426-438`):** Clicking `Update Inspection` on a return that already has `ret.inspection` resets `inspectCondition` back to `'GOOD'`, all 4 checklist booleans to `true`, and ignores previously saved `damageReason`/`notes`/`disputed` values.
  - Same `RECEIVE_CENTRE` scanner vs `/api/returns/:id/receive` split risk as noted in DeliveryPartnerApp if an operator uses `PackageScannerPanel` instead of the return card button.

### 2.5 AdminDashboard (`/#/super-admin` — `ADMIN`)
- **File:** [AdminDashboard.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/AdminDashboard.tsx)
- **Available Sections:**
  1. Sticky slate header + `SystemStatusBanner`.
  2. **Onboard Merchant Business** form (`name`, `legalName`, `slug`, optional `ownerUserId`, `packagingModel`, `currency`).
  3. **Register Reusable PP Package** form (`REBOXIFY_POOL`/`MERCHANT`/`HYBRID`, class `S/M/L/XL`, owner merchant select, `fulfilmentLocation`, optional `RBX-...` ID) + printable `QrLabelModal` launcher.
  4. **Merchant Businesses** table (`Approve`, `Suspend`).
  5. `PackageScannerPanel` (all 9 scan actions + partner assignment on `PACK`/`DISPATCH`).
  6. **Network Packaging Inventory** table (`Passport`, `Scan`, `Reprint QR`, `Revoke`).
  7. Shared `ReturnsManagementSection` (all Phase 5 return/refund actions).
  8. **Network PayPal Sandbox Transactions & Deposit Ledger** table.
- **Missing Admin Workflows / Incomplete Views:**
  - **No User / Role Provisioning UI:** Admins cannot create `MERCHANT_ADMIN`, `DELIVERY_PARTNER`, or `COLLECTION_CENTRE` user accounts via UI (`POST /api/auth/register` exists on backend, no Admin UI form).
  - **No Audit Log Viewer / Manual Bulk Reconciliation Trigger / Search / AG Grid:** Blueprint Section 12 & 16–19 Admin tables (`auditLogs` viewer, bulk `reconcileStuckPendingRefunds`, ES anomaly views) are not yet built (scheduled Phases 6–8).
  - Loading indicator (`loading`) is checked only on the `Merchant Businesses` table (`AdminDashboard.tsx:419`), not on Inventory, Returns, or Transactions sections.

---

## 3. Feature Implementation Matrix (Verified Against Actual Code)

| Module / Capability | Actual Implementation State | Evidence in Codebase |
| :--- | :--- | :--- |
| Auth (JWT Bearer, bcrypt, role signup bounds) | **Implemented** (tested in-memory; MongoDB unverified) | [authService.ts](file:///d:/Projects/Reboxify/backend/src/services/authService.ts), [authRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/authRoutes.ts) |
| Merchant Onboarding & Policies | **Implemented** (tested in-memory) | [businessService.ts](file:///d:/Projects/Reboxify/backend/src/services/businessService.ts), [businessRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/businessRoutes.ts) |
| Product SKU Catalogue | **Implemented** (tested in-memory) | [productService.ts](file:///d:/Projects/Reboxify/backend/src/services/productService.ts), [productRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/productRoutes.ts) |
| Packaging Inventory & 8-Step Allocation Engine | **Implemented** (verified unit + mocked HTTP tests) | [allocationEngine.ts](file:///d:/Projects/Reboxify/backend/src/services/allocationEngine.ts), [packagingService.ts](file:///d:/Projects/Reboxify/backend/src/services/packagingService.ts) |
| Order Creation & Server Totals | **Implemented** (`CANCELLED` state exists in machine but no cancel route) | [orderService.ts](file:///d:/Projects/Reboxify/backend/src/services/orderService.ts), [orderRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/orderRoutes.ts) |
| PayPal Checkout & Server Capture | **Implemented** (tested with mocked `PayPalClient` only) | [paymentService.ts](file:///d:/Projects/Reboxify/backend/src/services/paymentService.ts), [paypalClient.ts](file:///d:/Projects/Reboxify/backend/src/services/paypalClient.ts), [PayPalOrderCheckout.tsx](file:///d:/Projects/Reboxify/frontend/src/components/PayPalOrderCheckout.tsx) |
| Digital Passport & Signed QR (`RBXQR:v1` + Rotation/Revoke/Reprint) | **Implemented** (tested with in-memory repos + mock timestamps) | [qrService.ts](file:///d:/Projects/Reboxify/backend/src/services/qrService.ts), [passportService.ts](file:///d:/Projects/Reboxify/backend/src/services/passportService.ts), [PackageScannerPanel.tsx](file:///d:/Projects/Reboxify/frontend/src/components/PackageScannerPanel.tsx) |
| Append-Only `packageEvents` & Partial Unique `scanId` Index | **Implemented** (schema hooks + index regression test; no live Atlas run) | [PackageEvent.ts](file:///d:/Projects/Reboxify/backend/src/models/PackageEvent.ts), [packageEventScanIdIndex.test.ts](file:///d:/Projects/Reboxify/backend/tests/packageEventScanIdIndex.test.ts) |
| Return Initiation, Collection, Intake, Private GridFS Evidence | **Implemented** (tested in-memory storage; live GridFS stream unverified) | [returnService.ts](file:///d:/Projects/Reboxify/backend/src/services/returnService.ts), [evidenceStorage.ts](file:///d:/Projects/Reboxify/backend/src/services/evidenceStorage.ts), [returnRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/returnRoutes.ts) |
| Structured Inspection & Deterministic Partial Refunds | **Implemented** (unit matrix + mocked HTTP tests; zero-refund `UNDER_INSPECTION -> CLOSED` transition bug noted below) | [refundCalculation.ts](file:///d:/Projects/Reboxify/backend/src/services/refundCalculation.ts), [phase5ReturnsRefundsWebhooks.test.ts](file:///d:/Projects/Reboxify/backend/tests/phase5ReturnsRefundsWebhooks.test.ts) |
| PayPal Capture Refunds & Cryptographic Webhook Verification | **Implemented** (mocked PayPal HTTP only; no live Sandbox calls yet) | [webhookService.ts](file:///d:/Projects/Reboxify/backend/src/services/webhookService.ts), [webhookRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/webhookRoutes.ts) |
| Background Worker (`SearchOutbox` & Periodic Reconcile Loop) | **Not implemented** (skeleton heartbeat only; `reconcileStuckPendingRefunds` uncalled) | [worker.ts](file:///d:/Projects/Reboxify/backend/src/worker.ts), [render.yaml](file:///d:/Projects/Reboxify/render.yaml) |
| Pickup Scheduling API + Bryntum Scheduler UI | **Partially implemented** (DB `PickupModel` + `pickupStateMachine` exist; no `/api/pickups` routes or partner capacity checks) | [Pickup.ts](file:///d:/Projects/Reboxify/backend/src/models/Pickup.ts), [DeliveryPartner.ts](file:///d:/Projects/Reboxify/backend/src/models/DeliveryPartner.ts) |
| AG Grid Tables & CSV Export | **Not implemented** | Plain HTML tables in portals |
| Elasticsearch Indexing & `/api/search/*` | **Not implemented** (`SearchOutboxModel` written by repos; zero consumers) | [SearchOutbox.ts](file:///d:/Projects/Reboxify/backend/src/models/SearchOutbox.ts), [docker-compose.yml](file:///d:/Projects/Reboxify/docker-compose.yml) |
| Gemini AI Service (`@google/genai`) & Sustainability API | **Not implemented** (`AiInteractionModel` & `UserPortal` card only; hardcoded `'TEMPLATE'` explanations) | [AiInteraction.ts](file:///d:/Projects/Reboxify/backend/src/models/AiInteraction.ts), [UserPortal.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/UserPortal.tsx#L330-L338) |
| Demo Data Seeder (`seedDemo.ts`) & Audit Log Read API | **Not implemented** (`AuditLogModel` written only; no `GET /api/audit-logs`) | [AuditLog.ts](file:///d:/Projects/Reboxify/backend/src/models/AuditLog.ts) |

---

## 4. End-to-End Lifecycle Verification Matrix

Classification legend (strictly applied):
- **Implemented and locally verified** — Pure deterministic code/process behavior executed directly without external mocks or live DB dependency.
- **Implemented but only tested with mocks** — Executed via Vitest/Supertest using in-memory repositories and/or mocked PayPal REST responses.
- **Implemented but not yet runtime-verified** — Implemented in code (e.g., Mongoose repositories, GridFS streams, React portal buttons/modals/camera), compiles cleanly, but has **not** been executed against live MongoDB Atlas, PayPal Sandbox, or a live Chrome browser session.
- **Partially implemented** — Core piece exists in one layer while another layer or synchronization path is incomplete.
- **Not implemented** — Deferred to Phases 6–9.

| # | End-to-End Lifecycle Step | Classification | Notes & Evidence |
| :--- | :--- | :--- | :--- |
| 1 | Customer registration / login (`POST /api/auth/register`, `/login`) | **Implemented but only tested with mocks** (+ **Not yet runtime-verified** live DB/UI) | `authAndRbac.test.ts` passes with in-memory user store. Live HTTP `POST /api/auth/register` against local Node process returned `503` because `MONGODB_URI` is unconfigured (`task-1040`). |
| 2 | Merchant creates products (`POST /api/products`) | **Implemented but only tested with mocks** | Verified in `phase2Api.test.ts`; `MongooseProductRepository` & `CompanyAdminPortal` SKU form not runtime-verified against MongoDB/browser. |
| 3 | Packaging inventory becomes available (`POST /api/inventory`, `RBXQR:v1`) | **Implemented but only tested with mocks** | Token signing & inventory registration tested in `phase2Api.test.ts` & `phase4PassportsAndQr.test.ts`; live `QrLabelModal` print UI & Mongoose persistence unverified. |
| 4 | Customer places order & package allocation (`POST /api/orders`, `allocationEngine`) | **Implemented and locally verified** (engine) / **Only tested with mocks** (HTTP persistence) | `allocationEngine.test.ts` (`7/7`) tests pure allocation rules directly; `phase2Api.test.ts` tests HTTP + idempotent reservation in-memory. |
| 5 | PayPal checkout & deposit capture (`create-order`, `capture/:id`) | **Implemented but only tested with mocks** | `phase3Payments.test.ts` verifies amount/currency checks & capture using mocked `PayPalClient`; live `@paypal/react-paypal-js` & `RestPayPalClient` against PayPal Sandbox unverified. |
| 6 | QR passport generation & lookup (`GET /api/packages/:id/passport`) | **Implemented but only tested with mocks** | Zero-PII token claims, HMAC rotation, revocation & passport response verified in `phase4PassportsAndQr.test.ts`; `PassportViewerModal` & `MongoosePassportRepository` not runtime-verified. |
| 7 | Merchant packs order (`POST /api/packages/:id/scan` `PACK`) | **Implemented but only tested with mocks** | Payment-independent packing & optional partner assignment verified in `phase4PassportsAndQr.test.ts`; camera/UI flow unverified. |
| 8 | Delivery partner collects & delivers (`DISPATCH` Gate 1 -> `DELIVER`) | **Implemented but only tested with mocks** | Gate 1 `CAPTURED` block & `DISPATCH`/`DELIVER` transitions verified in `phase4PassportsAndQr.test.ts`. |
| 9 | Customer initiates return (`POST /api/returns`) | **Implemented but only tested with mocks** | Duplicate blocking, deadline/late tracking & modes verified in `phase5ReturnsRefundsWebhooks.test.ts`; note `PICKUP` slot validation/scheduler UI is **Partially implemented** (window hardcoded in `UserPortal`, `PickupModel` never updated after creation). |
| 10 | Partner collects reusable package (`POST /api/returns/:id/collect`) | **Partially implemented** / **Only tested with mocks** | `POST /api/returns/:id/collect` works cleanly in `phase5ReturnsRefundsWebhooks.test.ts`; however, partner portal lacks camera/manual fallback UI on the return card, and scanning `COLLECT_RETURN` via `PackageScannerPanel` updates `Package` without updating `Return`. |
| 11 | Collection centre receives & inspects (`receive`, `evidence`, `inspect`) | **Implemented but only tested with mocks** | GridFS `validateEvidenceImage` tested unit-style via `InMemoryEvidenceStorage`, inspection matrix & RBAC verified in `phase5ReturnsRefundsWebhooks.test.ts`; live `GridFsEvidenceStorage` streaming & `CollectionCentrePortal` inspection edit prefill bug noted. |
| 12 | Refund calculated & processed (`POST /api/returns/:id/approve`, PayPal refund, webhooks) | **Implemented but only tested with mocks** | `calculateReturnRefund` unit matrix **locally verified**; PayPal capture refunds, pending reservation, retry, and `/api/webhooks/paypal` tested strictly against mocked `PayPalClient`. |
| 13 | Package cleaned & released (`MARK_CLEANING`, `RELEASE_AVAILABLE`, `reuseCount + 1`) | **Implemented but only tested with mocks** | Verified in `phase4PassportsAndQr.test.ts` and Gate 3 independence in `phase5ReturnsRefundsWebhooks.test.ts`; live UI/Atlas runtime unverified. |
| 14 | Scheduled reconciliation & search indexing background worker (`worker.ts`) | **Not implemented** | `worker.ts` currently runs an empty `setInterval`; `SearchOutbox` & `reconcileStuckPendingRefunds` are not scheduled yet (Phase 6/7). |

---

## 5. UI/UX Observations

- **Visual System & Consistency:** Light and dark mode styling (Tailwind v3 compiled CSS, glassmorphic cards, role-coded accent colors: emerald customer, indigo merchant, orange delivery partner, teal collection centre, slate admin) is cohesive across pages and modals.
- **ThemeToggle Placement:** [ThemeToggle.tsx](file:///d:/Projects/Reboxify/frontend/src/components/ThemeToggle.tsx#L9-L15) hides itself on every route except `/` (`location.pathname !== '/'`). Users inside login screens or operational portals cannot switch themes without returning to LandingPage.
- **Header & Navigation Clarity:**
  - Portal headers are clean and allow returning to `/` by clicking the ReBoxify brand block or signing out (`Sign Out`).
  - `App.tsx` lacks a wildcard `<Route path="*" element={<Navigate to="/" replace />} />` fallback — unknown hash URLs render a blank screen.
  - `LoginPage.tsx` has no quick "Switch Portal / Back to Home" text button (only clicking the top logo navigates home).
- **Information Hierarchy & Density:** `CompanyAdminPortal` (all 9 sections on one long vertical scroll) and `AdminDashboard` will benefit from tabbed/sectioned navigation once AG Grid tables and Gemini panels arrive.
- **Empty States, Loading States & Accessibility:**
  - Empty states exist on every list (`No businesses registered`, `No orders`, `No returns`, `No transactions`).
  - **Gap:** `UserPortal` lacks an initial loading spinner/skeleton; `CollectionCentrePortal` inline `inspectFormTarget` renders *below* the returns queue list (easy to miss on long lists without auto-scrolling or a modal). Several `<select>`/`<input>` elements rely on `placeholder` text instead of `<label>` elements (`UserPortal`, `CompanyAdminPortal`), reducing screen-reader accessibility.
- **Reusable Lifecycle Clarity:** `PassportViewerModal` and `ReturnDetailModal` clearly surface Ownership vs. Custody separation, itemised deposits, deduction breakdowns, and append-only lifecycle history. Conversely, having two distinct QR scan surfaces on `DeliveryPartnerApp` and `CollectionCentrePortal` (`PackageScannerPanel` vs per-return action buttons) creates operator confusion.

---

## 6. API Integration Status

- **Backend Endpoints Mounted (`app.ts` + `backend/src/routes/*`):**
  - `GET /api/health`
  - `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
  - `POST /api/businesses`, `GET /api/businesses`, `GET /api/businesses/:id`, `PATCH /api/businesses/:id/status`, `PATCH /api/businesses/:id/policies`
  - `POST /api/products`, `GET /api/products`
  - `GET /api/inventory/catalogue`, `POST /api/inventory`, `GET /api/inventory`
  - `POST /api/orders`, `GET /api/orders`, `GET /api/orders/:id`, `POST /api/orders/:id/allocate-package`
  - `GET /api/payments/config`, `POST /api/payments/paypal/create-order`, `POST /api/payments/paypal/capture/:id`, `POST /api/payments/paypal/cancel/:id`, `GET /api/payments/:id`, `GET /api/transactions`
  - `GET /api/packages/partners`, `GET /api/packages/assigned/me`, `GET /api/packages/:packageId/passport`, `POST /api/packages/:packageId/scan`, `POST /api/packages/:packageId/assign-partner`, `POST /api/packages/:packageId/qr/reprint`, `POST /api/packages/:packageId/qr/revoke`
  - `POST /api/returns`, `GET /api/returns`, `GET /api/returns/:id`, `GET /api/returns/:id/refund`, `POST /api/returns/:id/assign-partner`, `POST /api/returns/:id/collect`, `POST /api/returns/:id/receive`, `POST /api/returns/:id/evidence`, `GET /api/returns/:id/evidence/:fileId`, `POST /api/returns/:id/inspect`, `POST /api/returns/:id/approve`, `POST /api/returns/:id/reject`, `POST /api/returns/:id/reconcile-refund`
  - `POST /api/webhooks/paypal`
- **Frontend API Alignment:** Every API call in [client.ts](file:///d:/Projects/Reboxify/frontend/src/api/client.ts), [phase2.ts](file:///d:/Projects/Reboxify/frontend/src/api/phase2.ts), [phase3.ts](file:///d:/Projects/Reboxify/frontend/src/api/phase3.ts), [phase4.ts](file:///d:/Projects/Reboxify/frontend/src/api/phase4.ts), and [phase5.ts](file:///d:/Projects/Reboxify/frontend/src/api/phase5.ts) matches the mounted backend routes accurately (`API_BASE_URL` defaults cleanly to `http://localhost:5000`).
- **Missing APIs:** `/api/pickups/*`, `/api/search/*`, `/api/ai/*`, `/api/sustainability/summary`, `/api/audit-logs`, `POST /api/orders/:id/cancel` (or order cancellation path), and admin bulk `reconcile-payments`.

---

## 7. Security & Technical Health Observations

### Security Strengths Verified
- **Backend-Only Secrets:** No secrets exist in `frontend/` or Vite `define`; `backend/src/config/env.ts` fails fast in `NODE_ENV=production` if `MONGODB_URI` or `< 16`-char `JWT_SECRET`/`SESSION_SECRET`/`QR_SIGNING_SECRET` are missing. `.gitignore` excludes `.env` and `.env.*` while preserving `!.env.example`.
- **Payment & Refund Integrity:** Server computes order totals, deposit allocations, and deterministic partial refunds; client-supplied `refundAmount`/`amount`/`calculatedAmount` are explicitly rejected (`400 CLIENT_REFUND_AMOUNT_FORBIDDEN`); PayPal captures/refunds/webhooks verify amount and currency against persisted transactions and `PayPal-Request-Id` idempotency.
- **QR Security & Replay Protection:** `RBXQR:v1` tokens contain zero PII, use `crypto.timingSafeEqual` on both HMAC-SHA256 signatures and SHA-256 stored hashes, support versioned rotation/reprint/revocation, and enforce `(packageId, scanId)` replay rejection via partial unique index.
- **RBAC, Role Separation & Private Evidence:** Cross-merchant isolation (`resolveMerchantScope`), customer ownership checks, anti-self-inspection (`SELF_INSPECTION_FORBIDDEN`), anti-self-approval (`SELF_APPROVAL_FORBIDDEN`), magic-byte image validation, and authenticated `GET /api/returns/:id/evidence/:fileId` delivery are consistently enforced.

### Technical Risks, Bugs & Doc-vs-Code Inconsistencies Found
1. **CRITICAL Pre-Phase 6 Deployment Bug in `render.yaml` (`reboxify-worker`):** [render.yaml](file:///d:/Projects/Reboxify/render.yaml#L43-L65) omits `JWT_SECRET`, `SESSION_SECRET`, and `QR_SIGNING_SECRET` from `reboxify-worker`. Because [worker.ts](file:///d:/Projects/Reboxify/backend/src/worker.ts#L2) imports [env.ts](file:///d:/Projects/Reboxify/backend/src/config/env.ts#L76-L80), which executes `loadConfig()` on import and throws when any of those 3 secrets is missing in `NODE_ENV=production`, `reboxify-worker` will crash immediately on Render startup unless those variables are added (or secret validation is scoped cleanly).
2. **State Machine Bypass Bug in Zero-Refund Branch ([returnService.ts](file:///d:/Projects/Reboxify/backend/src/services/returnService.ts#L1589-L1678)):** When `refundAmount <= 0`, if `ret.inspection.condition` is `GOOD` or `MINOR_WEAR` and `ret.status === 'UNDER_INSPECTION'`, `returnStateMachine.validateTransition('UNDER_INSPECTION', 'CLOSED')` returns `allowed: false`, yet execution falls through and writes `status: 'CLOSED'` without throwing. Additionally, in the `NEEDS_REVIEW` branch (`:1595-1609`), it writes `status: 'REJECTED'` & `decision.outcome: 'REJECTED'` even if condition was `GOOD`/`MINOR_WEAR`.
3. **`runInTransaction` Silent Standalone Fallback ([db.ts](file:///d:/Projects/Reboxify/backend/src/config/db.ts#L62-L75)):** `runInTransaction` supports `{ requireReplicaSet: true }`, but no Phase 2–5 repository/service passes it — so if `MONGODB_URI` ever points to a standalone MongoDB node in production, multi-document operations silently execute non-atomically without transactions.
4. **Package/Return Divergence via `PackageScannerPanel`:** Scanning `COLLECT_RETURN` or `RECEIVE_CENTRE` on `/api/packages/:packageId/scan` transitions `Package` status without transitioning the linked `Return` record.
5. **Untested Persistence & External Adapter Layers:** All 18 Mongoose models + `Mongoose*Repository` classes + `GridFsEvidenceStorage` + `MongooseIdempotencyStore` + `RestPayPalClient` + `worker.ts` have zero live integration tests executed yet (unit/HTTP tests use in-memory repositories and mocked PayPal clients).
6. **Stale / Self-Contradictory Documentation & Legacy Files:**
   - [README.md](file:///d:/Projects/Reboxify/README.md) still describes the old 4-portal `localStorage` prototype, Green Tokens, `npm run dev` (root `package.json` has `dev:backend`/`dev:frontend`, no `dev`), and an external local screenshot path.
   - [FEATURE_STATUS.md](file:///d:/Projects/Reboxify/FEATURE_STATUS.md#L84,L100,L102) still marks `vite.config.ts` Gemini key exposure (`:84` — already fixed), `searchOutbox` (`:100` — collection & transactional writers already exist), and `auditLogs` (`:102` — all Phase 2–5 services write to it) inaccurately.
   - [ENVIRONMENT_VARIABLES.md](file:///d:/Projects/Reboxify/ENVIRONMENT_VARIABLES.md#L8-L10,L24,L38,L50) still references `/api/config/public` (actual route is `GET /api/payments/config`), conditional `SESSION_SECRET` (actually unconditional in prod), unused `ELASTICSEARCH_USERNAME`/`PASSWORD`, and Phase 2 TODO notes already completed.
   - [SYSTEM_ARCHITECTURE.md](file:///d:/Projects/Reboxify/SYSTEM_ARCHITECTURE.md#L115,L145-L159) lists future Phase 6–9 file names in the directory tree and slightly different Mongoose field names (`class`/`attempts`/`balance`/`before`) plus backend `qrcode` generation (which is frontend-only via `qrcode.react`).
   - [TECHNICAL_DECISIONS.md](file:///d:/Projects/Reboxify/TECHNICAL_DECISIONS.md#L13-L14,L58) states Return has 9 states (actually 10), conflates `Business.packagingModel` (`SHARED_POOL`) with `Package.ownerType` (`REBOXIFY_POOL`), and references Leaflet/Chennai pins already removed from `DeliveryPartnerApp.tsx` (though `leaflet`, `react-leaflet`, `@types/leaflet` remain orphaned in [frontend/package.json](file:///d:/Projects/Reboxify/frontend/package.json#L15-L21)).
   - Health endpoint (`healthRoutes.ts:27`) & `SystemStatusBanner` (`:54`) show green `Scheduler: ADAPTER_READY` even though `pickupService` & `/api/pickups` are not yet built.
   - `docker-compose.yml` runs Elasticsearch with `xpack.security.enabled=false` (plain HTTP), differing from TLS + `ELASTICSEARCH_API_KEY` assumptions in `ENVIRONMENT_VARIABLES.md`.
   - `Pickup.ts:48` references `'DeliveryPartner'`, while `Return.ts:108` and `Package.ts:102` reference `'User'`.

---

## 8. Missing and Incomplete Functionality Summary

- **Phase 6 Scope:** Worker reconciliation loop calling `ReturnService.reconcileStuckPendingRefunds()` and PayPal capture pending checks; Render deployment & live webhook URL registration.
- **Phase 7 Scope:** `GET/POST/PATCH /api/pickups`, partner capacity/zone/double-booking validation, updating `PickupModel` when `assignReturnPartner` or `collectReturn` runs, Bryntum Scheduler adapter UI; AG Grid Community tables + CSV export across 6 operational tables; Elasticsearch bulk outbox indexer + `/api/search/*` routes + rebuild CLI.
- **Phase 8 Scope:** `@google/genai` backend service, 9-tool role-scoped Tool Gateway (`aiInteractions` logging), assistant & summary endpoints/UI panels; `GET /api/sustainability/summary`.
- **Phase 9 / Pre-Demo Polish:** Idempotent demo seed script (`seedDemo.ts`), `GET /api/audit-logs`, user management UI for onboarding `MERCHANT_STAFF`/`DELIVERY_PARTNER`/`COLLECTION_CENTRE`, updated `README.md`.

---

## 9. Runtime and Browser Testing Results

| Check | Command / Action | Outcome Observed |
| :--- | :--- | :--- |
| Backend TypeScript check & compile | `npm --prefix backend run typecheck` + `npm --prefix backend run build` | **Passed (`exit 0`)** |
| Frontend TypeScript check & Vite bundle | `npm --prefix frontend run typecheck` + `npm --prefix frontend run build` | **Passed (`exit 0`, 95 modules, `dist/assets/index-DyhgijfA.css` 39.85 kB, `dist/assets/index-CL-ItR7z.js` 782.84 kB)** |
| Backend Automated Test Suite | `npm --prefix backend test` (`vitest run`) | **Passed (`8` files, `35/35` tests)** using in-memory repositories & mocked `PayPalClient` |
| Local Backend + Frontend Live HTTP Probe | Started `node backend/dist/server.js` (port 5000) & `npm --prefix frontend run dev` (port 3000), probed endpoints, then stopped both daemons | `GET /api/health` -> **`200`** (`connected: false`, `"MONGODB_URI is not configured."`, `currency: "USD"`); `GET /api/payments/config` -> **`200`** (`paypalConfigured: false`, `currency: "USD"`); `GET http://localhost:3000/` -> **`200`**; `POST /api/auth/register` (no MongoDB) -> **`503`** |
| Live Browser Visual Inspection & Screenshots | Invoked `browser` subagent against `http://localhost:3000` | **Blocked / Not Executed:** `chrome_devtools` reported Chrome remote debugging is not active (`Could not find DevToolsActivePort for chrome at C:\Users\Hp\AppData\Local\Google\Chrome\User Data\DevToolsActivePort`). **Zero browser screenshots captured.** |
| Live MongoDB Atlas (`rs0`), GridFS & PayPal Sandbox | Checked host for `docker`, `mongod`, `.env` | **Not Executed:** No local Docker/`mongod` binary and no `.env` files configured on this host. |

---

## 10. Recommended Improvements Before Deployment (Tracked for Resolution — Not Modified Now)

1. **Must-Fix Before Phase 6 Worker Deploy:** Add `JWT_SECRET`, `SESSION_SECRET`, and `QR_SIGNING_SECRET` (`generateValue: true` or shared) to `reboxify-worker` in [render.yaml](file:///d:/Projects/Reboxify/render.yaml#L49-L65) (or isolate worker config from API auth/QR secrets so `worker.ts` does not crash when `NODE_ENV=production`).
2. **Fix Return Inspection Edit Reset & Zero-Refund Transition:**
   - Pre-populate `inspectFormTarget` fields from `ret.inspection` and `ret.disputed` in `CollectionCentrePortal.tsx` when editing an existing inspection.
   - Enforce `returnStateMachine` strictly on the zero-refund branch in `returnService.ts:1589-1678` (transitioning `UNDER_INSPECTION` / `NEEDS_REVIEW` -> `APPROVED` -> `CLOSED` or `REJECTED` explicitly).
3. **Unify `COLLECT_RETURN` / `RECEIVE_CENTRE` Paths:** Restrict `PackageScannerPanel` return actions or have them sync the linked `Return` document so `Package.status` and `Return.status` cannot diverge.
4. **Require Replica-Set Transactions in Production:** Pass `{ requireReplicaSet: config.nodeEnv === 'production' }` (or enforce replica set) on financial/inventory/return atomic methods calling `runInTransaction`.
5. **UX & Accessibility Polish:** Add initial `loading` spinner in `UserPortal`, wildcard route `<Route path="*" element={<Navigate to="/" replace />} />` in `App.tsx`, portal-wide `ThemeToggle` visibility, customer picker/full address inputs on merchant `Create Order`, proper `<label>` associations on form inputs, and remove orphaned `leaflet`/`react-leaflet`/`@types/leaflet` packages from `frontend/package.json`.
6. **Doc Sync:** Bring `README.md`, `FEATURE_STATUS.md`, `ENVIRONMENT_VARIABLES.md`, `TECHNICAL_DECISIONS.md`, and `SYSTEM_ARCHITECTURE.md` into exact alignment with the `rebuild/v2-mvp` implementation.

---

## 11. Phase 6 Readiness Assessment

- **Assessment:** **Conditionally Ready for Phase 6 (`Render Deployment & Background Worker`) — with 1 Mandatory Blocker Fix First.**
  - Phases 1–5 backend services, routes, security controls, state machines, frontend portals, builds, and all `35/35` mocked unit/HTTP suites are complete and green, making the codebase functionally sound enough to implement the Phase 6 background worker reconciliation loops (`reconcileStuckPendingRefunds()` + `CAPTURE_PENDING` polling) and Render deployment setup.
  - **Before deploying `reboxify-worker` onto Render in Phase 6**, fix the missing `JWT_SECRET`/`SESSION_SECRET`/`QR_SIGNING_SECRET` env vars in `render.yaml` (or decouple `worker.ts` config loading), and supply real `MONGODB_URI` (Atlas replica set), `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_WEBHOOK_ID` credentials so live DB persistence, GridFS uploads, Sandbox checkout/refunds, and live Render HTTPS webhook verification can be verified immediately upon deployment.

