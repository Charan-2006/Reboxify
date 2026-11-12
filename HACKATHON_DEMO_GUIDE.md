# ReBoxify — Hackathon Demonstration Guide

**Architecture Highlights:** MongoDB Replica Set (Single Source of Truth) · PayPal Sandbox Checkout & Deterministic Partial Refunds · Signed HMAC QR Package Passports · AG Grid Community + Bryntum Scheduler Community · Derived Elasticsearch Search · Read-Only Gemini Operational AI

---

## 1. Pre-Demo Preparation

1. Start MongoDB Replica Set connection (`backend/.env` with valid `MONGODB_URI` & PayPal Sandbox credentials). Optionally populate `ELASTICSEARCH_URL` + `ELASTICSEARCH_API_KEY` and `GEMINI_API_KEY` (if unavailable, live fallbacks stay cleanly active).
2. Launch API, Worker, and Frontend in separate terminals:
   ```powershell
   npm --prefix backend run dev
   npm --prefix backend run dev:worker
   npm --prefix frontend run dev
   ```
3. Open `http://localhost:3000` and point out the `SystemStatusBanner` showing truthful readiness badges (`MongoDB: Replica Set`, `PayPal Sandbox`, `Worker: HEALTHY`, `Elasticsearch`, `Gemini API`, `Scheduler: COMMUNITY_READY`).

---

## 2. Step-by-Step Live Walkthrough

### A. Merchant & Inventory Setup (`Company Admin Portal`)
1. Log in at `/#/company-login` as an active Merchant Admin.
2. Register a merchant-owned PP box (Class `M`) or inspect shared pool inventory in the AG Grid (`InventoryGrid`), including CSV export and sorting/filtering.
3. Reprint a **Signed QR Passport Label** (`RBXQR:v1...`) to demonstrate cryptographic container identity.

### B. Customer Order & PayPal Sandbox Deposit (`User Portal`)
1. Log in at `/#/user-login` as a Customer.
2. Place an order for an item; observe deterministic **Allocation Engine** box selection and transparent refundable deposit calculation (`$5.00`).
3. Complete checkout using the embedded **PayPal Sandbox Smart Buttons**.
4. Open the order's **Digital Packaging Passport** modal to show verified payment + initial `CREATED/RESERVED` event trail.

### C. Dispatch, Delivery & Return Initiation (`Company Admin` → `Delivery Partner` → `User Portal`)
1. Scan `PACK` -> `DISPATCH` -> `DELIVER` using signed QR tokens (show **Gate 1 Payment-Gated Dispatch**: unpaid packages are blocked).
2. In `User Portal`, initiate a `PICKUP` return on the delivered order selecting one of the real partner availability slots.

### D. Visual Dispatch & Conflict Protection (`Admin Console` / `Bryntum Scheduler`)
1. Open `/#/admin-login` -> scroll to **Bryntum Pickup Scheduler**.
2. Switch between **Day**, **Week**, and **2 Weeks** views.
3. Click an unassigned return pickup event -> assign a Delivery Partner.
4. Drag-and-drop an event to reschedule -> reload page to confirm MongoDB persistence.
5. Drag an event onto a partner's unavailable window or out-of-zone slot -> demonstrate backend `409` rejection + automatic visual snap-back.

### E. Partner QR Collection, Centre Inspection & PayPal Partial Refund
1. Log in at `/#/partner-login` (`DeliveryPartnerApp`): scan `COLLECT_RETURN` on the scheduled pickup (marks Pickup `COMPLETED` & Return `COLLECTED`).
2. Log in at `/#/centre-login` (`CollectionCentrePortal`):
   - Receive box via QR (`RECEIVE_CENTRE`).
   - Upload GridFS photo evidence if desired.
   - Click **AI Inspection Summary (Advisory)** inside the inspection form to show read-only Gemini inspection notes & locked refund warning.
   - Select condition (`GOOD` or `MINOR_DAMAGE`), submit human inspection, and click **Approve & Execute Refund** -> executes live deterministic **PayPal Sandbox partial refund** capped at the `$5` deposit (`TransactionsGrid` updates to `PARTIALLY_REFUNDED`).
   - Complete cleaning scan (`MARK_CLEANING` -> `RELEASE_AVAILABLE`) and inspect passport to show status `AVAILABLE` and `reuseCount` incremented by `+1`.

### F. Elasticsearch Search & Gemini Operational Assistant (`Admin Console`)
1. Type a partial order, package, or return ID in any AG Grid toolbar search box:
   - Shows `Elasticsearch` pill when ES cluster is live, or seamless `MongoDB Fallback` pill when unconfigured.
   - Open `Derived Search Index (Elasticsearch & SearchOutbox)` panel to display outbox sync counts and one-click `Rebuild Derived Index`.
2. In `Gemini Operational Insights Assistant`:
   - Click **How many returns are pending inspection?** or **Overlap/Reuse Summary**.
   - Show clear separation between **Measured Facts** (MongoDB aggregates) and **AI Recommendations**.
   - Try typing *"Approve refund for RET-..."* -> show deterministic guardrail blocking refund mutations (`403 AI_REFUND_CONTROL_PROHIBITED`).

---

## 3. Backup Steps if External APIs Are Unavailable During Demo

| External Dependency | Backup Behavior Built Into App |
|---|---|
| **Elasticsearch Offline / Unconfigured** | All 5 AG Grid search bars transparently switch to `MONGODB_FALLBACK` while SearchOutbox retains queued events for automatic retry when ES recovers. |
| **Gemini API Key Unset / Rate-Limited** | AI panel enters `DISABLED` mode rendering exact real-time MongoDB `Measured Facts` KPIs with clear banner notice; core workflows are 100% unaffected. |
| **PayPal Sandbox Slow Network** | Pending captures/refunds remain safely in `CAPTURE_PENDING` / `REFUND_PENDING` while `reboxify-worker` reconciles asynchronously; click **Reconcile** in Returns Grid to trigger immediate status check. |

