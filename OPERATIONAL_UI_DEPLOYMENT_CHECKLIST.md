# ReBoxify — Operational UI Deployment & Verification Checklist

## 1. Pre-Deployment Verification Gates

- [x] **Backend TypeScript Check:** `npm --prefix backend run typecheck` (`0` errors)
- [x] **Backend Production Build:** `npm --prefix backend run build` (`0` errors, `dist/` updated)
- [x] **Backend Regression & Pickup Scheduling Suite:** `npm --prefix backend test` (**11/11 files, 46/46 tests passing**, including working hours, unavailable periods, service zones, overlap & daily capacity, self-reschedule, optimistic locking, concurrent booking serialization, RBAC, tenant isolation, and QR completion gating)
- [x] **Frontend TypeScript Check:** `npm --prefix frontend run typecheck` (`0` errors)
- [x] **Frontend Production Build:** `npm --prefix frontend run build` (`vite build` succeeded, 583 modules bundled with AG Grid Quartz theme + Bryntum Svalbard CSS & FontAwesome fonts)
- [x] **Workspace Boundary Check:** No secrets hardcoded or committed; branch `rebuild/v2-mvp` clean of unrequested commits/pushes; Phase 6 worker & PayPal workflows intact; Gemini/Elasticsearch untouched.

---

## 2. Deployment Configuration Notes

1. **CORS & API URL Configuration:**
   - Ensure backend `CORS_ORIGIN` includes the deployed frontend origin (comma-separated if multiple).
   - Ensure frontend `VITE_API_BASE_URL` points to the deployed Render Web Service URL (`reboxify-api`).
2. **MongoDB Indexes:**
   - Updated indexes on `pickups` (`{ status: 1, slotStart: 1 }`, `{ collectionCenterId: 1, status: 1 }`, `{ partnerId: 1, slotStart: 1, slotEnd: 1 }`) will be ensured cleanly by Mongoose upon startup against MongoDB Atlas M0/Replica Set.
   - Multi-document scheduling transactions require MongoDB Replica Set (`replicaSetSupported: true`), already verified in `reboxify-api` startup against Atlas.
3. **Health Endpoint Truthfulness:**
   - `GET /api/health` now reports:
     - `integrations.pickupSchedulerConfigured: true`
     - `integrations.bryntumSchedulerMode: "COMMUNITY_READY"`
4. **Static Asset / CSS Bundle Size Note:**
   - `vite build` reports a single main JS bundle (~4.23 MB minified / 1.25 MB gzipped) due to AG Grid Community + Bryntum Scheduler + PayPal/QR libraries. Functional for Render Static Site deployment; optional route-level code splitting can optimize initial load time later.

---

## 3. Manual Browser Walkthrough (Required Before Demo / Sign-Off)

Because Chrome DevTools remote debugging (`DevToolsActivePort`) was unavailable during automated execution, run this quick manual verification in Chrome against the running app (`npm --prefix backend run dev` + `npm --prefix frontend run dev`):

1. **Landing Page:** Confirm `SystemStatusBanner` displays `API Online` and `Scheduler: COMMUNITY_READY` in emerald green.
2. **Admin / Merchant / Collection Centre Portals:**
   - Open Orders, Inventory, Packages, Returns, and Payments sections and confirm AG Grid tables render rows cleanly in both Dark and Light theme modes.
   - Click sortable column headers (e.g., `Order #`, `Grand Total`, `Package ID`, `Reuse / Limit`, `Amount`), type in search inputs, switch status/condition filters, change page size (`10 -> 25 -> 50`), and test `Export CSV`.
   - Open `Return Pickup Scheduler & Dispatch Timeline` (`<BryntumScheduler>`): switch Day / Week / 2 Weeks presets, create/assign a pickup, drag an event to a partner lane, and verify server rejection visually reverts an invalid/conflicting move with an error alert.
3. **Delivery Partner Portal:**
   - Open `My Assigned Pickup Schedule & QR Collection`, inspect an assigned pickup slot, edit `Partner Availability`, and verify QR token collection transitions both the pickup (`COMPLETED`) and return (`COLLECTED`).
4. **Customer Portal:**
   - Select `Doorstep Pickup` on a delivered order, verify available time windows load from `/api/pickups/resources?includeSlots=true`, submit return, and inspect Customer Orders & Deposit Payments AG Grid tables.

