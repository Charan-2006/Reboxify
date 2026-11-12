# ReBoxify — Live PayPal Sandbox Transaction Verification Report

**Order Number:** `ORD-MWDJGVRW-A094`  
**PayPal Order ID:** `69T8639186902252W`  
**PayPal Capture ID:** `3FM91774FU1612010`  
**Verification Mode:** Strictly read-only inspection of MongoDB Atlas (`reboxify`) and PayPal Sandbox REST APIs (`api-m.sandbox.paypal.com`). Zero source files or database records were modified.

---

## 1. Verification Matrix (All 8 Checks)

| # | Verification Requirement | Result | Verified Evidence |
| :--- | :--- | :--- | :--- |
| 1 | Payment transaction exists in MongoDB Atlas | **PASS** | Document `6af5c79ae71a2bf868e0050f` in `transactions` linked to `orderId: 6af5b46d9bc17eb3253be250` (`ORD-MWDJGVRW-A094`). |
| 2 | Stored PayPal Order ID & Capture ID match | **PASS** | `paypalOrderId === "69T8639186902252W"`, `captureId === "3FM91774FU1612010"`. |
| 3 | Stored amount is `USD 30.00` | **PASS** | `amount: 30`, `currency: "USD"` (matches order `totals.grandTotal: 30` and PayPal capture `30.00 USD`). |
| 4 | Payment status is `CAPTURED` | **PASS** | Transaction `state: "CAPTURED"`, `providerStatus: "COMPLETED"`, linked order `status: "PAID"`. |
| 5 | PayPal Orders v2 confirms order status | **PASS** | `GET /v2/checkout/orders/69T8639186902252W` -> `200 OK`, `status: "COMPLETED"`, `intent: "CAPTURE"`, `payee_merchant_id: "NVR75FYDUP4R6"`. |
| 6 | PayPal Captures API confirms `COMPLETED` | **PASS** | `GET /v2/payments/captures/3FM91774FU1612010` -> `200 OK`, `status: "COMPLETED"`, `amount: USD 30.00`, `final_capture: true`. |
| 7 | Refundable deposit allocation is `USD 5.00` | **PASS** | `depositAllocations: [{ packageId: "RBX-CHN-3748BA", allocatedDeposit: 5, refundedAmount: 0, pendingRefundAmount: 0 }]` matching order `totals.depositTotal: 5`. |
| 8 | Order not marked paid solely from frontend callback | **PASS** | Verified via code path and timestamped `auditLogs` / `searchOutbox` trail (details in Section 4). |

---

## 2. MongoDB Atlas Read-Only Evidence

### Order (`orders`)
```json
{
  "id": "6af5b46d9bc17eb3253be250",
  "orderNumber": "ORD-MWDJGVRW-A094",
  "status": "PAID",
  "currency": "USD",
  "totals": {
    "productSubtotal": 25,
    "depositTotal": 5,
    "shippingTotal": 0,
    "taxTotal": 0,
    "grandTotal": 30
  },
  "allocatedPackages": [
    {
      "packageId": "RBX-CHN-3748BA",
      "packageClass": "M",
      "ownerType": "MERCHANT",
      "depositAmount": 5
    }
  ]
}
```

### Transaction (`transactions`)
```json
{
  "id": "6af5c79ae71a2bf868e0050f",
  "orderId": "6af5b46d9bc17eb3253be250",
  "paypalOrderId": "69T8639186902252W",
  "captureId": "3FM91774FU1612010",
  "state": "CAPTURED",
  "providerStatus": "COMPLETED",
  "amount": 30,
  "currency": "USD",
  "approvedAt": "2026-11-12T14:05:37.228Z",
  "capturedAt": "2026-11-12T14:05:39.675Z",
  "depositAllocations": [
    {
      "packageId": "RBX-CHN-3748BA",
      "allocatedDeposit": 5,
      "refundedAmount": 0,
      "pendingRefundAmount": 0
    }
  ]
}
```

### Audit Trail (`auditLogs` & `searchOutbox`)
- **`PAYPAL_ORDER_CREATED`** at `2026-11-12T14:05:15.031Z` (`correlationId: dc7c78ab-0a82-4d67-ae14-23e28a5b51fb`) — logged `orderId`, `paypalOrderId: 69T8639186902252W`, `amount: 30`, `currency: USD`, and `depositAllocations`.
- **`PAYMENT_CAPTURED`** at `2026-11-12T14:05:39.939Z` (`correlationId: e5b47561-163c-4da2-bb32-96784d6b0e6e`) — logged `captureId: 3FM91774FU1612010`, `amount: 30`, `currency: USD`.
- **`searchOutbox`:** `3` `'payment'` outbox entries (`UPSERT`, `PENDING`) emitted across transaction lifecycle transitions (`CREATED` -> `CAPTURE_PENDING` -> `CAPTURED`).

---

## 3. PayPal Sandbox REST API Verification (Sanitized)

### `GET /v2/checkout/orders/69T8639186902252W` (`200 OK`)
```json
{
  "id": "69T8639186902252W",
  "status": "COMPLETED",
  "intent": "CAPTURE",
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
      "payee_merchant_id": "NVR75FYDUP4R6",
      "captures": [
        {
          "id": "3FM91774FU1612010",
          "status": "COMPLETED",
          "amount": { "currency_code": "USD", "value": "30.00" },
          "create_time": "2026-11-12T14:05:38Z"
        }
      ]
    }
  ],
  "payer_country": "IN"
}
```

### `GET /v2/payments/captures/3FM91774FU1612010` (`200 OK`)
```json
{
  "id": "3FM91774FU1612010",
  "status": "COMPLETED",
  "amount": { "currency_code": "USD", "value": "30.00" },
  "final_capture": true,
  "seller_receivable_breakdown": {
    "gross_amount": { "currency_code": "USD", "value": "30.00" },
    "paypal_fee": { "currency_code": "USD", "value": "1.99" },
    "net_amount": { "currency_code": "USD", "value": "28.01" }
  },
  "custom_id": "ORD-MWDJGVRW-A094",
  "create_time": "2026-11-12T14:05:38Z"
}
```

---

## 4. Verification of Server-Side Payment Integrity (Check #8)

- **No Frontend Trust:** [PayPalOrderCheckout.tsx](file:///d:/Projects/Reboxify/frontend/src/components/PayPalOrderCheckout.tsx#L194-L202) sends only `data.orderID` (`69T8639186902252W`) to `POST /api/payments/paypal/capture/69T8639186902252W`. The browser never calculates amounts, capture IDs, or payment states.
- **Server-Side Capture & Validation ([paymentService.ts](file:///d:/Projects/Reboxify/backend/src/services/paymentService.ts#L325-L533)):**
  1. Backend locked the transaction to `CAPTURE_PENDING` (`approvedAt: 14:05:37.228Z`).
  2. Backend executed `POST /v2/checkout/orders/69T8639186902252W/capture` server-to-server (`PayPal create_time: 14:05:38Z`).
  3. Backend verified `unit.reference_id === order.id`, `capture.status === 'COMPLETED'`, `currency === 'USD'`, and `amount === 30.00`, then committed `Transaction.state = 'CAPTURED'` and `Order.status = 'PAID'` (`capturedAt: 14:05:39.675Z`) inside a MongoDB replica-set transaction and wrote `PAYMENT_CAPTURED` (`14:05:39.939Z`) to `auditLogs`.

---

## 5. Discrepancies Found

**None.** Every field matches cleanly across ReBoxify's MongoDB Atlas `orders`, `transactions`, `auditLogs`, and `searchOutbox` collections as well as PayPal Sandbox Orders v2 and Captures v2 APIs. *(Switching the Sandbox app/merchant to `NVR75FYDUP4R6` resolved the earlier PayPal Sandbox `genericError` cleanly.)*

