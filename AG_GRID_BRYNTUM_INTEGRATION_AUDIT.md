# AG Grid & Bryntum Scheduler Integration Audit (`rebuild/v2-mvp`)

**Audit Date:** 2026-11-12  
**Branch Audited:** `rebuild/v2-mvp`  
**Audit Mode:** Strictly read-only inspection of the full `frontend/`, `backend/`, and root workspace codebase. Zero packages were installed and zero source or configuration files were modified.  
**Browser Verification Note:** Per audit rule #9, no browser rendering or interactive click verification was performed against AG Grid or Bryntum components because **neither library is installed or rendered anywhere in `frontend/src`**.

---

## Executive Summary

| Integration | Package Installed? | Frontend UI Integrated? | Backend API / Conflict Logic? | Overall Completion (Functional Denominator) | Hackathon MVP Ready? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **AG Grid (`ag-grid-react` / `ag-grid-community`)** | **No** (`0%`) | **No** (`0%` — plain HTML `<table>` & `<div>` cards + 1 Phase 7 placeholder) | **Partial** (list pagination/sort/filter exist on 4 of 6 resource APIs, unused by frontend; `GET /api/audit-logs` missing; `0%` CSV export) | **`6.25%`** *(0.75 / 12 functional requirements)* | **No** |
| **Bryntum Scheduler (`@bryntum/scheduler` / `@bryntum/scheduler-react`)** | **No** (`0%`) | **No** (`0%` — 1 Phase 7 placeholder card + hardcoded `+24h` window + misleading green `ADAPTER_READY` health pill) | **Minimal Schema Only** (`PickupModel`, `DeliveryPartnerModel`, `CollectionCenterModel`, `pickupStateMachine` exist; `0` `/api/pickups` routes; `0` conflict/capacity checks) | **`3.5%`** *(0.35 / 10 functional requirements)* | **No** |

---

## 1. Exact Codebase Search Results

Full-repository search across all files on `rebuild/v2-mvp` (excluding `node_modules/`, `dist/`, and `.git/`):

| Search Term | Occurrences in `package.json` / `src/` | Exact Locations Found (Including Docs & Lockfiles) |
| :--- | :--- | :--- |
| `ag-grid-react` | **0** in `package.json` and `src/` | Docs only: [IMPLEMENTATION_ROADMAP.md](file:///d:/Projects/Reboxify/IMPLEMENTATION_ROADMAP.md#L63), [REBUILD_AUDIT.md](file:///d:/Projects/Reboxify/REBUILD_AUDIT.md#L98) |
| `ag-grid-community` | **0** anywhere | **0 occurrences** across entire repo |
| `AgGridReact` | **0** anywhere | **0 occurrences** across entire repo |
| `ag-grid` (case-insensitive) | **0** imports/packages; **1** UI placeholder text | Placeholder text at [CollectionCentrePortal.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/CollectionCentrePortal.tsx#L680-L682); otherwise planning/audit docs only |
| `@bryntum/scheduler` | **0** in `package.json` and `src/` | Docs only: [TECHNICAL_DECISIONS.md](file:///d:/Projects/Reboxify/TECHNICAL_DECISIONS.md#L37) |
| `@bryntum/scheduler-react` | **0** in `package.json` and `src/` | Docs only: [TECHNICAL_DECISIONS.md](file:///d:/Projects/Reboxify/TECHNICAL_DECISIONS.md#L34-L38) |
| `BryntumScheduler` | **0** anywhere | **0 occurrences** across entire repo |
| `bryntum` / `scheduler` (case-insensitive) | **3** code references (status strings & placeholder copy) + React's internal `scheduler` in lockfile | [healthRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/healthRoutes.ts#L27) (`bryntumSchedulerMode: 'ADAPTER_READY'`), [domain.ts](file:///d:/Projects/Reboxify/frontend/src/types/domain.ts#L46), [SystemStatusBanner.tsx](file:///d:/Projects/Reboxify/frontend/src/components/SystemStatusBanner.tsx#L54), [DeliveryPartnerApp.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/DeliveryPartnerApp.tsx#L306), and `frontend/package-lock.json:2003` (`"scheduler": "^0.28.0"`, which is React 19's internal reconciler scheduler, **not** Bryntum) |

---

## 2. Unused Dependencies, Dead Models, Placeholders & Custom Substitutes

### 2.1 Unused / Missing Dependencies (`frontend/package.json` & `backend/package.json`)
- **Missing required packages:** `ag-grid-react`, `ag-grid-community`, `@bryntum/scheduler`, and `@bryntum/scheduler-react` are absent from [frontend/package.json](file:///d:/Projects/Reboxify/frontend/package.json), [backend/package.json](file:///d:/Projects/Reboxify/backend/package.json), and root [package.json](file:///d:/Projects/Reboxify/package.json). There is no `.npmrc` for Bryntum's private registry (`https://npm.bryntum.com`).
- **Orphaned unused packages in [frontend/package.json](file:///d:/Projects/Reboxify/frontend/package.json#L15-L21):** `leaflet` (`^1.9.4`), `react-leaflet` (`^5.0.0`), and `@types/leaflet` (`^1.9.21`) are installed with **0 imports** anywhere in `frontend/src/`.

### 2.2 Dead / Partially Wired Backend Models & State Machines
1. **`DeliveryPartnerModel` ([DeliveryPartner.ts](file:///d:/Projects/Reboxify/backend/src/models/DeliveryPartner.ts#L18-L39)):** Defines `userId`, `displayName`, `serviceZones`, `workingHours` (`startHour`, `endHour`, `daysOfWeek`), `dailyCapacity`, and `status`. Re-exported in [models/index.ts](file:///d:/Projects/Reboxify/backend/src/models/index.ts#L10), **never queried or written by any service, repository, or route**. Partner lookup (`listDeliveryPartners` in [passportService.ts](file:///d:/Projects/Reboxify/backend/src/services/passportService.ts#L1259-L1269) and `assignReturnPartner` in [returnService.ts](file:///d:/Projects/Reboxify/backend/src/services/returnService.ts#L493)) reads `UserModel` (`role: 'DELIVERY_PARTNER'`) instead.
2. **`CollectionCenterModel` ([CollectionCenter.ts](file:///d:/Projects/Reboxify/backend/src/models/CollectionCenter.ts#L17-L38)):** Defines `code`, `serviceZones`, `hours`, `capacity`, `currentWorkload`, and `status`. Re-exported in [models/index.ts](file:///d:/Projects/Reboxify/backend/src/models/index.ts#L12), **never queried or written anywhere in `backend/src`**.
3. **`PickupModel` ([Pickup.ts](file:///d:/Projects/Reboxify/backend/src/models/Pickup.ts#L34-L70)):** Written **only once** inside `MongooseReturnRepository.createReturnWithPackageAtomically` ([phase5Repositories.ts](file:///d:/Projects/Reboxify/backend/src/repositories/phase5Repositories.ts#L537-L550)) when `POST /api/returns` runs with `mode: 'PICKUP'` or `'NEXT_DELIVERY_SWAP'`, always defaulting to `status: 'UNASSIGNED'`. **Zero code ever reads, lists, assigns `partnerId`, updates `status`, checks `slotStart`/`slotEnd` overlaps, or appends `rescheduleHistory`**. *(Confirmed during live verification of `RET-20261112-6CA306`: `Pickup` `6af5ca6f36463abba854d711` remained `status: "UNASSIGNED"` even after return partner assignment and collection.)* Additionally, `Pickup.ts:48` sets `partnerId` `ref: 'DeliveryPartner'`, whereas `Return.ts:108` references `'User'`.
4. **`pickupStateMachine` ([machines.ts](file:///d:/Projects/Reboxify/backend/src/stateMachines/machines.ts#L79-L87)):** Only unit-tested in [stateMachines.test.ts](file:///d:/Projects/Reboxify/backend/tests/stateMachines.test.ts#L35-L37); **0 imports or runtime calls** in any service or route.
5. **`AuditLogModel` ([AuditLog.ts](file:///d:/Projects/Reboxify/backend/src/models/AuditLog.ts)):** Written by `MongoAuditWriter` ([auditService.ts](file:///d:/Projects/Reboxify/backend/src/services/auditService.ts#L29)), **0 read routes** (`GET /api/audit-logs` does not exist for an Audit Log AG Grid table).

### 2.3 Placeholder Implementations & Misleading Readiness Indicator
- [CollectionCentrePortal.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/CollectionCentrePortal.tsx#L676-L684): Renders a static card tagged `"Pending Phase 7 API"` titled `"AG Grid Operational Ledger & CSV Export"`.
- [DeliveryPartnerApp.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/DeliveryPartnerApp.tsx#L298-L308): Renders a static card tagged `"Pending Phase 7 API"` titled `"Assigned Pickup Slots & Schedule Sync"` referencing `GET /api/pickups`.
- [healthRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/healthRoutes.ts#L27) + [SystemStatusBanner.tsx](file:///d:/Projects/Reboxify/frontend/src/components/SystemStatusBanner.tsx#L54): Backend hardcodes `bryntumSchedulerMode: 'ADAPTER_READY'`, and `SystemStatusBanner` renders a **green (`ok: true`) badge `Scheduler: ADAPTER_READY`** across all 5 portals even though no `/api/pickups` route or Bryntum adapter exists.

### 2.4 Custom Substitutes Currently Used Instead of AG Grid & Bryntum
- **Substitutes for AG Grid (plain HTML `<table>` / `<div>` lists):**
  1. [CompanyAdminPortal.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/CompanyAdminPortal.tsx#L666-L693): `PayPal Sandbox Transactions & Deposit Allocations` (`<table>`)
  2. [CompanyAdminPortal.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/CompanyAdminPortal.tsx#L714-L776): `Eligible Inventory & Digital Passports` (`<table>`)
  3. [CompanyAdminPortal.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/CompanyAdminPortal.tsx#L579-L656): `Orders & Deterministic Package Allocation` (`<div>` card list)
  4. [CollectionCentrePortal.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/CollectionCentrePortal.tsx#L613-L671): `Network Packages & QR Credential Controls` (`<table>`) and `Returns Intake` (`<div>` cards at `:447-587`)
  5. [AdminDashboard.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/AdminDashboard.tsx#L425-L469): `Merchant Businesses` (`<table>`)
  6. [AdminDashboard.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/AdminDashboard.tsx#L492-L556): `Network Packaging Inventory` (`<table>`)
  7. [AdminDashboard.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/AdminDashboard.tsx#L577-L604): `Network PayPal Sandbox Transactions & Deposit Ledger` (`<table>`)
  8. [ReturnsManagementSection.tsx](file:///d:/Projects/Reboxify/frontend/src/components/ReturnsManagementSection.tsx#L116-L218): `Returns` (`<table>`, rendered inside `CompanyAdminPortal` and `AdminDashboard`)
- **Substitutes for Bryntum Scheduler:**
  1. [UserPortal.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/UserPortal.tsx#L167-L188): Hardcodes `pickupWindowStart = now + 24h` and `pickupWindowEnd = now + 26h` when `mode === 'PICKUP'`.
  2. [ReturnsManagementSection.tsx](file:///d:/Projects/Reboxify/frontend/src/components/ReturnsManagementSection.tsx#L161-L178) & [CollectionCentrePortal.tsx](file:///d:/Projects/Reboxify/frontend/src/pages/CollectionCentrePortal.tsx#L480-L495): Plain `<select>` dropdown (`Assign Partner...`) calling `POST /api/returns/:id/assign-partner`, updating `ReturnModel.assignedPartnerUserId` with **no** timeline view, **no** slot editing, and **no** conflict/capacity checks.

---

## 3. End-to-End Traceability & Functional Verification

All 5 portals are reachable via `HashRouter` in [App.tsx](file:///d:/Projects/Reboxify/frontend/src/App.tsx#L18-L78) (`/user-portal`, `/company-admin`, `/delivery-partner`, `/collection-centre`, `/super-admin`), guarded by role checks.

### 3.1 AG Grid Trace: UI -> API Client -> Route -> Service -> MongoDB Model

| Portal Table / Queue | Rendered UI Component | API Client Call (`frontend/src/api/`) | Backend Route & Service | MongoDB Model & Backend Support | Sorting / Filtering / Pagination / CSV Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Merchant / Admin Inventory** | `<table>` in [CompanyAdminPortal.tsx:714](file:///d:/Projects/Reboxify/frontend/src/pages/CompanyAdminPortal.tsx#L714), [CollectionCentrePortal.tsx:613](file:///d:/Projects/Reboxify/frontend/src/pages/CollectionCentrePortal.tsx#L613), [AdminDashboard.tsx:492](file:///d:/Projects/Reboxify/frontend/src/pages/AdminDashboard.tsx#L492) | `listInventory({ pageSize: 50 })` in [phase2.ts:103-114](file:///d:/Projects/Reboxify/frontend/src/api/phase2.ts#L103-L114) | `GET /api/inventory` ([inventoryRoutes.ts:67-76](file:///d:/Projects/Reboxify/backend/src/routes/inventoryRoutes.ts#L67-L76)) -> `PackagingService.listInventory` | `PackageModel` ([phase2Repositories.ts:668-719](file:///d:/Projects/Reboxify/backend/src/repositories/phase2Repositories.ts#L668-L719)) supports `page`, `pageSize`, `status`, `packageClass`, `ownerType`, `search`, `sortBy`, `sortDir` | **Frontend `0%`:** `pageSize: 50` hardcoded; `phase2.ts` omits `sortBy`/`sortDir`/`search`; zero sort/filter/page/CSV controls in UI. |
| **Orders & Packages** | `<div>` cards in [CompanyAdminPortal.tsx:579-656](file:///d:/Projects/Reboxify/frontend/src/pages/CompanyAdminPortal.tsx#L579-L656) | `listOrders({ pageSize: 50 })` in [phase2.ts:134-141](file:///d:/Projects/Reboxify/frontend/src/api/phase2.ts#L134-L141) | `GET /api/orders` ([orderRoutes.ts:69-78](file:///d:/Projects/Reboxify/backend/src/routes/orderRoutes.ts#L69-L78)) -> `OrderService.listOrders` | `OrderModel` ([phase2Repositories.ts:852-889](file:///d:/Projects/Reboxify/backend/src/repositories/phase2Repositories.ts#L852-L889)) supports `page`, `pageSize`, `status`, `sortBy`, `sortDir` | **Frontend `0%`:** Rendered as cards, `pageSize: 50` hardcoded, `sortBy`/`sortDir` omitted in `phase2.ts`, no table/filters/CSV. |
| **Transactions & Refunds** | `<table>` in [CompanyAdminPortal.tsx:666](file:///d:/Projects/Reboxify/frontend/src/pages/CompanyAdminPortal.tsx#L666), [AdminDashboard.tsx:577](file:///d:/Projects/Reboxify/frontend/src/pages/AdminDashboard.tsx#L577) | `listTransactions({ pageSize: 50 })` in [phase3.ts:63-72](file:///d:/Projects/Reboxify/frontend/src/api/phase3.ts#L63-L72) | `GET /api/transactions` ([paymentRoutes.ts:106-115](file:///d:/Projects/Reboxify/backend/src/routes/paymentRoutes.ts#L106-L115)) -> `PaymentService.listTransactions` | `TransactionModel` ([phase3Repositories.ts:207-246](file:///d:/Projects/Reboxify/backend/src/repositories/phase3Repositories.ts#L207-L246)) supports `page`, `pageSize`, `state`, `sortBy`, `sortDir` | **Frontend `0%`:** `pageSize: 50` hardcoded, `sortBy`/`sortDir` omitted in `phase3.ts`, no UI filter/sort/page/CSV. |
| **Returns & Inspection Queue** | `<table>` in [ReturnsManagementSection.tsx:116](file:///d:/Projects/Reboxify/frontend/src/components/ReturnsManagementSection.tsx#L116); `<div>` cards in [CollectionCentrePortal.tsx:447](file:///d:/Projects/Reboxify/frontend/src/pages/CollectionCentrePortal.tsx#L447) | `listReturns({ pageSize: 50 })` in [phase5.ts:28-38](file:///d:/Projects/Reboxify/frontend/src/api/phase5.ts#L28-L38) | `GET /api/returns` ([returnRoutes.ts:113-121](file:///d:/Projects/Reboxify/backend/src/routes/returnRoutes.ts#L113-L121)) -> `ReturnService.listReturns` | `ReturnModel` ([phase5Repositories.ts:624-674](file:///d:/Projects/Reboxify/backend/src/repositories/phase5Repositories.ts#L624-L674)) supports `page`, `pageSize`, `status`, `merchantId`, `sortBy`, `sortDir` | **Frontend `0%`:** `pageSize: 50` hardcoded, `sortBy`/`sortDir` omitted in `phase5.ts`, no UI filter/sort/page/CSV. |
| **Businesses (Admin)** | `<table>` in [AdminDashboard.tsx:425](file:///d:/Projects/Reboxify/frontend/src/pages/AdminDashboard.tsx#L425) | `listBusinesses({ pageSize: 50 })` in [phase2.ts:15-22](file:///d:/Projects/Reboxify/frontend/src/api/phase2.ts#L15-L22) | `GET /api/businesses` ([businessRoutes.ts:81-94](file:///d:/Projects/Reboxify/backend/src/routes/businessRoutes.ts#L81-L94)) -> `BusinessService.listBusinesses` | `BusinessModel` ([phase2Repositories.ts:456-483](file:///d:/Projects/Reboxify/backend/src/repositories/phase2Repositories.ts#L456-L483)) supports `page`, `pageSize`, `status`, `packagingModel` (**no `sortBy`/`sortDir`**) | **Frontend `0%`**; backend lacks `sortBy`/`sortDir` on businesses. |
| **Operational Ledger Placeholder** | Static card in [CollectionCentrePortal.tsx:676-684](file:///d:/Projects/Reboxify/frontend/src/pages/CollectionCentrePortal.tsx#L676-L684) | **None** | **None** | **None** | **Not implemented (`0%`)**. |
| **Audit Log Table (Admin)** | **None** (not rendered in `AdminDashboard`) | **None** | **None** (`GET /api/audit-logs` not mounted in [app.ts](file:///d:/Projects/Reboxify/backend/src/app.ts#L75-L86)) | `AuditLogModel` is write-only via `MongoAuditWriter` ([auditService.ts:29](file:///d:/Projects/Reboxify/backend/src/services/auditService.ts#L29)) | **Not implemented (`0%`)**. |

### 3.2 Bryntum Scheduler Trace: UI -> API Client -> Route -> Service -> MongoDB Model

| Scheduling Flow | Rendered UI Component | API Client Call | Backend Route & Service | MongoDB Persistence & Conflict Prevention |
| :--- | :--- | :--- | :--- | :--- |
| **Customer Pickup Slot Selection** | None — [UserPortal.tsx:167-188](file:///d:/Projects/Reboxify/frontend/src/pages/UserPortal.tsx#L167-L188) hardcodes `start = now + 24h`, `end = now + 26h` | `initiateReturn` ([phase5.ts:10-26](file:///d:/Projects/Reboxify/frontend/src/api/phase5.ts#L10-L26)) -> `POST /api/returns` | `ReturnService.initiateReturn` ([returnService.ts:298-320](file:///d:/Projects/Reboxify/backend/src/services/returnService.ts#L298-L320)) | Creates `PickupModel` with `status: 'UNASSIGNED'` ([phase5Repositories.ts:537](file:///d:/Projects/Reboxify/backend/src/repositories/phase5Repositories.ts#L537)). **No slot availability, centre capacity, or working-hours check.** |
| **Operator Timeline / Partner Assignment** | Plain `<select>` on return rows ([ReturnsManagementSection.tsx:165](file:///d:/Projects/Reboxify/frontend/src/components/ReturnsManagementSection.tsx#L165), [CollectionCentrePortal.tsx:484](file:///d:/Projects/Reboxify/frontend/src/pages/CollectionCentrePortal.tsx#L484)); **no Bryntum timeline** | `assignReturnPartner` ([phase5.ts:50-58](file:///d:/Projects/Reboxify/frontend/src/api/phase5.ts#L50-L58)) -> `POST /api/returns/:id/assign-partner` | `ReturnService.assignReturnPartner` ([returnService.ts:465-538](file:///d:/Projects/Reboxify/backend/src/services/returnService.ts#L465-L538)) | Updates `ReturnModel` only; **`PickupModel` is NOT updated** (`partnerId` and `status` stay unset/`UNASSIGNED`). **Zero double-booking, zone, working-hours, or daily capacity checks.** |
| **Pickup Queue / Rescheduling (`GET/POST/PATCH /api/pickups`)** | Static `"Pending Phase 7 API"` card in [DeliveryPartnerApp.tsx:298-308](file:///d:/Projects/Reboxify/frontend/src/pages/DeliveryPartnerApp.tsx#L298-L308) | **None** | **None** (not mounted in [app.ts](file:///d:/Projects/Reboxify/backend/src/app.ts#L75-L86)) | `DeliveryPartnerModel`, `CollectionCenterModel`, and `pickupStateMachine` are **dead/unwired**; **zero** optimistic `version` conflict checks or `rescheduleHistory` writes exist. |

---

## 4. Integration Completion Percentages (Functional Denominator)

### 4.1 AG Grid Integration (`6.25%` Overall)

Evaluated against **12 verified functional requirements** (no full credit for partial backend plumbing):

| # | Functional Requirement | Dimension | Score | Evidence |
| :-: | :--- | :--- | :-: | :--- |
| 1 | `ag-grid-react` & `ag-grid-community` installed in `frontend/package.json` | Package Installation | `0.00` | Neither package is installed. |
| 2 | Reusable `<AgGridReact>` grid component & styling integrated | Frontend Integration | `0.00` | No grid component exists; plain HTML `<table>` used. |
| 3 | Merchant Inventory table (`CompanyAdminPortal`) using AG Grid | Frontend Integration | `0.00` | Plain `<table>` (`CompanyAdminPortal.tsx:714`). |
| 4 | Orders & Packages table (`CompanyAdminPortal`) using AG Grid | Frontend Integration | `0.00` | `<div>` cards (`CompanyAdminPortal.tsx:579-656`). |
| 5 | Returns table (`CompanyAdminPortal`, `AdminDashboard`, `CollectionCentrePortal`) using AG Grid | Frontend Integration | `0.00` | Plain `<table>` (`ReturnsManagementSection.tsx:116`) / `<div>` cards (`CollectionCentrePortal.tsx:447`). |
| 6 | Transactions & Refunds ledger (`CompanyAdminPortal`, `AdminDashboard`) using AG Grid | Frontend Integration | `0.00` | Plain `<table>` (`CompanyAdminPortal.tsx:666`, `AdminDashboard.tsx:577`). |
| 7 | Collection-Centre Operational / Inspection Queue AG Grid | Frontend Integration | `0.00` | Plain `<table>` (`:613`) + static `"Pending Phase 7 API"` card (`:676-684`). |
| 8 | Admin Audit Log AG Grid + `GET /api/audit-logs` endpoint | Frontend + Backend | `0.00` | Neither backend read route nor frontend table exists. |
| 9 | Server-side / grid pagination (`page`, `pageSize`, page controls) | Backend + Functional | `0.25` | Backend `list*` routes support `page`/`pageSize`, **but** frontend hardcodes `pageSize: 50` with zero pagination controls. |
| 10 | Server-side / grid column sorting (`sortBy`, `sortDir`) | Backend + Functional | `0.25` | Backend supports `sortBy`/`sortDir` on 4 endpoints (`inventory`, `orders`, `transactions`, `returns`), **but** omitted in `frontend/src/api/*` and `businesses` route; headers are non-sortable. |
| 11 | Server-side / grid column filtering (`status`, `state`, `search`, etc.) | Backend + Functional | `0.25` | Backend accepts filter query params, **but** portals pass no filter params and render no filter UI. |
| 12 | CSV Export (`exportDataAsCsv` / download endpoint) | Functional / Prod | `0.00` | Zero CSV export implementation anywhere. |

- **Total AG Grid Functional Score:** `0.75 / 12` = **`6.25%`**
  - Package installation: **`0%`** (`0 / 1`)
  - Actual frontend integration: **`0%`** (`0 / 7` UI items)
  - Backend/API integration: **~`58%` partial** on existing list endpoints (`page`/`pageSize`/`sortBy`/`sortDir`/filters exist on `inventory`, `orders`, `transactions`, `returns`; missing `sortBy`/`sortDir` on `businesses`/`products`; missing `GET /api/audit-logs` completely)
  - Functional behaviour (sorting, filtering, pagination, CSV in UI): **`0%`**
  - Production readiness: **`0%`**

### 4.2 Bryntum Scheduler Integration (`3.5%` Overall)

Evaluated against **10 verified functional requirements**:

| # | Functional Requirement | Dimension | Score | Evidence |
| :-: | :--- | :--- | :-: | :--- |
| 1 | `@bryntum/scheduler` & `@bryntum/scheduler-react` installed (with `.npmrc` / licence or trial) | Package Installation | `0.00` | Not installed; no `.npmrc` token/licence configured. |
| 2 | `<BryntumScheduler>` React timeline widget integrated in portals | Frontend Integration | `0.00` | Zero Bryntum components; static `"Pending Phase 7 API"` card (`DeliveryPartnerApp.tsx:298-308`). |
| 3 | Pickup Scheduler REST routes (`GET /api/pickups`, `POST /api/pickups`, `PATCH /api/pickups/:id`) | Backend/API Integration | `0.00` | Zero `/api/pickups` routes mounted in `app.ts`. |
| 4 | `PickupModel` lifecycle persistence & `pickupStateMachine` enforcement | Backend/API Integration | `0.15` | `PickupModel` created on `POST /api/returns` (`status: 'UNASSIGNED'`), but never updated/read/transitioned; `pickupStateMachine` unused at runtime. |
| 5 | Delivery partner zones, working hours & daily capacity enforcement (`DeliveryPartnerModel`) | Backend/API + Functional | `0.10` | `DeliveryPartnerModel` schema exists, but unused by all services/routes. |
| 6 | Collection-centre capacity & workload tracking (`CollectionCenterModel`) | Backend/API + Functional | `0.10` | `CollectionCenterModel` schema exists, but unused by all services/routes. |
| 7 | Server-side double-booking prevention, time-slot overlap & optimistic `version` conflict checks | Functional / Prod | `0.00` | Not implemented anywhere. |
| 8 | Customer pickup time-slot selector (`UserPortal`) | Functional Behaviour | `0.00` | `UserPortal.tsx:167-179` hardcodes `now + 24h` to `now + 26h`. |
| 9 | Operator assignment & drag-and-drop rescheduling timeline | Functional Behaviour | `0.00` | Only plain `<select>` partner dropdown on return rows; no time-window editing or rescheduling. |
| 10 | Delivery partner slot feed, missed-pickup rescheduling & exception workflow | Functional / Prod | `0.00` | Placeholder card in `DeliveryPartnerApp.tsx:298-308`; `rescheduleHistory` never written. |

- **Total Bryntum Scheduler Functional Score:** `0.35 / 10` = **`3.5%`**
  - Package installation: **`0%`**
  - Actual frontend integration: **`0%`**
  - Backend/API integration: **~`10%` partial** (schemas & initial `PickupModel` insert only; `0%` `/api/pickups` routes or service methods)
  - Functional behaviour (scheduling, persistence updates, server conflict prevention): **`0%`**
  - Production readiness: **`0%`**

---

## 5. Final Recommendation

1. **Is AG Grid ready for the hackathon MVP?**
   **No.** `ag-grid-react` and `ag-grid-community` are not installed, and all operational tables are plain HTML `<table>` elements (`pageSize: 50`, no sorting/filtering/pagination controls, no CSV export, and no `GET /api/audit-logs`).

2. **Is Bryntum Scheduler ready for the hackathon MVP?**
   **No.** `@bryntum/scheduler` and `@bryntum/scheduler-react` are not installed, no `/api/pickups` routes or conflict-prevention checks exist, `PickupModel` stays permanently `UNASSIGNED` after return creation, and `GET /api/health` + `SystemStatusBanner` currently misreport `Scheduler: ADAPTER_READY` in green.

3. **Which missing features are essential vs. optional?**
   - **Essential (for Blueprint compliance & functional integrity):**
     - Install **AG Grid Community** (`ag-grid-react` + `ag-grid-community`, zero licence cost) and wire all 6 operational tables (including `GET /api/audit-logs`) to the existing backend `page`/`pageSize`/`sortBy`/`sortDir`/filter query params + built-in CSV export.
     - Build the **server-side `/api/pickups` scheduling & conflict-prevention engine** (`GET /api/pickups`, `POST /api/pickups`, `PATCH /api/pickups/:id`) enforcing `pickupStateMachine`, zone match, working hours, daily capacity, double-booking overlap checks, optimistic `version` locking, and syncing `PickupModel` during `assignReturnPartner` / `collectReturn`.
     - Replace hardcoded `+24h` pickup windows in `UserPortal` and the `ADAPTER_READY` green badge in `healthRoutes.ts` until real routes are live.
   - **Optional / Substitutable (pending licensing):**
     - Commercial/45-day-trial `@bryntum/scheduler-react` registry installation (if Bryntum's private `.npmrc` token is not available for the hackathon, a Bryntum-compatible timeline adapter component wired to the real conflict-checked `/api/pickups` API preserves full functional scheduling without private registry blockers).

4. **What is the minimum implementation effort required?**
   - **AG Grid Community:** Low-to-moderate effort (Phase 7 Step 7.1): install public npm packages (`ag-grid-react`, `ag-grid-community`), add `sortBy`/`sortDir`/`page` params to `frontend/src/api/phase2.ts`, `phase3.ts`, `phase5.ts`, add `GET /api/audit-logs`, build 1 reusable `<OperationalGrid>` wrapper with pagination/sort/filter + `exportDataAsCsv()`, and replace the plain `<table>` blocks across `CompanyAdminPortal`, `CollectionCentrePortal`, and `AdminDashboard`.
   - **Bryntum / Pickup Scheduling:** Moderate effort (Phase 7 Step 7.2): implement `pickupService.ts` + `pickupRoutes.ts` (wiring `PickupModel`, `DeliveryPartnerModel`, `CollectionCenterModel`, `pickupStateMachine`, and `returnService.ts` sync), add slot picker in `UserPortal`, replace `DeliveryPartnerApp`'s Phase 7 placeholder, and mount `@bryntum/scheduler-react` (or the Bryntum-compatible timeline adapter if no `.npmrc` token is provided). Also remove orphaned `leaflet`/`react-leaflet`/`@types/leaflet` from `frontend/package.json`.

5. **Should Phase 6 proceed, or should these integrations be completed first?**
   - **Phase 6 (`Render Deployment & Background Worker`) can proceed first**—specifically implementing the `worker.ts` PayPal pending reconciliation loop and live Render HTTPS webhook verification, after fixing the `render.yaml` `reboxify-worker` missing secret env vars and the `returnService.ts` zero-refund state-machine bug—**provided** `healthRoutes.ts` is updated so it does not claim `Scheduler: ADAPTER_READY` prematurely.
   - **However, Phase 7 (AG Grid Community + conflict-checked `/api/pickups` Scheduler UI) MUST be completed right after Phase 6 before the final hackathon MVP submission**, because both integrations are currently at `6.25%` and `3.5%` respectively (`0%` functional UI).

