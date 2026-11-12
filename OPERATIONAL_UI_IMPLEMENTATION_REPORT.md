# ReBoxify — Operational UI Integration Implementation Report

**Branch:** `rebuild/v2-mvp`  
**Scope:** AG Grid Community + Official Bryntum Scheduler Community + Backend Pickup Scheduling (`/api/pickups`)  
**Out-of-Scope Preserved:** Phase 6 worker & reconciliation, PayPal Sandbox payments/refunds/webhooks, QR signatures & Digital Passports, Gemini AI (untouched), Elasticsearch (untouched), git commit/push (none performed).

---

## 1. Prerequisite & Licensing Verification

Before installing any UI packages, the workspace manifests, registries, and license entitlements were inspected:

- **No private `.npmrc` or commercial license keys** exist in the workspace or user profile (`npm.bryntum.com` private registry returned `401 Unauthorized`).
- **AG Grid Community (`ag-grid-community@^36.3.0`, `ag-grid-react@^36.3.0`):** MIT-licensed public npm packages compatible with React 19 (`^19.2.4` installed). Configured via `ModuleRegistry.registerModules([AllCommunityModule])`, `themeQuartz`, and `colorSchemeDarkBlue`. No Enterprise features or keys were added.
- **Bryntum Scheduler Community (`@bryntum/scheduler-community@^8.0.1`, `@bryntum/scheduler-react-community@^8.0.1`):** Officially published on public npm (`registry.npmjs.org`) by Bryntum (`MIT` license), providing `<BryntumScheduler>` plus Community-tier `EventDrag`, `EventResize`, `EventTooltip`, `ColumnLines`, and `TimeAxisHeaderMenu` features without requiring commercial license keys or fake substitutes. Enterprise-only Bryntum features (e.g., `ResourceTimeRanges`) were excluded.

---

## 2. Backend Changes Implemented

### 2.1 AG Grid Server-Side Sorting, Filtering, Search & DTO Enrichment
Extended existing paginated list endpoints while maintaining backward compatibility for all Phase 2–6 test suites and DTO contracts:
- **Inventory & Packages (`GET /api/inventory`):** Added `condition` filter and `sortBy: 'condition'`, regex-escaped `search` matching `packageId`, `fulfilmentLocation`, and `currentCustodian.label` in [inventoryRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/inventoryRoutes.ts), [packagingService.ts](file:///d:/Projects/Reboxify/backend/src/services/packagingService.ts), and [phase2Repositories.ts](file:///d:/Projects/Reboxify/backend/src/repositories/phase2Repositories.ts).
- **Orders (`GET /api/orders`):** Added regex-escaped `search` matching `orderNumber`, `shippingReference.recipientName`, and `allocatedPackages.packageId`, plus `sortBy` support for `grandTotal` (`totals.grandTotal`) and `depositTotal` (`totals.depositTotal`) in [orderRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/orderRoutes.ts), [orderService.ts](file:///d:/Projects/Reboxify/backend/src/services/orderService.ts), and [phase2Repositories.ts](file:///d:/Projects/Reboxify/backend/src/repositories/phase2Repositories.ts).
- **Transactions (`GET /api/transactions`):** Added `search` across `paypalOrderId`, `captureId`, `providerStatus`, `depositAllocations.packageId`, and linked `Order.orderNumber`, plus batched enrichment of `orderNumber` and `refundSummary` (`refundedTotal`, `pendingTotal`, `latestRefundState`, `refundCount`) in [paymentRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/paymentRoutes.ts), [paymentService.ts](file:///d:/Projects/Reboxify/backend/src/services/paymentService.ts), and [phase3Repositories.ts](file:///d:/Projects/Reboxify/backend/src/repositories/phase3Repositories.ts).
- **Returns (`GET /api/returns`):** Added filters for `mode`, `condition` (`inspection.condition`), `refundStatus` (via `RefundModel` lookup), and `search` (`returnNumber`, `packageId`, `reason`, `assignedPartnerName`, `Order.orderNumber`), plus batched `orderNumber` and `refundSummary` enrichment in [returnRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/returnRoutes.ts), [returnService.ts](file:///d:/Projects/Reboxify/backend/src/services/returnService.ts), and [phase5Repositories.ts](file:///d:/Projects/Reboxify/backend/src/repositories/phase5Repositories.ts).

### 2.2 Pickup Scheduling System (`/api/pickups`)
- **Models Updated:**
  - [DeliveryPartner.ts](file:///d:/Projects/Reboxify/backend/src/models/DeliveryPartner.ts): Added `timeZone`, `unavailablePeriods[]`, `maxConcurrentCapacity` (default `1`), `bookingLockVersion` (for transactional serialization), and `workingHours.daysOfWeek` default `[0..6]`.
  - [Pickup.ts](file:///d:/Projects/Reboxify/backend/src/models/Pickup.ts): Added `orderId`, `customerId`, `timeZone`, `pickupMethod`, `assignedPartnerName`, `cancelReason`, `notes`, `createdBy`, `updatedBy`, fixed `partnerId` ref to `'User'`, and added operational query indexes.
  - [machines.ts](file:///d:/Projects/Reboxify/backend/src/stateMachines/machines.ts): Updated `pickupStateMachine` to allow `UNASSIGNED -> RESCHEDULED` and `ASSIGNED -> COMPLETED`.
- **Repository & Service:**
  - [pickupRepository.ts](file:///d:/Projects/Reboxify/backend/src/repositories/pickupRepository.ts): Implemented `MongoosePickupRepository` with optimistic `version` updates, batched `returnNumber`/`orderNumber` enrichment, `DeliveryPartnerModel.bookingLockVersion` atomic serialization inside MongoDB transactions, overlap/daily-capacity queries, collection centre workload queries, and bidirectional return/event synchronization.
  - [pickupService.ts](file:///d:/Projects/Reboxify/backend/src/services/pickupService.ts): Implemented timezone-aware (`Intl.DateTimeFormat`) working hours & weekday checks, unavailable period conflict detection, service zone enforcement (`PARTNER_ZONE_MISMATCH`), concurrent overlap capacity checks (`PICKUP_OVERLAP_CONFLICT`), daily capacity checks (`PARTNER_DAILY_CAPACITY_EXCEEDED`), optimistic concurrency (`OPTIMISTIC_LOCK_CONFLICT`), customer-safe resource availability slot generation, and QR-verified pickup completion delegating to `ReturnService.collectReturn`.
- **Routes & Health Readiness:**
  - [pickupRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/pickupRoutes.ts): Mounted `/api/pickups` in [app.ts](file:///d:/Projects/Reboxify/backend/src/app.ts) with endpoints:
    - `GET /api/pickups` (role/tenant-scoped list with search/sort/filter/date range)
    - `GET /api/pickups/resources` (partner schedules, collection centres, and customer availability slots)
    - `PATCH /api/pickups/partners/:partnerId/schedule` (update working hours, zones, capacities, status)
    - `GET /api/pickups/:id`
    - `POST /api/pickups`
    - `PATCH /api/pickups/:id` (used for Bryntum drag-and-drop & resize updates with `expectedVersion`)
    - `POST /api/pickups/:id/assign`
    - `POST /api/pickups/:id/reschedule`
    - `POST /api/pickups/:id/cancel`
    - `POST /api/pickups/:id/complete` (QR/supervised verification)
  - Synchronized `PickupModel` status & partner assignments inside [phase5Repositories.ts](file:///d:/Projects/Reboxify/backend/src/repositories/phase5Repositories.ts) (`createReturnWithPackageAtomically` & `transitionReturnAndPackageAtomically`).
  - Updated [healthRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/healthRoutes.ts) to report `pickupSchedulerConfigured: true` and `bryntumSchedulerMode: 'COMMUNITY_READY'`.

---

## 3. Frontend Operational UI Implementation

### 3.1 API Clients & Domain Types
- Extended [domain.ts](file:///d:/Projects/Reboxify/frontend/src/types/domain.ts), [phase2.ts](file:///d:/Projects/Reboxify/frontend/src/api/phase2.ts), [phase3.ts](file:///d:/Projects/Reboxify/frontend/src/api/phase3.ts), and [phase5.ts](file:///d:/Projects/Reboxify/frontend/src/api/phase5.ts) with sorting, search, and filter parameters.
- Created [pickups.ts](file:///d:/Projects/Reboxify/frontend/src/api/pickups.ts) covering all `/api/pickups` operations.

### 3.2 Shared AG Grid Foundation & 5 Operational Grids
Created reusable AG Grid Community components in `frontend/src/components/grids/`:
- [agGridSetup.ts](file:///d:/Projects/Reboxify/frontend/src/components/grids/agGridSetup.ts): Centralized `AllCommunityModule` registration, Quartz light/dark theme (`colorSchemeDarkBlue`) synced via `MutationObserver` on `.dark`, and status badge helpers.
- [DataGrid.tsx](file:///d:/Projects/Reboxify/frontend/src/components/grids/DataGrid.tsx): Shared grid wrapper supporting server-side sorting, server-side pagination (`10/25/50/100`), CSV export, loading overlay, empty overlay, and inline error/retry banner.
- **5 Operational Modules:**
  1. [OrdersGrid.tsx](file:///d:/Projects/Reboxify/frontend/src/components/grids/OrdersGrid.tsx) (Orders Management with debounced search, status filter, sortable columns, stale-request sequence guard, CSV export, contextual actions)
  2. [InventoryGrid.tsx](file:///d:/Projects/Reboxify/frontend/src/components/grids/InventoryGrid.tsx) (Packaging Inventory with status/class/owner/condition filters, Passport & Scan triggers)
  3. [ReturnsGrid.tsx](file:///d:/Projects/Reboxify/frontend/src/components/grids/ReturnsGrid.tsx) + upgraded [ReturnsManagementSection.tsx](file:///d:/Projects/Reboxify/frontend/src/components/ReturnsManagementSection.tsx) (Returns filters by status/mode/condition, partner assignment selector, `Details`, `Approve & Refund`, `Reconcile`, `Reject`)
  4. [TransactionsGrid.tsx](file:///d:/Projects/Reboxify/frontend/src/components/grids/TransactionsGrid.tsx) (Payments & Refunds ledger with Order #, PayPal Order/Capture IDs, allocated/refunded/pending deposit summary)
  5. [PackagesGrid.tsx](file:///d:/Projects/Reboxify/frontend/src/components/grids/PackagesGrid.tsx) (Package Custody, QR version/revocation state, last inspection outcome, lifecycle state filters)

### 3.3 Official Bryntum Scheduler Integration & Portal Wiring
- Created [PickupSchedulerPanel.tsx](file:///d:/Projects/Reboxify/frontend/src/components/scheduler/PickupSchedulerPanel.tsx) wrapping `<BryntumScheduler>` with `@bryntum/scheduler-community/scheduler.css` and single adaptive `@bryntum/scheduler-community/svalbard.css` theme (with `color-scheme` support added to [index.css](file:///d:/Projects/Reboxify/frontend/src/index.css)):
  - Dedicated Unassigned Queue lane + Delivery Partner resource rows with service zones and capacity metrics.
  - Day (`hourAndDay`), Week (`dayAndWeek`), and 2-Week (`weekAndDay`) view presets, status/zone/search filters, and `+ Schedule Pickup` modal.
  - Drag-and-drop (`onBeforeEventDropFinalize`) and resize (`onBeforeEventResizeFinalize`) persist asynchronously to `PATCH /api/pickups/:id` with optimistic `expectedVersion`, calling `context.finalize(false)` to visually revert on server conflict/policy rejection.
  - Event click modal supporting Partner/Centre assignment, Rescheduling with reason & history timeline, Cancellation, Status updates (`IN_PROGRESS`, `MISSED`), QR-verified collection completion, and Partner Availability editing (`PATCH /api/pickups/partners/:partnerId/schedule`).
- Wired grids & scheduler into all 5 portals (preserving all existing workflows and replacing Phase 7 placeholder cards):
  - [AdminDashboard.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/AdminDashboard.tsx)
  - [CompanyAdminPortal.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/CompanyAdminPortal.tsx)
  - [CollectionCentrePortal.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/CollectionCentrePortal.tsx)
  - [DeliveryPartnerApp.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/DeliveryPartnerApp.tsx)
  - [UserPortal.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/UserPortal.tsx) (customer pickup slot loader from `/api/pickups/resources?includeSlots=true` + Orders & Transactions AG Grid explorer)
  - [SystemStatusBanner.tsx](file:///d:/Projects/Reboxify/frontend/src/components/SystemStatusBanner.tsx) (highlights `COMMUNITY_READY` scheduler badge)

---

## 4. Verification Summary

| Check | Command | Observed Result |
|---|---|---|
| Backend Typecheck | `npm --prefix backend run typecheck` | Passed (exit `0`) |
| Backend Build | `npm --prefix backend run build` | Passed (`tsc` exit `0`) |
| Backend Automated Tests | `npm --prefix backend test` | **11/11 test files passed, 46/46 tests passed** (includes 3 new integration/concurrency/RBAC tests in [pickupScheduling.test.ts](file:///d:/Projects/Reboxify/backend/tests/pickupScheduling.test.ts) using in-memory repositories + loopback HTTP supertest) |
| Frontend Typecheck | `npm --prefix frontend run typecheck` | Passed (`tsc --noEmit` exit `0`) |
| Frontend Production Build | `npm --prefix frontend run build` | Passed (`vite build`, 583 modules transformed cleanly) |
| Live Local Server Smoke Check | Express on `:5005` + Vite on `:3005` | `/api/health` returned HTTP `200` (`database.connected: true`, `replicaSetSupported: true`, `pickupSchedulerConfigured: true`, `bryntumSchedulerMode: "COMMUNITY_READY"`); `/api/pickups` unauthenticated returned `401`; Vite `/` returned HTTP `200` (`843` bytes). |
| Live Browser DevTools DOM Verification | `browser` subagent | **Not executed / Blocked:** Host Chrome remote debugging was unavailable (`ENOENT: DevToolsActivePort`). Visual interactive DOM & drag-drop inspection in a live Chrome browser remains unverified pending Chrome remote-debugging or manual browser walkthrough. |

