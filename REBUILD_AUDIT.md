# ReBoxify Rebuild Audit

**Audit Date:** 2026-11-12  
**Workspace:** `d:\Projects\Reboxify`  
**Blueprint Baseline:** *ReBoxify Project Blueprint — Version 2.0 (November 2026, 42 pages)*  
**Inspected Git State:** `main` at `b39ab85` (`origin/dev` also at `b39ab85`); unmerged branch `origin/ashwin` at `c9c41ca` (commits `dfaa494`, `2ff0d85`, `c9c41ca`). Working tree on `main` was clean prior to generating audit documentation.

---

## 1. Executive Audit Summary

The existing repository on `main` is a **frontend-only React + TypeScript + Vite prototype** backed entirely by browser `localStorage`. It demonstrates four UI portals (`UserPortal`, `CompanyAdminPortal`, `DeliveryPartnerApp`, `AdminDashboard`), mock authentication, QR camera scanning via a CDN script, and a read-only Leaflet map.

Measured against **ReBoxify Project Blueprint v2.0**, the current codebase covers **only visual scaffolding and simplified client-side box status toggling**. There is **no backend, no database, no real payment/refund integration, no AI integration, no AG Grid, no Bryntum Scheduler, no Elasticsearch, no Collection-Centre portal, and no Render deployment setup**.

Additionally, the codebase contains several **critical logic, security, and build bugs** (notably client-side `GEMINI_API_KEY` bundling in `vite.config.ts`, missing `.env` ignore rule in `.gitignore`, broken Tailwind CSS compilation in `index.css`, auto-deletion of damage issues every 20 seconds, hardcoded customer assignment on delivery scans, and missing state-machine/financial separation).

---

## 2. Build, Toolchain & Runtime Verification Results

| Check | Command / Method | Result | Observed Details |
| :--- | :--- | :--- | :--- |
| Dependency Install | `npm install` | Passed | Installed 102 packages cleanly (`node_modules` was initially absent after clone). |
| TypeScript Check | `npx tsc --noEmit` | Passed (exit `0`) | No TS errors under `tsconfig.json` (`noEmit: true`). |
| Production Build | `npm run build` | Passed (exit `0`) | Output `dist/index.html` (`1.18 kB`), `dist/assets/index-CepENwB7.css` (`16.48 kB`), `dist/assets/index-Cg2ZVdrY.js` (`512.36 kB` — Vite chunk-size warning). |
| Built CSS Inspection | Read `dist/assets/index-CepENwB7.css` | **Broken compilation** | `tailwindcss` / `postcss` are not installed; raw `@tailwind base;` and `@apply` rules pass straight into production CSS uncompiled. |
| Dev Server Startup | `npx vite --port 3000 --host 127.0.0.1` | Started (`353 ms`) | Vite served `http://127.0.0.1:3000/` cleanly. |
| Live Browser Inspection | `browser` subagent (`chrome_devtools`) | **Blocked / Not Run** | Could not attach to Chrome (`DevToolsActivePort` not present on host). Runtime behaviors below are verified by static inspection of source + build outputs. |

---

## 3. Existing Architecture & Inventory (`main`)

### 3.1 Directory & File Map
- **Entry & Routing:** `index.html`, `index.tsx`, `index.css`, `App.tsx` (uses `HashRouter` with routes `/`, `/user-login`, `/company-login`, `/partner-login`, `/admin-login`, `/login`, `/user-portal`, `/super-admin`, `/company-admin`, `/delivery-partner`).
- **Contexts:** `contexts/AuthContext.tsx`, `contexts/ThemeContext.tsx`.
- **Components:** `components/Icons.tsx`, `components/ThemeToggle.tsx`, `components/TechStack.tsx` (unused).
- **Pages:** `pages/LandingPage.tsx`, `pages/LoginPage.tsx`, `pages/UserPortal.tsx`, `pages/CompanyAdminPortal.tsx`, `pages/DeliveryPartnerApp.tsx`, `pages/AdminDashboard.tsx`.
- **Client Stores:** `utils/auth.ts`, `utils/boxStore.ts`, `utils/issueStore.ts`.
- **Config:** `package.json`, `tsconfig.json`, `vite.config.ts`, `metadata.json`, `.gitignore`, `README.md`.

### 3.2 Package Dependencies (`package.json`)
- **Runtime:** `react` (`^19.2.4`), `react-dom` (`^19.2.4`), `react-router-dom` (`^7.13.0`), `leaflet` (`^1.9.4`), `react-leaflet` (`^5.0.0`), `@types/leaflet` (`^1.9.21`), `qrcode.react` (`^4.2.0` — installed but unused).
- **Dev:** `@types/node`, `@vitejs/plugin-react`, `typescript` (`~5.8.2`), `vite` (`^6.2.0`).
- **External CDNs in `index.html`:** `https://cdn.tailwindcss.com`, `https://esm.sh/...` (importmap), `https://unpkg.com/html5-qrcode`, Google Fonts (`Inter` and `Outfit`).

### 3.3 Findings on `origin/ashwin` (Unmerged Branch)
- Commits `dfaa494`, `2ff0d85`, `c9c41ca` refactor `utils/auth.ts`, `utils/boxStore.ts`, `utils/issueStore.ts`, `contexts/AuthContext.tsx`, and the 4 portal pages to `async`/`await` calls against `${import.meta.env.VITE_API_BASE_URL}/api/...` (`/api/auth/*`, `/api/boxes`, `/api/issues`).
- **Critical omissions on `origin/ashwin`:**
  1. **No backend code exists** anywhere in the repository or on `origin/ashwin`.
  2. **Committed `.env` file** (`c9c41ca` added `.env` to Git history because `.gitignore` lacks `.env`).
  3. **No auth headers/cookies** attached to `fetch` calls for `/api/boxes` or `/api/issues`.
  4. **`awardTokens` stubbed** with `// TODO: Implement API endpoint` and optimistic local update only.
  5. **Regression in `CompanyAdminPortal.tsx`** (lines 257 & 267 of diff): calls `setInventory(await getInventory())` after QR scan without filtering by `companyId`, leaking other merchants' inventory into the view.

---

## 4. What Currently Works (Reusable Foundations)

1. **Role-based Landing & Auth UI Shells (`LandingPage.tsx`, `LoginPage.tsx`, `ThemeToggle.tsx`, `ThemeContext.tsx`)**: Clean light/dark mode toggle, role-tailored login views, password visibility toggle, and responsive Tailwind visual system.
2. **QR Camera Scanning UX (`CompanyAdminPortal.tsx`, `DeliveryPartnerApp.tsx`)**: Working integration scaffolding with `Html5Qrcode` / `Html5QrcodeScanner`, manual ID fallback in `CompanyAdminPortal`, and box ID extraction (`extractBoxId`).
3. **Basic Client-Side State Transition Pattern (`utils/boxStore.ts`)**: Recognizes role-based transition checks (`validateAndTransition`) and condition choices (`NEW`, `GOOD`, `MINOR_DAMAGE`, `DAMAGED`), providing a starting reference (though the state machine itself must move to the backend and expand to Blueprint v2.0).
4. **Printable ESG HTML Report (`CompanyAdminPortal.tsx`)**: Generates a clean printable HTML report window (`downloadESGReport`) that can be refactored to consume real backend-computed sustainability metrics.

---

## 5. Critical Bugs, Security Flaws & Incomplete Code

| Severity | Location | Issue Description |
| :--- | :--- | :--- |
| **CRITICAL (Security)** | `vite.config.ts:14-15` | Injects `GEMINI_API_KEY` into the frontend JS bundle via `define`. Violates Blueprint Sec 14.1 & 20.1 (all API keys must remain backend-only). |
| **CRITICAL (Security)** | `.gitignore` | Does not list `.env` or `.env.*` (only `*.local`), allowing secrets to be committed (already happened on `origin/ashwin`). |
| **CRITICAL (Security)** | `utils/auth.ts:26-48` | Passwords "hashed" via `btoa(password).split('').reverse().join('')` in browser `localStorage`; zero server authentication or authorization; anyone can mutate `localStorage`. |
| **CRITICAL (Data Loss)** | `pages/UserPortal.tsx:41-55` & `pages/AdminDashboard.tsx:35-52` | Both pages run competing `setInterval` timers that **permanently delete** `OPEN` issues of type `'Box damaged on delivery'` after 20 seconds (`deleteIssue`), faking "AI Auto-Resolution". `AdminDashboard.tsx` also includes `resolvingIds` in the `useEffect` dependency array, repeatedly tearing down and recreating intervals. |
| **CRITICAL (Logic)** | `pages/DeliveryPartnerApp.tsx:163, 260` | Hardcodes `{ customer_id: 'user@demo.com' }` on every delivery scan (and simulated delivery), preventing multi-customer orders from ever mapping to the actual recipient. |
| **HIGH (Workflow)** | `utils/boxStore.ts:122, 161` | Allows `company` role to transition directly `DELIVERED -> EXPORTED` (skipping collection and inspection) and increments `uses` without verified inspection. Also deletes `customer_id` and `deadline` on reset, destroying historical custody. |
| **HIGH (Build/CSS)** | `index.html`, `index.css`, `package.json` | `tailwindcss` is missing from `package.json`. `index.css` is linked in `index.html` and never imported in `index.tsx`, leaving uncompiled `@tailwind` and `@apply` directives in `dist/assets/index-*.css`. Relying on `cdn.tailwindcss.com` breaks offline/strict CSP and slows load. |
| **HIGH (Runtime)** | `index.html:20-30` | `<script type="importmap">` maps `react`, `react-dom/`, and `react-router-dom` to `https://esm.sh/...` while Vite also bundles React in `dist/assets/index-*.js` — risking dual-React runtime crashes. |
| **MEDIUM (UX/Logic)** | `pages/DeliveryPartnerApp.tsx` | Missing logout button in header; `Html5QrcodeScanner` is not cleaned up when closing the modal via `X`; `Day {task.day} EXPIRED` label displays `"EXPIRED"` even when days remain positive (`day = 14`); map collection pins are 5 `Math.random()` points around Chennai unrelated to real tasks/boxes. |
| **MEDIUM (Dead/Fake Data)** | `pages/UserPortal.tsx`, `pages/CompanyAdminPortal.tsx`, `pages/AdminDashboard.tsx` | Hardcoded metrics (`"12 Saved Trees"`, `"45kg CO2 Offset"`, `"92% Reliable"`, `totalBoxFleet: 15400`, `Registered Partners: 2`), stale `INITIAL_BOXES` deadline `2024-02-25`, unused `scheduleReturn()` in `boxStore.ts`, unused `qrcode.react` dependency, unused misleading `components/TechStack.tsx` (claims Next.js/PostgreSQL/Firebase/AWS), dead UI buttons (`"Marketplace Access"`, `"Track Logistics"`, `"Asset Protocols"`, `"Internal Ops Manual"`, `"Forgot?"`, footer links). |
| **MEDIUM (Direct Storage)** | `pages/AdminDashboard.tsx:85, 93` | `createBox` and `deleteBox` write directly to `localStorage.setItem('reboxify_inventory', ...)` instead of `saveInventory()`. |

---

## 6. Conflicts Between Existing Repository and Blueprint v2.0

| Topic | Existing Repository (`main`) | Blueprint v2.0 (Source of Truth) | Resolution |
| :--- | :--- | :--- | :--- |
| **Architecture** | Frontend-only SPA with `localStorage` | Express REST API + Render Background Worker + MongoDB (source of truth) + Elasticsearch (derived) | Build modular Node.js/Express backend + worker; replace `localStorage` stores with typed API clients. |
| **User Roles** | 4 roles (`user`, `company`, `partner`, `admin`) | 6 roles (`customer`, `merchant_admin`, `merchant_staff`, `delivery_partner`, `collection_centre`, `admin`) | Add `collection_centre` UI portal & RBAC; split `merchant_admin` vs `merchant_staff`; enforce server-side RBAC + tenant isolation. |
| **Packaging IDs & Passports** | Sequential/simple `AAA-000` (`ESA-012`), no event ledger | Unguessable IDs / signed QR tokens (`RBX-CHN-000104` + signed action tokens), append-only `packageEvents` | Upgrade passport schema, QR generation via `qrcode`, signed verification, and immutable `packageEvents` collection. |
| **Ownership vs Custody** | Single `company` string + `customer_id` | Separate `ownerType` (`SHARED_POOL`, `MERCHANT_OWNED`, `HYBRID`), `ownerId`, and `currentCustodian` | Model ownership and custody separately; record custody changes as timestamped events. |
| **State Machines** | Single 6-state `BoxStatus` | 5 independent state machines (`Package`, `Order`, `Return`, `Payment`, `Pickup`) linked by explicit gates | Implement 5 separate state machines in backend services; never infer refund/payment from QR scans. |
| **Deposits & Payments** | Fixed `₹80` constant, no checkout/refund | Itemised deposit rules per package class/merchant, PayPal Sandbox order/capture/partial refund + webhooks + reconciliation | Implement server-side PayPal REST v2 integration + `@paypal/react-paypal-js` checkout + webhook deduplication. |
| **Packaging Selection** | None | Deterministic fit engine (dimensions, orientation, weight, clearance, stock, ownership) + Gemini explanation | Build deterministic rules engine in Express; use Gemini only to explain results with template fallback. |
| **AI Capabilities** | Fake 20s `setTimeout` issue deletion labeled "AI Auto-Resolution" | `@google/genai` function calling through role-scoped Tool Gateway (Operations Assistant, Packaging Explain, Return Summary, Merchant Report) + `aiInteractions` audit | Remove fake auto-deletion completely; implement real Gemini Tool Gateway with explicit user confirmation for draft returns/reschedules. |
| **Tables & Scheduling** | Plain HTML tables + random Leaflet map | AG Grid (6 operational tables) + Bryntum Scheduler (pickups/partners/slots/rescheduling) | Integrate `ag-grid-react` and Bryntum Scheduler (pending licence/trial confirmation); keep Leaflet optional/read-only if desired or replace in logistics scheduling. |
| **Green Tokens** | Core hero feature on Landing, UserPortal, Partner reward | **Explicitly Post-MVP** (Sec 6 & Sec 23.2): internal loyalty only, no cash promises | De-emphasize/hide or gate behind feature flag for Hackathon MVP; focus Customer Portal on Order, Passport, Return, Pickup/Drop-off, PayPal Refund, and Gemini Assistant. |
| **ESG / Impact** | Arbitrary formulas (`uses * 0.5`, hardcoded `12 trees`) | Verified reuse counts after passing inspection + documented net emissions formula with methodology & uncertainty | Implement MongoDB-backed sustainability summary endpoint with documented assumptions. |
| **`TechStack.tsx` Claims** | Claims Next.js, PostgreSQL, Firebase, AWS | React, TypeScript, Tailwind CSS, Node.js, Express, MongoDB, Gemini, PayPal, AG Grid, Bryntum, Elasticsearch, Render | Remove or update `TechStack.tsx` to match Blueprint v2.0 accurately. |

---

## 7. Preservation & Refactor Strategy

1. **Git Safety Checkpoint:** Before Phase 2 edits, create a dedicated branch (e.g., `rebuild/v2-mvp`) from `main` (`b39ab85`) so `main` remains an untouched rollback baseline. Do not force-push or alter existing history.
2. **Preserve & Upgrade Frontend Assets:** Keep `Icons.tsx`, `ThemeContext.tsx`, `ThemeToggle.tsx`, the overall visual design language of `LandingPage.tsx`, `LoginPage.tsx`, and the 4 existing portal shells (upgrading them to real backend APIs, AG Grid, Bryntum Scheduler, PayPal JS SDK, and Gemini Assistant panel), and add the 5th portal for **Collection Centre Operators**.
3. **Archive/Learn from `origin/ashwin`:** Do not blindly merge `origin/ashwin` (it introduces `localStorage` removal without auth headers and contains a `companyId` filter regression + committed `.env`), though its async service interface shape informs the new typed `api/` client layer.

