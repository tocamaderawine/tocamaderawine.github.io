# Wine Tower relay

A small Cloudflare Worker. Toast sends it an alert every time an order changes; it picks out bottle wines,
matches each to its tower slot using `../toast-map.json`, and writes it to the live database so the slot
glows on every phone until someone taps **Got it**. Bottles sold also come off the tower count.

Secrets (Cloudflare dashboard > the worker > Settings > Variables and Secrets):

| Name | Where it comes from |
| --- | --- |
| `TOAST_WEBHOOK_SECRET` | Toast Web > Integrations > Toast API access > Manage webhooks > the subscription's secret key |
| `FIREBASE_SECRET` | Firebase console > Project settings > Service accounts > Database secrets |
| `TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET` | Optional. Toast Standard API credentials, used for table names and to read the wine menu |

Endpoints: `POST /toast` (Toast webhook), `GET /` (health), `GET /refresh` (re-read tables and wine menu, at most every 5 minutes).
