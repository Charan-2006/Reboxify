# ReBoxify Technical Decisions & Conflicts Log

This document records architectural decisions, licensing considerations, and conflicts between the existing repository and **ReBoxify Project Blueprint — Version 2.0**, including items requiring user confirmation before Phase 2 implementation.

---

## 1. Resolved Blueprint Overrides (Authoritative Decisions)

| Decision Area | Existing Repo Behavior | Blueprint v2.0 Decision |
| :--- | :--- | :--- |
| **Tech Stack Truth** | Unused `components/TechStack.tsx` lists Next.js, PostgreSQL, Firebase, AWS. | Primary stack is **React + TypeScript + Tailwind CSS**, **Node.js + Express.js**, **MongoDB + Mongoose**, **PayPal Sandbox**, **Google Gemini API (`@google/genai`)**, **AG Grid**, **Bryntum Scheduler**, **Elasticsearch**, **Render**. No Python, ML, CV, or blockchain. |
| **Source of Truth** | Browser `localStorage` | **MongoDB** (replica set for multi-document transactions). **Elasticsearch** is strictly derived via `searchOutbox` and rebuildable. |
| **State Machines** | Single 6-state `BoxStatus` (`CREATED..RETIRED`) | **5 independent state machines**: Package (14 states), Order (7 states), Return (9 states), Payment (12 states incl. failure/dispute), Pickup (7 states). Physical custody and payment status are decoupled and linked by gates. |
| **Ownership vs Custody** | Single `company` string & overwritten `customer_id` | Separate `ownerType` (`SHARED_POOL`, `MERCHANT_OWNED`, `HYBRID`), `ownerId`, and active `currentCustodian`, with append-only `packageEvents`. |
| **QR Identity & Security** | Predictable `AAA-000` (`ESA-012`), plain URL matching | Unguessable identifiers (`RBX-CHN-000104` + cryptographic/HMAC token), zero PII in QR payloads, backend role/assignment validation, replay rejection, operator-verified reprint. |
| **AI Boundary** | Fake 20s `setTimeout` issue deletion in `UserPortal`/`AdminDashboard`; `GEMINI_API_KEY` exposed in `vite.config.ts` | Gemini lives strictly in the Express **AI Integration Service** via role-scoped **Tool Gateway**. Gemini explains, summarizes, and drafts proposals (user must confirm). Financial, eligibility, fit, and inspection decisions remain 100% deterministic backend rules. |
| **Green Tokens** | Prominent across Landing, UserPortal, and Partner reward | Explicitly **Post-MVP** (Sec 6 & Sec 23.2). MVP prioritizes PayPal refundable deposits and verified returns; `greenWallets` schema may be reserved without promising cash-equivalent rewards. |
| **Marketplace Integrations** | Hardcoded `MNC-AMZ` / `MNC-FLK` demo entities | Phase 1 uses the ReBoxify storefront & API. Shopify/WooCommerce/Amazon/Flipkart/ERP are **Post-MVP**, with explicit documentation that Seller APIs cannot arbitrarily modify third-party marketplace checkout/payment/deposit flows. |
| **Tailwind & Vite Build** | `cdn.tailwindcss.com` + broken uncompiled `index.css` + `esm.sh` importmap | Install `tailwindcss` + `postcss` + `autoprefixer` locally; remove CDN Tailwind and `importmap` to prevent duplicate-React and unstyled production builds. |
| **Evidence Photo Storage & Refund Rules** | Dead `proofImageUrl` string on client `issueStore` with 20s deletion timer | Store validated evidence images (`JPEG`/`PNG`/`WebP`, 5 MB limit with magic-byte checks) privately in MongoDB GridFS (`returnEvidence`) served via RBAC-checked authenticated endpoints (`GET /api/returns/:id/evidence/:fileId`); compute partial/full/zero refunds strictly server-side (`REBOXIFY_REFUND_RULES_V2`) rejecting client refund amounts and separating customer/inspector/approver roles where enforced. |

---

## 2. Decisions Requiring User Confirmation Before Phase 2

### TD-1: PayPal Sandbox Currency (`USD` vs `INR`)
- **Context:** Blueprint Section 6.2 & 8.2 show illustrative amounts in INR (`₹1,000` product, `₹100` deposit, `₹8–₹30` usage fees), while Page 8 notes *"Currency for the Sandbox demonstration is a configuration setting"* and Page 17 warns about PayPal India domestic restrictions. Furthermore, PayPal Sandbox REST API frequently rejects `INR` on non-India-domestic Sandbox accounts or cross-border test setups, whereas `USD` works out of the box across almost all PayPal Sandbox buyer/seller test accounts.
- **Options:**
  1. **(Recommended for Hackathon Reliability)** Use `USD` for PayPal Sandbox API transactions (e.g., `$12.00` product + `$2.00` refundable deposit, or configurable display).
  2. Use `INR` if your PayPal Sandbox Business & Buyer accounts are verified India Sandbox accounts supporting INR.
- **Why confirmation matters:** Affects seeded prices, deposit rules, PayPal JS SDK currency param, and PayPal checkout testing.

### TD-2: Bryntum Scheduler Licensing / Trial Access
- **Context:** Blueprint Section 13 & 18 require **Bryntum Scheduler** (`@bryntum/scheduler-react`). Page 22 & 30 explicitly note: *"Confirm Bryntum licence or trial terms for the build."* Bryntum packages live on Bryntum's private npm registry (`https://npm.bryntum.com`) and require either a commercial licence or a free 45-day trial npm token (`.npmrc`) to install.
- **Options:**
  1. You have / will register a Bryntum 45-day trial npm login or commercial licence so we can install official `@bryntum/scheduler` & `@bryntum/scheduler-react`.
  2. If Bryntum registry access is unavailable right now, build the full `/api/pickups` scheduling backend + Bryntum-compatible timeline adapter component (or use Bryntum trial CDN/zip if provided) and swap in the Bryntum widget once credentials are configured.
- **Why confirmation matters:** Cannot run `npm install @bryntum/scheduler-react` without knowing whether you have a Bryntum trial/licence token.

### TD-3: AG Grid Edition (Community vs Enterprise)
- **Context:** Blueprint Section 17 explicitly notes: *"the MVP is designed around features suitable for the community edition. Features such as server-side row model, row grouping or Excel export may require an enterprise licence and should be confirmed before use."*
- **Options:**
  1. **(Recommended)** Use **AG Grid Community** (`ag-grid-react` + `ag-grid-community`) with server-paginated/filtered/sorted Express endpoints driving page requests + built-in Community CSV export. Zero licence cost/watermark.
  2. Use AG Grid Enterprise if you have a commercial licence key.

### TD-4: Managed MongoDB, Elasticsearch & Render Accounts
- **Context:** Blueprint Section 14.3 & 15.3 require a MongoDB **replica-set** deployment (for multi-document financial/outbox transactions, e.g., MongoDB Atlas free M0 supports replica-set transactions) and a Render-reachable TLS **Elasticsearch** deployment (Elastic Cloud free trial, Bonsai, Aiven, etc.), plus **Render** account.
- **Need to know:** Which managed services/accounts do you already have vs want us to support via Docker Compose locally + Render Blueprint (`render.yaml`) for deployment?

### TD-5: Authentication Transport (Cross-Origin Render Static Site + Web Service)
- **Context:** On Render, the React Static Site and Express Web Service run on different subdomains (`*.onrender.com`), which makes cross-site `SameSite=Lax` HTTP-only cookies fail unless custom domains or a same-origin proxy/rewrite are used (`SameSite=None; Secure` works over HTTPS, or `Authorization: Bearer <JWT>` works consistently both locally and across subdomains).
- **Options:**
  1. **(Recommended for Render Static Site + Web Service)** Short-lived JWT via `Authorization: Bearer` header (or Render rewrite proxy + HTTP-only `SameSite=None; Secure` cookies). Wait: Blueprint Sec 20.1 says *"sessions or tokens (secure, HTTP-only cookies where applicable)"* — using Render rewrite rules or `SameSite=None; Secure` cookies vs Bearer token is a clean architectural choice to confirm.

### TD-6: Handling Existing `origin/ashwin` & `Leaflet` Map
- **Context:**
  - `origin/ashwin` has unmerged commits (`dfaa494`..`c9c41ca`) targeting an external `VITE_API_BASE_URL` (and committed `.env`).
  - `DeliveryPartnerApp.tsx` currently includes `leaflet` / `react-leaflet` showing 5 random pins around Chennai.
- **Recommendation:** Branch Phase 2 off `main` (`rebuild/v2-mvp`), discard `origin/ashwin`'s committed `.env` and buggy `companyId` scan regression, keep `DeliveryPartnerApp`'s Leaflet map only if backed by real assigned pickup coordinates (or replace map noise with clean assigned pickup slot cards + real pickup actions while Bryntum Scheduler handles operator scheduling).

