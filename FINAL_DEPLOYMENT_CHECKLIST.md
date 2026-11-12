# ReBoxify — Final Deployment Checklist

Target Blueprint: [render.yaml](file:///d:/Projects/Reboxify/render.yaml)  
Branch: `rebuild/v2-mvp`

---

## 1. Render Services Architecture

`render.yaml` defines three coordinated Render services:

| Service | Render Type | Root Dir | Build Command | Start / Publish Command | Health Check |
|---|---|---|---|---|---|
| `reboxify-api` | `web` (Node) | `backend` | `npm ci && npm run build` | `npm start` | `GET /api/health` |
| `reboxify-worker` | `worker` (Node) | `backend` | `npm ci && npm run build` | `npm run start:worker` | Heartbeat in MongoDB `WorkerLease` (`reboxify-reconcile-worker`) |
| `reboxify-web` | `web` (`static`) | `frontend` | `npm ci && npm run build` | `dist` (SPA rewrite `/* -> /index.html`) | N/A |

---

## 2. Environment Variables Required (Supply Securely in Render Dashboard)

Never commit real secrets. Reference template: [backend/.env.example](file:///d:/Projects/Reboxify/backend/.env.example).

### `reboxify-api`
- `NODE_ENV=production`
- `PORT` (provided by Render)
- `APP_BASE_URL=https://<your-api-service>.onrender.com`
- `CORS_ORIGIN=https://<your-frontend-service>.onrender.com`
- `MONGODB_URI=<MongoDB Atlas SRV Replica Set URI>` (**Required in production; startup aborts if non-replica-set**)
- `JWT_SECRET`, `SESSION_SECRET`, `QR_SIGNING_SECRET` (auto-generated >=64 chars via Render `generateValue: true`)
- `QR_KEY_ID=k1`
- `DEFAULT_CURRENCY=USD`
- `PAYPAL_ENV=sandbox` (or `live` with production merchant credentials)
- `PAYPAL_CLIENT_ID=<PayPal App Client ID>`
- `PAYPAL_CLIENT_SECRET=<PayPal App Secret>`
- `PAYPAL_WEBHOOK_ID=<PayPal Webhook ID configured for https://<api>/api/webhooks/paypal>`
- `ELASTICSEARCH_URL=<Hosted Elasticsearch Endpoint>`
- `ELASTICSEARCH_API_KEY=<Elasticsearch Base64 API Key>` *(or set `ELASTICSEARCH_USERNAME` + `ELASTICSEARCH_PASSWORD`)*
- `ELASTICSEARCH_INDEX_PREFIX=reboxify`
- `ELASTICSEARCH_REQUEST_TIMEOUT_MS=5000`
- `GEMINI_API_KEY=<Google AI Studio / Gemini Backend API Key>`
- `GEMINI_MODEL=gemini-2.5-flash`
- `AI_RATE_LIMIT_MAX_PER_MIN=20`

### `reboxify-worker`
- Same `MONGODB_URI`, `JWT_SECRET`, `SESSION_SECRET`, `QR_SIGNING_SECRET`, `PAYPAL_*`, and `ELASTICSEARCH_*` credentials as `reboxify-api`.
- Worker tuning defaults in `render.yaml`: `OUTBOX_POLL_INTERVAL_MS=5000`, `RECONCILE_INTERVAL_MS=60000`, `PENDING_RECONCILE_MIN_AGE_MS=120000`, `WORKER_LEASE_TTL_MS=90000`, `WORKER_MAX_BACKOFF_MS=300000`, `WEBHOOK_MAX_RETRIES=5`.

### `reboxify-web` (Static Site)
- `VITE_API_BASE_URL=https://<your-api-service>.onrender.com`
- `VITE_PAYPAL_CLIENT_ID=<PayPal Public Browser Client ID>`
- `VITE_APP_CURRENCY=USD`

---

## 3. Infrastructure Setup Checklists

### MongoDB Atlas
- [ ] Ensure Atlas cluster is M0/M10+ Replica Set (transactions enforced by `runInTransaction` + `worker.ts`).
- [ ] Whitelist Render egress IPs (or VPC peering / `0.0.0.0/0` with strong SCRAM password) in Atlas Network Access.
- [ ] Confirm unique partial index `packageEvents` (`packageId + scanId` partial filter) is active.

### PayPal Sandbox & Webhook Setup
- [ ] Configure PayPal REST App credentials (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`) cleanly on `reboxify-api` and `reboxify-worker`.
- [ ] Create webhook endpoint in PayPal Developer Dashboard pointing to `https://<api-domain>/api/webhooks/paypal` subscribed to `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`.
- [ ] Copy the generated Webhook ID into `PAYPAL_WEBHOOK_ID` on both `reboxify-api` and `reboxify-worker`.

### Elasticsearch Setup
- [ ] Provision Elastic Cloud Serverless / Elastic Cloud / hosted Elasticsearch 8.x–9.x cluster.
- [ ] Create an index-scoped API key with `manage_index_templates`, `create_index`, `write`, and `read` permissions for prefix `reboxify_*`.
- [ ] Populate `ELASTICSEARCH_URL` and `ELASTICSEARCH_API_KEY` on both `reboxify-api` and `reboxify-worker`.
- [ ] After deploy, log in as `ADMIN` and trigger `Rebuild Derived Index` once from `AdminDashboard` (or `POST /api/search/reindex`) to backfill existing MongoDB records.

### Google Gemini Setup
- [ ] Generate backend API key in Google AI Studio with Gemini API enabled.
- [ ] Set `GEMINI_API_KEY` and `GEMINI_MODEL=gemini-2.5-flash` strictly on `reboxify-api` (never set `VITE_GEMINI_*`).

---

## 4. Post-Deploy Verification & Health Gate

1. Call `GET https://<api-domain>/api/health` and confirm HTTP `200`:
   - `database.connected: true`, `database.replicaSetSupported: true`
   - `worker.status: "HEALTHY"`
   - `integrations.statuses.elasticsearch: "CONNECTED"`
   - `integrations.statuses.gemini: "HEALTHY"`
   - `integrations.statuses.paypal: "CONFIGURED"`
   - `integrations.statuses.pickupScheduler: "COMMUNITY_READY"`
2. Verify all 5 operational portals open cleanly in browser without console/CORS errors.
3. Execute one end-to-end Sandbox checkout -> QR dispatch -> pickup -> inspection -> PayPal partial refund -> cleaning release cycle.

---

## 5. Rollback Considerations

- **API / Web Regression:** Use Render Dashboard "Rollback to previous deploy" on `reboxify-api` or `reboxify-web`. No destructive database schema migrations were introduced (`SearchReindexJob` and `SearchOutbox` changes are additive).
- **Elasticsearch Outage / Bad Index State:** Removing or invalidating `ELASTICSEARCH_URL` immediately activates automatic `MONGODB_FALLBACK` across all `/api/search/:entity` routes and all 5 AG Grids without interrupting orders, payments, or refunds.
- **Gemini Key Revocation / Quota Spike:** Removing `GEMINI_API_KEY` cleanly switches `/api/ai/*` into read-only `DISABLED` metrics fallback mode with zero impact on core workflows.

