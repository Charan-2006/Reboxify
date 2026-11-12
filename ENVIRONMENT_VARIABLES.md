# ReBoxify Environment Variables Specification

> **Security Rule (Blueprint Sec 14.3, 20.1 & Page 25):**  
> Secrets MUST NEVER be committed to Git (even on feature branches) and MUST NEVER be injected into frontend Vite builds (`vite.config.ts` `define` or `VITE_*` prefixes for secrets). Only public configuration (`VITE_API_BASE_URL`, public `PAYPAL_CLIENT_ID`) is exposed to the browser.

---

## 1. Existing Repository Findings
- **Missing `.gitignore` rules:** Current `.gitignore` only ignores `*.local`, NOT `.env` or `.env.*`. On remote branch `origin/ashwin` (commit `c9c41ca`), `.env` was committed to Git history. **Action required in Phase 2:** Add `.env`, `.env.*`, and `!.env.example` to `.gitignore`.
- **Exposed secret pattern in `vite.config.ts`:** Lines 14–15 currently inject `process.env.GEMINI_API_KEY` and `process.env.API_KEY` into the frontend bundle. **Action required in Phase 2:** Remove both `define` entries completely; move Gemini calls exclusively to the Express backend.

---

## 2. Backend Web Service & Background Worker Variables (Render Env Vars)

| Variable | Exposure | Required | Example / Format | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `NODE_ENV` | Config | Yes | `production` / `development` | Runtime mode & secure cookie behavior |
| `PORT` | Config | Yes | `10000` (Render sets automatically) | HTTP bind port for Express API |
| `APP_BASE_URL` | Config | Yes | `https://api-reboxify.onrender.com` | Backend public HTTPS origin (QR links, PayPal redirects) |
| `CORS_ORIGIN` | Config | Yes | `https://reboxify.onrender.com` | Allowed frontend Static Site origin(s) |
| `MONGODB_URI` | **Secret (Backend/Worker)** | Yes | `mongodb+srv://...` | MongoDB Atlas replica-set connection string |
| `JWT_SECRET` | **Secret (Backend)** | Yes | `64-char-random-hex` | Signing JWT / session tokens |
| `SESSION_SECRET` | **Secret (Backend)** | If cookie sessions | `64-char-random-hex` | Cookie/session signing secret |
| `QR_SIGNING_SECRET` | **Secret (Backend)** | Yes | `64-char-random-hex` | Primary HMAC signing secret for `RBXQR:v1` passport & scan tokens |
| `QR_KEY_ID` | Config | Optional | `k1` | Key identifier (`kid`) embedded in newly signed QR tokens for key rotation |
| `QR_PREVIOUS_KEY_ID` | Config | Optional | `k0` | Retired/previous `kid` accepted during zero-downtime key rotation |
| `QR_PREVIOUS_SIGNING_SECRET` | **Secret (Backend)** | Optional | `64-char-random-hex` | Previous HMAC signing secret verified during key rotation window |
| `QR_TOKEN_TTL_SECONDS` | Config | Optional | `31536000` | Signed QR token expiration TTL in seconds (min `60`) |
| `PAYPAL_ENV` | Config | Yes | `sandbox` | Enforces Sandbox base URL (`api-m.sandbox.paypal.com`) |
| `PAYPAL_CLIENT_ID` | Public / Config | Yes | `A...` | PayPal Developer Sandbox REST App Client ID |
| `PAYPAL_CLIENT_SECRET` | **Secret (Backend/Worker)** | Yes | `E...` | PayPal REST App Secret (OAuth token + capture + refund) |
| `PAYPAL_WEBHOOK_ID` | **Secret (Backend)** | Yes | `WH-...` | Webhook ID from PayPal Developer Dashboard for signature verification |
| `DEFAULT_CURRENCY` | Config | Yes | `USD` or `INR` *(confirm)* | Checkout/refund currency for Sandbox demo |
| `GEMINI_API_KEY` | **Secret (Backend)** | Yes | `AIza...` | Google Gemini API key (`@google/genai`) |
| `GEMINI_MODEL` | Config | Yes | `gemini-2.5-flash` | Configurable Gemini model ID (changeable without code edits) |
| `ELASTICSEARCH_URL` | **Secret/Config (Backend/Worker)** | Yes | `https://...:443` | Managed Elasticsearch endpoint over TLS |
| `ELASTICSEARCH_API_KEY` | **Secret (Backend/Worker)** | Yes* | `base64-api-key` | Elasticsearch API key (*or `ELASTICSEARCH_USERNAME` + `ELASTICSEARCH_PASSWORD`) |
| `RECONCILE_INTERVAL_MS` | Config | Optional | `60000` | Worker interval for PayPal pending payment/refund checks |
| `OUTBOX_POLL_INTERVAL_MS` | Config | Optional | `5000` | Worker interval for `searchOutbox` -> Elasticsearch indexing |
| `PENDING_RECONCILE_MIN_AGE_MS` | Config | Optional | `120000` | Age threshold before worker reconciles pending PayPal transactions |

---

## 3. Frontend Static Site Variables (Vite Build-Time Public Env Vars)

| Variable | Exposure | Required | Example / Format | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `VITE_API_BASE_URL` | Public (Browser) | Yes | `https://api-reboxify.onrender.com` | Base URL for Express REST API calls |
| `VITE_PAYPAL_CLIENT_ID` | Public (Browser) | Yes | `A...` | Public PayPal Client ID passed to `@paypal/react-paypal-js` (same ID as `PAYPAL_CLIENT_ID`, or fetched via `/api/config/public`) |
| `VITE_APP_CURRENCY` | Public (Browser) | Yes | `USD` or `INR` *(confirm)* | Display currency matching backend checkout configuration |
| `VITE_AG_GRID_LICENSE_KEY` | Public (Browser) | Optional | *(Only if using AG Grid Enterprise)* | Not required if using AG Grid Community Edition |
| `VITE_BRYNTUM_TRIAL_OR_LICENSE` | Build/Config | Conditional | *(See Technical Decisions)* | Bryntum npm registry auth token (`.npmrc`, never commit!) if using Bryntum package |

---

## 4. `.env.example` Template Strategy
`backend/.env.example` and `frontend/.env.example` provide placeholder keys only (zero real credentials), and root `.gitignore` ignores all `.env` files. In Phase 5, `PAYPAL_WEBHOOK_ID` enables PayPal cryptographic signature verification on `POST /api/webhooks/paypal`, and `PENDING_RECONCILE_MIN_AGE_MS` governs pending PayPal order/refund reconciliation thresholds.

