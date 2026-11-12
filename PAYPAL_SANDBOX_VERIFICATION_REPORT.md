# ReBoxify — PayPal Sandbox Configuration & Verification Report

**Branch:** `rebuild/v2-mvp` (uncommitted; stopping here awaiting approval)  
**Environment:** Local preview backend (`http://localhost:5000`, `NODE_ENV=development`, `PAYPAL_ENV=sandbox`, `DEFAULT_CURRENCY=USD`) connected to MongoDB Atlas (`replicaSet=true`) + Vite frontend (`http://localhost:3000/`).

---

## 1. Configuration Status

- **Backend Env Location:** `backend/.env` (git-ignored by `.gitignore`; `backend/.env.example` keeps placeholders only).
- **Required Variables Checked (Values Redacted):**
  - `PAYPAL_ENV=sandbox` -> **Configured** (`https://api-m.sandbox.paypal.com`)
  - `PAYPAL_CLIENT_ID` -> **Configured in `backend/.env`** (read server-side only; exposed cleanly to the browser SDK via `GET /api/payments/config`)
  - `PAYPAL_CLIENT_SECRET` -> **Configured in `backend/.env`** (strictly backend-only; zero frontend exposure)
  - `PAYPAL_WEBHOOK_ID` -> **Not configured yet** (`paypalWebhookConfigured: false` — needed when registering Render webhook URL in Phase 6)
- **Live Server Readiness (`npm --prefix backend run start` restarted & probed):**
  - `GET http://localhost:5000/api/health` -> `200 OK`:
    - `database.connected`: `true`
    - `database.replicaSetSupported`: `true`
    - `integrations.paypalSandboxConfigured`: `true`
    - `integrations.paypalWebhookConfigured`: `false`
  - `GET http://localhost:5000/api/payments/config` -> `200 OK` (`paypalConfigured: true`, `hasClientId: true`, `currency: "USD"`, `environment: "sandbox"`).

---

## 2. PayPal Sandbox OAuth Verification

- Verified `POST https://api-m.sandbox.paypal.com/v1/oauth2/token` (`grant_type=client_credentials`) directly using the configured `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`:
  - **HTTP Status:** `200 OK`
  - **Token Type:** `Bearer`
  - **Expires In:** `32400` seconds
  - **Sandbox App ID:** `APP-5VP99870G5749381H`
  - **Result:** Passed live without exposing credentials or access tokens.

---

## 3. Payment Creation & Backend Calculation Verification

Verified against the running Express API (`http://localhost:5000`) and live PayPal Sandbox:

1. Created and allocated a live Sandbox verification order (`POST /api/orders`, `autoAllocate: true`):
   - **Order Number:** `ORD-MWDJZ6JN-96B7` (`orderId`: `6af5b7c3938136285ded78d5`)
   - **Allocated Reusable Package:** `RBX-CHN-50445F` (Class `M`, Deposit: `USD 5.00`)
   - **Backend Totals:** `productSubtotal: 25.00`, `depositTotal: 5.00`, `shippingTotal: 0.00`, `taxTotal: 0.00`, **`grandTotal: 30.00 USD`**
2. Executed `POST /api/payments/paypal/create-order`:
   - **HTTP Status:** `201 Created`
   - **PayPal Sandbox Order ID:** **`2M70946580205230E`**
   - **Provider Status:** `CREATED`
   - **Returned Disclosure:** `productSubtotal: 25`, `depositTotal: 5`, `grandTotal: 30`, `currency: "USD"`, `depositAllocations: [{ packageId: "RBX-CHN-50445F", allocatedDeposit: 5, refundedAmount: 0, pendingRefundAmount: 0 }]`
3. Cross-checked live PayPal Sandbox `GET /v2/checkout/orders/2M70946580205230E`:
   - **HTTP Status:** `200 OK`, `status: "CREATED"`, `intent: "CAPTURE"`
   - **`purchase_units[0].reference_id`:** `6af5b7c3938136285ded78d5` (matches MongoDB order ID)
   - **`purchase_units[0].amount`:** `{ currency_code: "USD", value: "30.00", breakdown: { item_total: "30.00", shipping: "0.00", tax_total: "0.00" } }`

---

## 4. Capture Verification & Zero-Bypass Guard (`CAPTURED` State Integrity)

- **Pre-Approval Capture Test (`POST /api/payments/paypal/capture/2M70946580205230E` without PayPal buyer approval):**
  - Live PayPal Sandbox rejected the unapproved capture (`ORDER_NOT_APPROVED`), and the backend returned **`422 PAYMENT_CAPTURE_FAILED`** (`correlationId`: `2f46e344-9d1b-4363-b908-a86f15196599`).
  - Backend did **not** mark the transaction `CAPTURED` and persisted **`captureId: null`**, cleanly proving payment status cannot transition to `CAPTURED` without real provider confirmation.

---

## 5. Non-Sensitive Provider & Database Persistence Snapshot

- **PayPal App ID:** `APP-5VP99870G5749381H`
- **PayPal Sandbox Order ID:** `2M70946580205230E`
- **Provider Capture ID:** `null` *(pending interactive PayPal Sandbox Buyer approval in checkout UI)*
- **MongoDB Atlas Persistence (`transactions` & `orders`):**
  - `transactions` document ID: `6af5b7c6938136285ded78eb`
  - `state`: `CAPTURE_FAILED` (transitioned cleanly from `CREATED` -> `CAPTURE_PENDING` -> `CAPTURE_FAILED` on PayPal rejection)
  - `amount`: `30` (`USD`), `depositAllocations`: `[{ packageId: "RBX-CHN-50445F", allocatedDeposit: 5, refundedAmount: 0, pendingRefundAmount: 0 }]`
  - Linked `orders` document `ORD-MWDJZ6JN-96B7`: `status: "PAYMENT_PENDING"` (dispatch Gate 1 remains safely blocked until captured).
- *(Your prior order `ORD-MWDJGVRW-A094` remains untouched in `ALLOCATED` state ready for interactive browser checkout.)*

---

## 6. Remaining Blockers / Pending Interactive Steps

1. **Buyer-Approved Sandbox Capture (`captureId` confirmation):** Server-side `client_credentials` OAuth alone cannot simulate the buyer signing into PayPal to approve an order (`APPROVED` -> `COMPLETED` with a live `captureId`). To observe a live **`CAPTURED`** transaction and real PayPal **Capture ID** in MongoDB:
   - Log into Customer Portal (`http://localhost:3000/#/user-portal`), refresh, and click the **PayPal** checkout button on an allocated order using a **PayPal Sandbox Personal Buyer** test account (from `developer.paypal.com -> Sandbox Accounts`).
2. **Webhook Verification ID (`PAYPAL_WEBHOOK_ID`):** Still unconfigured (`paypalWebhookConfigured: false`), pending Render HTTPS deployment and webhook registration in Phase 6.

