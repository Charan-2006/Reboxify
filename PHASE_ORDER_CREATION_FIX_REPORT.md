# ReBoxify — Order Creation MongoDB Transaction Fix Report

**Branch:** `rebuild/v2-mvp` (uncommitted; ready for review)

---

## 1. Root Cause & Exact Affected Code Locations

Clicking **`PLACE ORDER & ALLOCATE REUSABLE PACKAGE`** in `UserPortal` executes `POST /api/orders` (`autoAllocate: true`), which opens an active MongoDB replica-set transaction via `runInTransaction()` in [orderService.ts](file:///d:/Projects/Reboxify/backend/src/services/orderService.ts#L124-L161) and calls `executeAllocationInSession()` -> `MongoosePackageRepository.reservePackagesAtomically()`.

Inside that transaction:
- `MongooseOrderRepository.create` and `PackageEventModel.create` each passed a single-document array `[doc]` with `{ session }`, which Mongoose allows cleanly.
- **Root Failure ([phase2Repositories.ts](file:///d:/Projects/Reboxify/backend/src/repositories/phase2Repositories.ts#L808-L814) lines 808–814):** `MongoosePackageRepository.reservePackagesAtomically` called:
  ```ts
  await SearchOutboxModel.create(
    [
      { entityType: 'passport', entityId: updated.packageId, operation: 'UPSERT', status: 'PENDING' },
      { entityType: 'package_event', entityId: evtId, operation: 'UPSERT', status: 'PENDING' },
    ],
    { session: session ?? undefined }
  );
  ```
- Mongoose 8 (`mongoose/lib/model.js:2727-2729`) throws `Cannot call create() with a session and multiple documents unless ordered: true is set` whenever `docs.length > 1` is passed with `{ session }` without `ordered: true`. Previously this only surfaced against live MongoDB Atlas (`replicaSet=true`) because automated HTTP test harnesses used in-memory repository implementations with `session = null`.
- **Same Pattern Found & Fixed in Phase 5 ([phase5Repositories.ts](file:///d:/Projects/Reboxify/backend/src/repositories/phase5Repositories.ts#L481-L485) line 485):** `appendEventAndOutbox` likewise passed a multi-document `outboxDocs` array (2–3 entries) to `SearchOutboxModel.create(outboxDocs, { session: session ?? undefined })` inside return and refund transactions.
- **Idempotency Gap Found on `POST /api/orders` ([orderRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/orderRoutes.ts#L51-L97)):** `POST /api/orders` and `POST /api/orders/:id/allocate-package` lacked `requireIdempotency` middleware, meaning retries or UI double-clicks could create duplicate `PLACED`/`ALLOCATED` orders.

All other `Model.create()` calls across Phase 1–5 repositories were audited and confirmed to pass single documents cleanly.

---

## 2. Files Created & Modified

1. [outboxHelper.ts](file:///d:/Projects/Reboxify/backend/src/repositories/outboxHelper.ts) *(new)* — Shared transactional `enqueueSearchOutbox(entries, session)` helper passing `{ session, ordered: true }` whenever a Mongoose `ClientSession` is active.
2. [phase2Repositories.ts](file:///d:/Projects/Reboxify/backend/src/repositories/phase2Repositories.ts) — Updated `MongoosePackageRepository.create` and `MongoosePackageRepository.reservePackagesAtomically` to write `SearchOutbox` entries via `enqueueSearchOutbox` inside the transaction session.
3. [phase5Repositories.ts](file:///d:/Projects/Reboxify/backend/src/repositories/phase5Repositories.ts) — Updated `appendEventAndOutbox` and `transitionReturnAndPackageAtomically` to write `SearchOutbox` entries via `enqueueSearchOutbox` inside transaction sessions.
4. [orderRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/orderRoutes.ts) & [app.ts](file:///d:/Projects/Reboxify/backend/src/app.ts) — Wired optional `requireIdempotency('ORDER_CREATE')` on `POST /api/orders` and `requireIdempotency('ORDER_ALLOCATE')` on `POST /api/orders/:id/allocate-package` using the shared `idempotencyStore`.
5. [phase2.ts](file:///d:/Projects/Reboxify/frontend/src/api/phase2.ts) & [UserPortal.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/UserPortal.tsx) — Added optional `Idempotency-Key` support to `createOrder` and disabled in-flight double-submission on `Place Order & Allocate Reusable Package`.
6. [orderCreationTransaction.test.ts](file:///d:/Projects/Reboxify/backend/tests/orderCreationTransaction.test.ts) *(new)* — Regression, rollback, idempotency, and concurrent race verification suite.

---

## 3. Transaction, Rollback & Inventory Allocation Verification

- **Exact Error Reproduction & Fix Proof:** `orderCreationTransaction.test.ts` reproduces Mongoose's exact `Cannot call create() with a session and multiple documents unless ordered: true is set` rejection on un-ordered multi-document `SearchOutboxModel.create` with a `ClientSession`, and verifies both `enqueueSearchOutbox` and `MongoosePackageRepository.reservePackagesAtomically` pass `{ session, ordered: true }` cleanly.
- **Atomicity & Linked Persistence:** Inside a single `runTx` session boundary:
  1. Order created (`PLACED`) -> 8-step deterministic allocation selects eligible container -> `PackageModel.findOneAndUpdate({ _id, status: 'AVAILABLE' })` reserves package (`RESERVED`, custodian `MERCHANT`, `currentOrderId` set).
  2. Append-only `PACKAGE_RESERVED` `PackageEvent` created with `session`.
  3. Both `passport` and `package_event` `SearchOutbox` records inserted via `{ session, ordered: true }`.
  4. Order updated atomically (`ALLOCATED`, `allocatedPackages[]`, `depositTotal`, `grandTotal`) and `ORDER_CREATED` audit event recorded.
- **Rollback Verification:** Injecting a failure mid-transaction rolls back the draft `Order`, resets package status to `AVAILABLE` with `currentOrderId` unset, and removes uncommitted `PACKAGE_RESERVED` events and `SearchOutbox` rows (zero orphaned records).
- **Idempotency & Concurrency:** Repeated `POST /api/orders` with the same `Idempotency-Key` replays the original `201` order without creating duplicates; reusing the key with altered payload fails with `409 IDEMPOTENCY_CONFLICT`; two concurrent customer orders racing for a single `AVAILABLE` package yield `[201, 409]` (`ALLOCATION_CONFLICT`), preventing double allocation.

---

## 4. Tests, Typechecks & Builds Executed (Post-Edit Results)

| Check | Command | Result |
| :--- | :--- | :--- |
| Backend Typecheck & Compile | `npm --prefix backend run typecheck` + `npm --prefix backend run build` | **Passed (`exit 0`)** |
| Frontend Typecheck & Production Build | `npm --prefix frontend run typecheck` + `npm --prefix frontend run build` | **Passed (`exit 0`, 95 modules)** |
| Full Backend Test Suite | `npm --prefix backend test` (`vitest run`) | **Passed: `9/9` test files, `37/37` tests** (`stateMachines` 3, `allocationEngine` 7, `packageEventScanIdIndex` 4, `authAndRbac` 4, `phase2Api` 2, `orderCreationTransaction` 2, `phase3Payments` 3, `phase4PassportsAndQr` 6, `phase5ReturnsRefundsWebhooks` 6) |

---

## 5. Remaining Live-Environment Limitations

- Live automated integration tests in Vitest mock the Mongoose session/models or use in-memory repositories; after restarting your local preview backend (`http://localhost:5000`) wired to live MongoDB Atlas (`replicaSet=true`), live order creation through `UserPortal` (`http://localhost:3000/`) should be re-tested directly end-to-end with your product/package data.
- Live PayPal Sandbox checkout, GridFS file streams, and Render worker loops remain out of scope for this fix.

