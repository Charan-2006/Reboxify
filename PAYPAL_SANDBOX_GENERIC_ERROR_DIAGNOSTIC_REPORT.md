# ReBoxify — PayPal Sandbox `checkoutweb/genericError` Diagnostic Report

**Branch:** `rebuild/v2-mvp`  
**Scope:** Investigation of `https://www.sandbox.paypal.com/checkoutweb/genericError` ("Things don't appear to be working at the moment.") observed during Customer Portal Sandbox checkout.

---

## 1. Confirmed Root Causes & Unresolved Possibilities (Clearly Distinguished)

### A. Confirmed Code Defect Affecting Repeat Attempts (Fixed)
- **Root Cause Found in [PayPalOrderCheckout.tsx](file:///d:/Projects/Reboxify/frontend/src/components/PayPalOrderCheckout.tsx#L179-L182):**
  - `createOrder` previously passed a static `Idempotency-Key` (`ui-create-${order.id}`) to `POST /api/payments/paypal/create-order`.
  - MongoDB Atlas `idempotencyKeys` confirmed that Attempt #1 on `ORD-MWDJGVRW-A094` cached `{ paypalOrderId: "45R10666DE347542C" }` under key `paypal-create-order:6af5ac99c20f69ce15247758:ui-create-6af5b46d9bc17eb3253be250` with a 24-hour TTL.
  - When that checkout hit `/checkoutweb/genericError` and cancelled, `45R10666DE347542C` transitioned cleanly to **`CAPTURE_FAILED` (`CANCELLED_BY_CUSTOMER`)**.
  - However, every subsequent click on the PayPal button on `ORD-MWDJGVRW-A094` re-sent `ui-create-${order.id}`, causing `requireIdempotency` middleware (`paymentRoutes.ts:49`) to replay the **already-cancelled/failed `45R10666DE347542C`** before `PaymentService.createPayPalOrder` could create a fresh PayPal order (`findActiveByOrderId` intentionally excludes `CAPTURE_FAILED`).
- **Fix Applied ([PayPalOrderCheckout.tsx](file:///d:/Projects/Reboxify/frontend/src/components/PayPalOrderCheckout.tsx)):**
  - Replaced the static key with a per-attempt `createAttemptKeyRef` that resets on `onCancel`, `onError`, `onApprove`, and whenever `transaction?.state === 'CAPTURE_FAILED'`, plus added `components: 'buttons'` explicitly to `PayPalScriptProvider` options.

### B. Eliminated Causes (Verified Healthy Against Live PayPal Sandbox)
- **OAuth & App Environment:** `POST https://api-m.sandbox.paypal.com/v1/oauth2/token` returns `200 OK` (`Bearer`, `expires_in: 32400`, `app_id: APP-5VP99870G5749381H`, 29 scopes). Backend and frontend both target `sandbox` + `USD`.
- **Order Creation Payload (`RestPayPalClient.createOrder`):** Verified directly via `GET /v2/checkout/orders/45R10666DE347542C` and `GET /v2/checkout/orders/2M70946580205230E`:
  - `intent: "CAPTURE"`, `status: "CREATED"`
  - `amount.value: "30.00"` === `item_total ("30.00") + shipping ("0.00") + tax_total ("0.00")` (`USD`)
  - Valid `reference_id` and `custom_id` (`ORD-...`)
  - Valid Sandbox `payee.merchant_id: "LWYH7EFRADPZ4"`
  - Valid Sandbox `approve` URL (`https://www.sandbox.paypal.com/checkoutnow?token=45R10666DE347542C`), returning HTTP `200` on direct probe (`paypalDebugId: f6027954bec7e`).
- **Frontend SDK Config:** `@paypal/react-paypal-js` `v10.6.1` initializes with the Sandbox `clientId` from `GET /api/payments/config`, `currency: "USD"`, and `intent: "capture"`.

### C. Unresolved External Sandbox / Browser Causes of Attempt #1's `/checkoutweb/genericError`
Because Chrome remote debugging (`DevToolsActivePort`) was unavailable here and PayPal's `client_credentials` OAuth API (`/v1/identity/oauth2/userinfo`) does not expose Sandbox account country, verification state, or buyer session metadata, the exact PayPal-hosted UI trigger for Attempt #1 could not be captured from Chrome's Network tab. The most common external triggers in PayPal Sandbox are:
1. **Sandbox Account Country / Currency Compliance (`IN` vs `US`):** If either the Business seller (`LWYH7EFRADPZ4`) or the Personal buyer Sandbox account is registered as India (`IN`) while charging `USD` (or mismatched cross-border setup), PayPal's hosted `checkoutweb` frequently aborts to `/checkoutweb/genericError` instead of returning a REST API error.
2. **Same-Account / Non-Personal Login in Popup:** Signing into the PayPal Sandbox popup using the Business merchant account owning `LWYH7EFRADPZ4`, the PayPal Developer login email, or a live PayPal account causes PayPal Checkout Web to fail with `/checkoutweb/genericError`.
3. **Browser Session Cookies / Privacy Extensions:** Active `paypal.com` cookies or strict tracking/popup blockers inside a normal browser profile can break `sandbox.paypal.com/checkoutweb` XHR requests.
4. **Unverified Sandbox Account Email / Profile:** Unconfirmed Sandbox Business/Personal test accounts in `developer.paypal.com -> Sandbox Accounts`.

---

## 2. Relevant Sanitized PayPal API & Database Evidence

### Sanitized MongoDB Atlas `transactions` Snapshot
- `45R10666DE347542C` (`ORD-MWDJGVRW-A094`, `createdAt: 2026-11-12T13:02:38.500Z`):
  - `state`: `"CAPTURE_FAILED"`, `providerStatus`: `"CANCELLED_BY_CUSTOMER"`, `amount: 30`, `currency: "USD"`.
- `2M70946580205230E` (`ORD-MWDJZ6JN-96B7`, pre-approval API test):
  - `state`: `"CAPTURE_FAILED"`, `providerStatus`: `"The requested action could not be performed, semantically incorrect, or failed business validation."`, `amount: 30`, `currency: "USD"`.

### Sanitized `GET /v2/checkout/orders/45R10666DE347542C` Response (`200 OK`)
```json
{
  "id": "45R10666DE347542C",
  "status": "CREATED",
  "intent": "CAPTURE",
  "create_time": "2026-11-12T13:02:37Z",
  "purchase_units": [
    {
      "reference_id": "6af5b46d9bc17eb3253be250",
      "custom_id": "ORD-MWDJGVRW-A094",
      "description": "ReBoxify Order ORD-MWDJGVRW-A094 (includes refundable packaging deposit)",
      "amount": {
        "currency_code": "USD",
        "value": "30.00",
        "breakdown": {
          "item_total": { "currency_code": "USD", "value": "30.00" },
          "shipping": { "currency_code": "USD", "value": "0.00" },
          "tax_total": { "currency_code": "USD", "value": "0.00" }
        }
      },
      "payee": {
        "merchant_id": "LWYH7EFRADPZ4",
        "email_address_present": true
      }
    }
  ],
  "links": [
    { "href": "https://api.sandbox.paypal.com/v2/checkout/orders/45R10666DE347542C", "rel": "self", "method": "GET" },
    { "href": "https://www.sandbox.paypal.com/checkoutnow?token=45R10666DE347542C", "rel": "approve", "method": "GET" }
  ]
}
```

### Sanitized Backend `idempotencyKeys` Finding
- `key`: `"paypal-create-order:6af5ac99c20f69ce15247758:ui-create-6af5b46d9bc17eb3253be250"` cached `{ "paypalOrderId": "45R10666DE347542C" }` (`statusCode: 201`), explaining why repeat UI clicks kept reusing the cancelled order ID prior to the frontend fix.

---

## 3. Browser Console & Network Findings

- **Live Chrome DevTools Inspection:** Unavailable (`DevToolsActivePort` missing because Chrome remote debugging was not active). No simulated console logs or fake browser screenshots were generated.
- **Direct Approve URL Probe (`fetch("https://www.sandbox.paypal.com/checkoutnow?token=45R10666DE347542C", { redirect: "manual" })`):** Returned HTTP `200 OK` (`paypalDebugId: f6027954bec7e`), confirming the redirect to `/checkoutweb/genericError` occurs client-side inside PayPal's Checkout Web XHR/login session rather than from an HTTP 302 rejection on the initial token URL.

---

## 4. Backend & Frontend Configuration Findings

- Backend REST client ([paypalClient.ts](file:///d:/Projects/Reboxify/backend/src/services/paypalClient.ts)), payment state machine ([paymentService.ts](file:///d:/Projects/Reboxify/backend/src/services/paymentService.ts)), and `/api/payments/config` ([paymentRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/paymentRoutes.ts)) are properly configured for PayPal Sandbox (`USD`, `intent: CAPTURE`) with zero secrets exposed to frontend builds.
- Notice in `UserPortal.tsx`: each order card embeds `<PayPalOrderCheckout>` (which wraps `<PayPalScriptProvider>`). For customers with multiple unpaid orders on screen simultaneously, consolidating a single page-level `<PayPalScriptProvider>` is a worthwhile future UX polish, though not the cause of Attempt #1 when only one unpaid order was rendered.

---

## 5. Fixes Implemented

- **[PayPalOrderCheckout.tsx](file:///d:/Projects/Reboxify/frontend/src/components/PayPalOrderCheckout.tsx):**
  - Replaced static `ui-create-${order.id}` idempotency key with per-attempt `createAttemptKeyRef` rotation on `onCancel`, `onError`, `onApprove`, and prior `CAPTURE_FAILED` state so retries generate a clean new PayPal Sandbox order instead of replaying a cancelled/failed `paypalOrderId`.
  - Cleared `activePayPalOrderRef` when transaction state is `CAPTURE_FAILED` or cancelled/errored.
  - Added explicit `components: 'buttons'` option to `PayPalScriptProvider`.

---

## 6. Exact Steps for Retesting with a Personal Sandbox Buyer Account

1. **Verify Sandbox Accounts in PayPal Developer Dashboard (`developer.paypal.com` -> *Testing Tools* -> *Sandbox Accounts*):**
   - Check the country of your **Business** account (`LWYH7EFRADPZ4`) and create/use a **US (`United States`) Business Sandbox account** + **US Personal Buyer Sandbox account** (if the current Business/Personal pair is `IN` testing `USD`).
   - If you switch Sandbox Business accounts, update `PAYPAL_CLIENT_ID` & `PAYPAL_CLIENT_SECRET` in `backend/.env` to match an app owned by that US Business Sandbox account and restart the backend.
   - Ensure the Personal Buyer Sandbox account is separate from the Business Seller account and has verified email + positive USD balance.
2. **Open an Incognito Browser Window** (no live `paypal.com` cookies or ad/tracker blockers) -> navigate to **`http://localhost:3000/#/user-login`**.
3. Sign in to Customer Portal (`cust@gmail.com` or `customer@reboxify.test`) and click the **PayPal** button on **`ORD-MWDJGVRW-A094`** (Vite dev server already hot-reloads the fixed `PayPalOrderCheckout.tsx` — it will now create a brand-new `paypalOrderId` instead of replaying `45R10666DE347542C`).
4. In the PayPal popup, sign in **strictly using your Personal Sandbox Buyer credentials** (`...@personal.example.com`) and click **Complete Purchase**.
5. If PayPal still redirects to `/checkoutweb/genericError`, press **F12 -> Network** inside the PayPal popup before closing it, copy any `?code=` parameter from the `genericError` URL and any failed XHR response body, and share it here for exact provider code decoding.

---

## 7. State Integrity Confirmation

- Zero payment records were manually modified or marked `CAPTURED`.
- `45R10666DE347542C` and `2M70946580205230E` remain cleanly audited as `CAPTURE_FAILED`, orders remain in `PAYMENT_PENDING` / `ALLOCATED` (Gate 1 dispatch remains blocked), and no backend API security checks or buyer approval rules were bypassed.

