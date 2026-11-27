# Wine Tower relay

A small Cloudflare Worker. Toast sends it an alert every time an order changes; it picks out wines,
matches each to its tower slot using `../toast-map.json`, and writes them to the live database:

- **Bottles** show under "Wines to pull" and the slot glows on every phone until someone taps **Got it**.
  Each new bottle also sends a lock-screen alert to every phone that turned alerts on (Manage > Phone alerts):
  "Heads up, Somm! Grab Caymus Cabernet for Table 12!" On Android the alert has its own **Got it** button.
- **Glasses** come off that wine's count as a share of a bottle (5 oz house pour = 0.2 of a 750). No pull alert.
- Every sale lands in **Manage > Review**. It counts right away; a manager can reject it to undo, and anything
  left there for 24 hours approves itself.

Phone alerts need no setup here: the relay makes its own signing key the first time it runs and keeps it, with the
list of signed-up phones, under `push/` in the database, which the rules keep private. It copies its address and
public key to `toast/status` so the site can find it.

Secrets (Cloudflare dashboard > the worker > Settings > Variables and Secrets):

| Name | Where it comes from |
| --- | --- |
| `TOAST_WEBHOOK_SECRET` | Toast Web > Integrations > Toast API access > Manage webhooks > the subscription's secret key |
| `FIREBASE_SECRET` | Firebase console > Project settings > Service accounts > Database secrets |
| `TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET` | Optional. Toast Standard API credentials, used for table names and to read the wine menu |

Endpoints: `POST /toast` (Toast webhook), `GET /` (health), `GET /refresh` (re-read tables and wine menu, at most every 5 minutes),
`POST /push/sub`, `/push/unsub`, `/push/test` and `GET /push/key` (phone alerts, called by the site).
