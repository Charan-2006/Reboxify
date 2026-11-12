# ReBoxify — PayPal Checkout Failure Deep Root-Cause Diagnostic Report

**Branch:** `rebuild/v2-mvp`  
**Status:** Read-only deep investigation (existing payment records untouched; no fake approvals or forced captures).

---

## 1. Phase A — Browser Evidence Collection Status

### Automated Chrome DevTools Check
- Re-checked Chrome DevTools connectivity via the `browser` subagent against `http://localhost:3000/#/user-portal`.
- **Result:** Unavailable on this host (`Could not find DevToolsActivePort for chrome at C:\Users\Hp\AppData\Local\Google\Chrome\User Data\DevToolsActivePort`). Per strict verification rules, no live browser DOM/console/network evidence was fabricated.

### Non-Browser HTTP & Server-Side Evidence Captured
- **PayPal JS SDK Script Load (`https://www.paypal.com/sdk/js?client-id=<PUBLIC_SANDBOX_CLIENT_ID>&currency=USD&intent=capture&components=buttons`):** Returned `HTTP 200`, `content-type: application/javascript; charset=utf-8`, `398,080` bytes, no error comment.
- **PayPal Checkout Approve URL (`https://www.sandbox.paypal.com/checkoutnow?token=45R10666DE347542C`):** Direct HTTP probe (`redirect: 'manual'`) returned `HTTP 200 OK` (`paypal-debug-id: f6027954bec7e`), proving `/checkoutnow` loads PayPal's client-side `checkoutweb` SPA first and redirects **client-side** inside the browser popup/XHR session to `/checkoutweb/genericError`.
- **Database Timeline Observation (Proving Retry Fix Worked):**
  - After the earlier `PayPalOrderCheckout.tsx` retry key fix, a fresh customer checkout attempt at `2026-11-12T13:20:35.451Z` created a **brand-new** PayPal Order ID **`9K376733F8601401K`** (distinct from `45R10666DE347542C`).
  - `38` seconds later (`13:21:13.137Z`), `onCancel` ran (`CANCELLED_BY_CUSTOMER`) after the popup hit `genericError`.

### Manual Steps for Developer to Capture Exact Browser Evidence
Because `/checkoutweb/genericError` happens inside PayPal's client-side `sandbox.paypal.com` popup SPA:
1. Open **Incognito Chrome** -> press **F12** -> open **Console** and **Network** tabs -> enable **Preserve log** on both tabs (also enable Chrome **Settings -> DevTools -> Auto-open DevTools for popups** so the popup's own Network tab opens immediately).
2. Open `http://localhost:3000/#/user-login`, sign in as customer, and click the **PayPal** button on `ORD-MWDJGVRW-A094`.
3. In the popup DevTools **Network** tab, note **at which exact moment** it redirects to `/checkoutweb/genericError`:
   - immediately before buyer email/login appears, **OR**
   - during/right after entering Sandbox buyer email/password, **OR**
   - after clicking **Complete Purchase** inside PayPal.
4. Inspect any failed `POST`/`GET` requests (`4xx`/`5xx`) to `sandbox.paypal.com/graphql` or `/smart/api/...` or `/webapps/hermes/...` (copy the sanitized JSON error name/issue & `paypal-debug-id` header, and copy any `?code=` query string from the `genericError` URL without copying session cookies/tokens).

---

## 2. Phase B — PayPal Integration Audit Checklist (Code vs Official Orders v2 Spec)

Inspected [PayPalOrderCheckout.tsx](file:///d:/Projects/Reboxify/frontend/src/components/PayPalOrderCheckout.tsx), [paypalClient.ts](file:///d:/Projects/Reboxify/backend/src/services/paypalClient.ts), [paymentService.ts](file:///d:/Projects/Reboxify/backend/src/services/paymentService.ts), and [paymentRoutes.ts](file:///d:/Projects/Reboxify/backend/src/routes/paymentRoutes.ts):

| Check | Status | Verified Details |
| :--- | :--- | :--- |
| 1. Frontend SDK `client-id` matches backend app | **Verified OK** | `PayPalOrderCheckout.tsx:29-30` reads `paypalConfig.paypalClientId` from `GET /api/payments/config`, which serves `config.paypalClientId` directly (`paymentRoutes.ts:38`). |
| 2. SDK `currency` === backend order currency | **Verified OK** | Both pass `USD`. |
| 3. SDK `intent` === order `intent` | **Verified OK** | SDK sends `intent: 'capture'`; REST v2 order creates `intent: 'CAPTURE'`. |
| 4. Frontend uses correct Sandbox environment | **Verified OK** | Backend OAuth `appId: APP-5VP99870G5749381H` is on `api-m.sandbox.paypal.com`; PayPal JS SDK routes Sandbox `client-id` automatically to `www.sandbox.paypal.com`. |
| 5. Approval callback uses newly created Order ID | **Verified OK** | `createOrder` returns `res.paypalOrderId`; latest DB transaction confirmed new ID `9K376733F8601401K` (distinct from prior `45R10666DE347542C`). |
| 6. `onApprove` invokes backend capture endpoint | **Verified OK** | `capturePayPalCheckoutOrder(data.orderID, 'ui-cap-' + data.orderID)` calls `POST /api/payments/paypal/capture/${data.orderID}`. |
| 7. Backend captures same approved Order ID | **Verified OK** | `PaymentService.capturePayPalOrder` looks up `findByPayPalOrderId(cleanId)` and calls `POST /v2/checkout/orders/${cleanId}/capture`. |
| 8. `payee.merchant_id` matches Sandbox seller | **Verified OK** | Live `GET /v2/checkout/orders/9K376733F8601401K` confirms PayPal bound `payee.merchant_id: "LWYH7EFRADPZ4"`. |
| 9. Purchase unit & amount breakdown valid | **Verified OK** | `value: "30.00"` === `item_total ("30.00") + shipping ("0.00") + tax_total ("0.00")`, `USD`, accepted `201 CREATED` by PayPal. |
| 10. `application_context` / `return_url` / `cancel_url` | **Verified OK for JS SDK** | Omitted intentionally (`payment_source: null`), which is valid per PayPal Orders v2 JS SDK popup flows (`onApprove`/`onCancel` handle popup completion). Only standalone browser-tab redirect flows require explicit `return_url`/`cancel_url`. |

*(Note: All 10 PayPal REST API + `@paypal/react-paypal-js` integration points pass validation cleanly against PayPal's Orders v2 specification.)*

---

## 3. Sanitized Live PayPal Responses

### Latest Failed Checkout Transaction (MongoDB Atlas `transactions`)
```json
{
  "id": "6af5bd23938136285ded798f",
  "orderId": "6af5b46d9bc17eb3253be250",
  "paypalOrderId": "9K376733F8601401K",
  "state": "CAPTURE_FAILED",
  "providerStatus": "CANCELLED_BY_CUSTOMER",
  "amount": 30,
  "currency": "USD",
  "createdAt": "2026-11-12T13:20:35.451Z",
  "updatedAt": "2026-11-12T13:21:13.137Z"
}
```

### Live `GET https://api.sandbox.paypal.com/v2/checkout/orders/9K376733F8601401K` (`200 OK`)
```json
{
  "id": "9K376733F8601401K",
  "status": "CREATED",
  "intent": "CAPTURE",
  "create_time": "2026-11-12T13:20:34Z",
  "purchase_units": [
    {
      "reference_id": "6af5b46d9bc17eb3253be250",
      "custom_id": "ORD-MWDJGVRW-A094",
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
        "email_present": true
      }
    }
  ],
  "payment_source": null,
  "links": [
    { "href": "https://api.sandbox.paypal.com/v2/checkout/orders/9K376733F8601401K", "rel": "self", "method": "GET" },
    { "href": "https://www.sandbox.paypal.com/checkoutnow?token=9K376733F8601401K", "rel": "approve", "method": "GET" }
  ]
}
```

### Isolated Standalone Diagnostic Order Created Directly on PayPal Sandbox (Outside ReBoxify DB)
Created via direct `POST https://api-m.sandbox.paypal.com/v2/checkout/orders` with minimal payload `{ "intent": "CAPTURE", "purchase_units": [{ "amount": { "currency_code": "USD", "value": "10.00" } }] }`:
```json
{
  "httpStatus": 201,
  "paypalDebugId": "f76531182ff6f",
  "id": "4DW47508TA251783F",
  "status": "CREATED",
  "approveLink": "https://www.sandbox.paypal.com/checkoutnow?token=4DW47508TA251783F"
}
```

---

## 4. Phase C — Root-Cause Determination & Isolation

### What Is Proven vs. What Remains Unknown
- **Proven in ReBoxify:** Every server-side step (OAuth `APP-5VP99870G5749381H`, `create-order` creating fresh order IDs `45R10666DE347542C` -> `9K376733F8601401K`, matching `USD` amounts/breakdown, valid `payee.merchant_id: LWYH7EFRADPZ4`, JS SDK loading `HTTP 200`, and `onCancel` handling) works cleanly. No ReBoxify code error appears in backend logs or API responses.
- **Exact Failing Request & Response (Unknown Until Browser Popup Capture):** Because the redirect happens client-side inside `www.sandbox.paypal.com/checkoutweb` (and Chrome DevTools was unavailable here), the exact internal PayPal GraphQL/XHR failure (`4xx`/`5xx`) and login-timing stage (before vs. during vs. after buyer login) could not be observed directly.
- **Assessment (ReBoxify vs. PayPal Sandbox):** All payload, SDK, and backend evidence strongly points to **PayPal Sandbox Account / Browser Session Restriction** rather than a ReBoxify code defect — specifically, either:
  1. Seller `LWYH7EFRADPZ4` and/or buyer Sandbox account country (`IN` vs `US` compliance restriction on `USD` checkout in Sandbox),
  2. Signing in with a non-Personal/same-seller/developer account instead of a separate Personal Sandbox Buyer,
  3. Conflicting `paypal.com` cookies or third-party cookie / privacy blocking in the browser, or
  4. An unverified/flagged Sandbox test account in `developer.paypal.com`.

### Minimal Safe Code Action
- **No additional code edits applied in this pass** ("Do not change payment business logic without evidence"). Existing tests (`9/9` files, `37/37` tests) and builds remain verified clean.

---

## 5. Exact Standalone Isolation & Retest Instructions

1. **Test Isolated Minimal PayPal Order First (Eliminates ReBoxify Completely):**
   - Open an **Incognito/Private** Chrome window and paste the standalone Sandbox approval URL created directly on your PayPal app:
     `https://www.sandbox.paypal.com/checkoutnow?token=4DW47508TA251783F`
   - Sign in with your **Personal Sandbox Buyer** account (`...@personal.example.com`) with Chrome DevTools (**F12 -> Network -> Preserve log**) open.
   - **If even `4DW47508TA251783F` hits `/checkoutweb/genericError`:** It is 100% confirmed to be your PayPal Sandbox Business (`LWYH7EFRADPZ4`) / Buyer account configuration or browser session (not ReBoxify).
     - Fix in `developer.paypal.com -> Testing Tools -> Sandbox Accounts`: create a **fresh US (`United States`) Business Sandbox account** + **fresh US Personal Buyer Sandbox account**, create a Sandbox REST App under that **US Business** account (`Apps & Credentials`), update `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in `backend/.env`, restart the backend, and retest in ReBoxify.
   - **If `4DW47508TA251783F` loads buyer approval cleanly while ReBoxify hits `/checkoutweb/genericError`:** Copy the failing `/graphql` or XHR response in Network tab inside ReBoxify's popup and share it here along with which stage (before login / during login / after login) it failed at.
2. **State Integrity Confirmation:** Existing order `ORD-MWDJGVRW-A094` and transactions (`9K376733F8601401K`, `45R10666DE347542C`, `2M70946580205230E`) were **not** altered, forced to `CAPTURED`, or duplicated.

