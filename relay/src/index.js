// Wine Tower relay: Toast "order_updated" webhook -> bottle pulls and by-the-glass pours in the Firebase live database.
// A Toast menu item counts when toast-map.json maps it to a slot. A bottle shows as a pull until someone taps Got it.
// Every sale is written to tower/log as src "toast": the site takes it off the building count right away and lists it
// under Manage > Review, where a manager can reject it. A glass takes its pour as a share of a bottle (5 oz of a 750 = 0.2).
// Each new bottle also sends a lock-screen alert ("Heads up, Somm! Grab ... for Table 12!") to every phone that turned alerts on.

const TOAST_API = "https://ws-api.toasttab.com";
const KEEP_HOURS = 16;          // pulls older than this are cleared by the daily cleanup
const enc = new TextEncoder();
let MAP = null, MAP_AT = 0;     // cached slot map
let TABLES = null, TABLES_AT = 0;
let FB_TOKEN = null;            // cached service-account access token
let VAPID = null, ANNOUNCED = false; // phone-alert signing key, and whether the site has been told where this relay lives

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (!ANNOUNCED && env.FIREBASE_SECRET) later(ctx, announce(env, url.origin).catch(() => {}));
      if (url.pathname.startsWith("/push/")) return await pushRoute(req, env, url);
      if (req.method === "POST" && (url.pathname === "/toast" || url.pathname === "/")) return await webhook(req, env, ctx);
      if (req.method === "GET" && url.pathname === "/refresh") return json(await refresh(env, true));
      if (req.method === "GET" && url.pathname === "/") return json({
        ok: true, service: "Wine Tower relay",
        webhookSecret: !!env.TOAST_WEBHOOK_SECRET, firebase: !!env.FIREBASE_SECRET, toastApi: !!(env.TOAST_CLIENT_ID && env.TOAST_CLIENT_SECRET)
      });
      return json({ error: "not found" }, 404);
    } catch (e) {
      await status(env, { lastError: String(e && e.message || e).slice(0, 300), lastErrorAt: Date.now() }).catch(() => {});
      return json({ error: "relay error" }, 500);
    }
  },
  async scheduled(evt, env, ctx) {
    ctx.waitUntil((async () => { await prune(env); await refresh(env, false).catch(() => {}); })());
  }
};

function json(o, s = 200, h) { return new Response(JSON.stringify(o), { status: s, headers: Object.assign({ "content-type": "application/json" }, h) }); }
function later(ctx, p) { if (ctx && ctx.waitUntil) ctx.waitUntil(p); return p; }

/* ---------- Toast signature check ---------- */
function b64(buf) { let s = ""; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join(""); }
function unb64(s) { try { const bin = atob(s.trim()); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; } catch (e) { return null; } }
function same(a, b) { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function hmac(keyBytes, msg) { const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return crypto.subtle.sign("HMAC", k, enc.encode(msg)); }
// Toast signs body + timestamp with HMAC-SHA256. The docs leave the exact timestamp source open,
// so each plausible variant is tried; whichever matched is recorded in toast/status.
async function verify(secret, body, sig, headers, parsed) {
  if (!sig) return null;
  sig = sig.trim();
  const keys = [["raw", enc.encode(secret)]]; const kb = unb64(secret); if (kb && kb.length >= 16) keys.push(["b64", kb]);
  const ts = [["body.timestamp", parsed && parsed.timestamp || ""], ["header", headers.get("Toast-Timestamp") || headers.get("Toast-Request-Timestamp") || ""], ["none", ""]];
  for (const [kn, kv] of keys) for (const [tn, tv] of ts) {
    if (tn !== "none" && !tv) continue;
    const mac = await hmac(kv, body + tv);
    if (same(b64(mac), sig) || same(hex(mac), sig.toLowerCase())) return kn + "+" + tn;
  }
  return null;
}

/* ---------- Firebase REST ---------- */
async function fbAuth(env) {
  const s = (env.FIREBASE_SECRET || "").trim();
  if (!s) throw new Error("FIREBASE_SECRET is not set");
  if (!s.startsWith("{")) return "auth=" + encodeURIComponent(s);
  if (FB_TOKEN && Date.now() < FB_TOKEN.exp - 120000) return "access_token=" + FB_TOKEN.v;
  const sa = JSON.parse(s), now = Math.floor(Date.now() / 1000);
  const head = { alg: "RS256", typ: "JWT" }, claim = { iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  const u = o => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", unb64(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const data = u(head) + "." + u(claim), sig = b64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(data))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + data + "." + sig });
  if (!r.ok) throw new Error("Firebase service account sign-in failed (" + r.status + ")");
  const j = await r.json(); FB_TOKEN = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return "access_token=" + FB_TOKEN.v;
}
async function fb(env, method, path, body, query) {
  const url = env.FIREBASE_DB.replace(/\/+$/, "") + "/" + path + ".json?" + [await fbAuth(env), query].filter(Boolean).join("&");
  const r = await fetch(url, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error("Firebase " + method + " " + path + " failed (" + r.status + ")");
  return r.json();
}
function status(env, o) { return fb(env, "PATCH", "toast/status", o); }

/* ---------- slot map ---------- */
function norm(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").replace(/\b(btl|bottle|bot|bt)\b/g, " ").replace(/\s+/g, " ").trim();
}
async function loadMap(env) {
  if (MAP && Date.now() - MAP_AT < 120000) return MAP;
  try {
    const r = await fetch(env.MAP_URL + "?t=" + Math.floor(Date.now() / 120000), { cf: { cacheTtl: 60 } });
    if (r.ok) { const m = await r.json(); if (m && m.items) { MAP = m; MAP_AT = Date.now(); } }
  } catch (e) {}
  return MAP || { items: {}, names: {}, bottleGroups: [], deplete: false };
}
function entryFor(map, sel) {
  const g = sel.item && sel.item.guid;
  if (g && map.items && map.items[g]) return map.items[g];
  const n = norm(sel.displayName);
  if (n && map.names && map.names[n]) { const v = map.names[n]; return Array.isArray(v) ? { slots: v } : v; }
  return null;
}
// Glass or bottle? The map can say so per item (kind, oz). Otherwise the item and modifier names decide:
// "6 oz" / "9oz" is a glass of that size, "glass", "GL", "BTG", "pour" or "Coravin" is a glass of the house pour (5 oz),
// "bottle", "btl", "magnum" is a bottle. Anything else stays a bottle, as before.
const OZ_750 = 25.36;
function pourOf(map, entry, sel) {
  if (entry.kind === "bottle") return null;
  const words = [sel.displayName].concat((sel.modifiers || []).map(m => m && m.displayName)).filter(Boolean).join(" | ");
  const oz = words.match(/(\d+(?:\.\d+)?)\s*(?:oz|ounce)/i);
  const glassy = entry.kind === "glass" || /\b(glass|gls|gl|btg|pour|coravin)\b/i.test(words);
  const bottly = /\b(btl|bottle|magnum|mag|half bottle|375)\b/i.test(words);
  if (!oz && (!glassy || (bottly && entry.kind !== "glass"))) return null;
  const pour = oz ? +oz[1] : (+entry.oz || +map.pourOz || 5);
  const bottle = +entry.bottleOz || +map.bottleOz || OZ_750;
  return pour > 0 && pour < bottle ? { oz: pour, bottleOz: bottle } : null;
}
function slotsFor(map, sel) {
  const g = sel.item && sel.item.guid;
  if (g && map.items && map.items[g]) return map.items[g].slots || null;
  const n = norm(sel.displayName);
  if (n && map.names && map.names[n]) return map.names[n];
  return null;
}
function looksLikeBottle(map, sel) {
  const grp = sel.itemGroup && sel.itemGroup.guid;
  if (grp && (map.bottleGroups || []).includes(grp)) return true;
  return /\b(btl|bottle|magnum|mag|half bottle|375)\b/i.test(sel.displayName || "");
}

/* ---------- table names (needs the optional Toast API credentials) ---------- */
async function toastToken(env) {
  const r = await fetch(TOAST_API + "/authentication/v1/authentication/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: env.TOAST_CLIENT_ID, clientSecret: env.TOAST_CLIENT_SECRET, userAccessType: "TOAST_MACHINE_CLIENT" }) });
  if (!r.ok) throw new Error("Toast sign-in failed (" + r.status + ")");
  const j = await r.json(); return j.token && j.token.accessToken;
}
async function toastGet(env, token, rest, path) {
  const r = await fetch(TOAST_API + path, { headers: { Authorization: "Bearer " + token, "Toast-Restaurant-External-ID": rest } });
  if (!r.ok) throw new Error("Toast " + path + " failed (" + r.status + ")");
  return r.json();
}
async function tableNames(env) {
  if (TABLES && Date.now() - TABLES_AT < 600000) return TABLES;
  try { TABLES = (await fb(env, "GET", "toast/tables")) || {}; TABLES_AT = Date.now(); } catch (e) { TABLES = TABLES || {}; }
  return TABLES;
}
const WINEY = /wine|btl|bottle|champ|sparkl|bubbl|cellar|reserve|ros[eé]|red|white|magnum|half|large format|coravin|vino|vin\b/i;
async function refresh(env, manual) {
  if (!(env.TOAST_CLIENT_ID && env.TOAST_CLIENT_SECRET)) return { ok: false, reason: "Toast API credentials are not set, so table names and the wine menu can't be read." };
  const st = (await fb(env, "GET", "toast/status")) || {};
  if (manual && st.refreshedAt && Date.now() - st.refreshedAt < 300000) return { ok: false, reason: "Refreshed less than 5 minutes ago." };
  const rest = env.RESTAURANT_GUID || st.restaurant;
  if (!rest) return { ok: false, reason: "No restaurant yet. It is learned from the first Toast order alert." };
  const token = await toastToken(env);
  const tables = {}; for (const t of (await toastGet(env, token, rest, "/config/v2/tables")) || []) if (t && t.guid) tables[t.guid] = t.name || "";
  const menus = await toastGet(env, token, rest, "/menus/v2/menus");
  const groups = {}, items = {};
  const walk = (grps, path) => { for (const g of grps || []) { const p = path.concat(g.name || ""); const pn = p.join(" > ");
    if (WINEY.test(pn)) { groups[g.guid] = { name: pn.slice(0, 160) }; for (const it of g.menuItems || []) if (it && it.guid) items[it.guid] = { name: String(it.name || "").slice(0, 120), group: g.guid, price: it.price == null ? null : it.price }; }
    walk(g.menuGroups, p); } };
  for (const m of (menus && menus.menus) || []) walk(m.menuGroups, [m.name || ""]);
  await fb(env, "PUT", "toast/tables", tables); TABLES = tables; TABLES_AT = Date.now();
  await fb(env, "PUT", "toast/menu", { at: Date.now(), groups, items });
  await status(env, { refreshedAt: Date.now() });
  return { ok: true, tables: Object.keys(tables).length, wineGroups: Object.keys(groups).length, wineItems: Object.keys(items).length };
}

/* ---------- the webhook ---------- */
async function webhook(req, env, ctx) {
  const body = await req.text();
  let msg; try { msg = JSON.parse(body); } catch (e) { return json({ error: "bad json" }, 400); }
  if (!env.TOAST_WEBHOOK_SECRET) return json({ error: "relay not configured" }, 503);
  const how = await verify(env.TOAST_WEBHOOK_SECRET, body, req.headers.get("Toast-Signature"), req.headers, msg);
  if (!how) { await status(env, { lastRejectAt: Date.now(), lastRejectType: String(msg && msg.eventType || "").slice(0, 40) }).catch(() => {}); return json({ error: "bad signature" }, 401); }
  const type = String(msg.eventType || msg.eventCategory || "");
  const details = msg.details || {};
  if (!/order_updated/.test(type) || !details.order) { await status(env, { lastEventAt: Date.now(), lastEventType: type.slice(0, 40), sig: how }); return json({ ok: true, ignored: type }); }
  const { n, fresh } = await handleOrder(env, details.order, details.restaurantGuid);
  if (fresh.length) await later(ctx, alertPulls(env, fresh).catch(e => status(env, { lastAlertError: String(e && e.message || e).slice(0, 200), lastAlertAt: Date.now() }).catch(() => {})));
  await status(env, { lastEventAt: Date.now(), lastEventType: type.slice(0, 40), sig: how, restaurant: details.restaurantGuid || null, lastPulls: n });
  return json({ ok: true, pulls: n });
}

async function handleOrder(env, order, restaurant) {
  const map = await loadMap(env);
  const orderGone = !!(order.voided || order.deleted);
  const tables = order.table && order.table.guid ? await tableNames(env) : {};
  const tableName = order.table && order.table.guid ? (tables[order.table.guid] || "") : "";
  const seen = {}, unmatched = {};
  for (const check of order.checks || []) {
    const checkGone = !!(check.voided || check.deleted);
    for (const sel of check.selections || []) {
      if (!sel || !sel.guid) continue;
      const entry = entryFor(map, sel), slots = entry && entry.slots;
      if (!slots || !slots.length) {
        if (!sel.voided && (looksLikeBottle(map, sel) || /\b(glass|gls|btg|\d+\s*oz)\b/i.test(sel.displayName || ""))) {
          const k = (sel.item && sel.item.guid) || norm(sel.displayName).replace(/ /g, "_") || "unknown";
          unmatched["toast/unmatched/" + k] = { name: String(sel.displayName || "").slice(0, 120), item: (sel.item && sel.item.guid) || null, group: (sel.itemGroup && sel.itemGroup.guid) || null, last: Date.now() };
        }
        continue;
      }
      const pour = pourOf(map, entry, sel);
      seen[sel.guid] = {
        slots: slots.slice(0, 6), name: String(sel.displayName || "").slice(0, 120), qty: Math.max(1, Math.round(+sel.quantity || 1)),
        pour: pour ? pour.oz : null, bottleOz: pour ? pour.bottleOz : null,
        check: String(check.displayNumber || "").slice(0, 20), tab: String(check.tabName || "").slice(0, 40), table: tableName.slice(0, 40),
        status: String(sel.fulfillmentStatus || ""), void: !!(orderGone || checkGone || sel.voided || sel.deleted),
        t: Date.parse(sel.createdDate) || Date.now(), order: order.guid
      };
    }
  }
  if (Object.keys(unmatched).length) await fb(env, "PATCH", "", unmatched);
  const prev = (await fb(env, "GET", "pulls", undefined, 'orderBy=%22order%22&equalTo=' + encodeURIComponent(JSON.stringify(order.guid)))) || {};
  const patch = {}, deltas = [], fresh = []; // deltas: [selection, log key, wanted amount, amount logged before, pull id]
  for (const id in prev) if (!seen[id] && !prev[id].void) { // removed from the check before it was paid
    patch["pulls/" + id + "/void"] = true;
    if (prev[id].dep) { patch["pulls/" + id + "/dep"] = 0; deltas.push([prev[id], prev[id].lk || logKey(prev[id], id), 0, prev[id].dep, id]); }
  }
  for (const id in seen) {
    const s = seen[id], p = prev[id];
    const on = s.pour ? (map.depleteGlasses == null ? map.deplete : map.depleteGlasses) : map.deplete;
    const want = on && !s.void ? (s.pour ? Math.round(s.qty * s.pour / s.bottleOz * 10000) / 10000 : s.qty) : 0;
    if (!p) {
      if (s.void) continue; // never shown, never counted
      const lk = logKey(s, id);
      patch["pulls/" + id] = Object.assign({}, s, { dep: want, got: null, lk });
      if (want) deltas.push([s, lk, want, 0, id]);
      if (!s.pour && Date.now() - s.t < ALERT_FRESH_MS) fresh.push({ id, s }); // a bottle someone has to go get
      continue;
    }
    for (const k of ["slots", "name", "qty", "pour", "bottleOz", "check", "tab", "table", "status", "void"]) if (JSON.stringify(p[k]) !== JSON.stringify(s[k])) patch["pulls/" + id + "/" + k] = s[k];
    const had = p.dep || 0;
    if (p.rej) continue; // a manager rejected this sale in Review
    if (want !== had) { const lk = p.lk || logKey(s, id); patch["pulls/" + id + "/dep"] = want; patch["pulls/" + id + "/lk"] = lk; deltas.push([s, lk, want, had, id]); }
  }
  for (const [s, lk, want, had, id] of deltas) {
    if (want > 0 && had > 0) { // already logged once: if a manager rejected it, leave it out
      const cur = await fb(env, "GET", "tower/log/" + lk).catch(() => null);
      if (cur == null) { setDep(patch, id, had, true); continue; }
    }
    patch["tower/log/" + lk] = want > 0 ? logEntry(s, want) : null;
  }
  if (Object.keys(patch).length) await fb(env, "PATCH", "", patch);
  return { n: Object.keys(seen).length, fresh };
}

// One tower/log entry per Toast selection; its key stays the same as the quantity changes, so it is rewritten, not added again.
function logKey(s, id) { return (s.t || Date.now()) + "-t" + String(id).replace(/[^A-Za-z0-9]/g, "").slice(0, 10); }
function logEntry(s, amount) {
  const e = { t: s.t || Date.now(), id: s.slots[0], n: s.name, d: -amount, src: "toast", q: s.qty };
  if (s.pour) e.oz = s.pour; if (s.check) e.chk = s.check; if (s.table) e.tbl = s.table;
  return e;
}
function setDep(patch, id, v, rej) { const p = patch["pulls/" + id]; if (p) { p.dep = v; if (rej) p.rej = true; } else { patch["pulls/" + id + "/dep"] = v; if (rej) patch["pulls/" + id + "/rej"] = true; } }

async function prune(env) {
  const old = (await fb(env, "GET", "pulls", undefined, 'orderBy=%22t%22&endAt=' + (Date.now() - KEEP_HOURS * 3600000) + "&limitToFirst=500")) || {};
  const patch = {}; for (const id in old) patch["pulls/" + id] = null;
  if (Object.keys(patch).length) await fb(env, "PATCH", "", patch);
  await status(env, { prunedAt: Date.now(), pruned: Object.keys(patch).length });
}

/* ---------- phone alerts: Web Push (RFC 8291 message encryption, RFC 8292 VAPID) ----------
   Phones subscribe from the site (Manage > Phone alerts). Subscriptions and the signing key live under push/,
   which the database rules keep private; only this relay reads them. The public key and this relay's address
   are copied to toast/status so the site can find them. */
const ALERT_FRESH_MS = 30 * 60000;  // don't alert for bottles rung in more than 30 minutes ago (e.g. old orders when the relay first starts)
const MAX_SUBS = 60;
const PUSH_HOST = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/i;
const SITE = "https://tocamaderawine.github.io";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };

function b64u(buf) { return b64(buf).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"); }
function unb64u(s) { s = String(s || "").replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return unb64(s); }
function cat(...parts) { const o = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of parts) { o.set(x, i); i += x.length; } return o; }
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
async function encryptPush(sub, text) {
  const ua = unb64u(sub.p256dh), auth = unb64u(sub.auth);
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(enc.encode("WebPush: info\0"), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(enc.encode(text), new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt, 0); new DataView(head.buffer).setUint32(16, 4096); head[20] = asPub.length;
  return cat(head, asPub, ct);
}
async function fbPutIfEmpty(env, path, val) { // conditional write, so two first requests can't each make a different key
  const url = env.FIREBASE_DB.replace(/\/+$/, "") + "/" + path + ".json?" + await fbAuth(env);
  const g = await fetch(url, { headers: { "X-Firebase-ETag": "true" } });
  if (!g.ok) throw new Error("Firebase GET " + path + " failed (" + g.status + ")");
  if ((await g.json()) != null) return false;
  const r = await fetch(url, { method: "PUT", headers: { "content-type": "application/json", "if-match": g.headers.get("ETag") || "" }, body: JSON.stringify(val) });
  if (r.status === 412) return false;
  if (!r.ok) throw new Error("Firebase PUT " + path + " failed (" + r.status + ")");
  return true;
}
async function vapid(env) {
  if (VAPID) return VAPID;
  let v = await fb(env, "GET", "push/vapid");
  if (!v || !v.jwk || !v.pub) {
    const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const j = await crypto.subtle.exportKey("jwk", k.privateKey);
    const nv = { jwk: { kty: "EC", crv: "P-256", d: j.d, x: j.x, y: j.y }, pub: b64u(await crypto.subtle.exportKey("raw", k.publicKey)), at: Date.now() };
    v = (await fbPutIfEmpty(env, "push/vapid", nv)) ? nv : await fb(env, "GET", "push/vapid");
  }
  v.key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  VAPID = v; return v;
}
async function announce(env, origin) {
  const v = await vapid(env);
  await status(env, { relay: origin, vapid: v.pub });
  ANNOUNCED = true;
}
async function vapidAuth(v, endpoint) {
  const u = o => b64u(enc.encode(JSON.stringify(o)));
  const data = u({ typ: "JWT", alg: "ES256" }) + "." + u({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE });
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.key, enc.encode(data));
  return "vapid t=" + data + "." + b64u(sig) + ", k=" + v.pub;
}
async function sendPush(v, sub, msg) {
  const body = await encryptPush(sub, JSON.stringify(msg));
  const r = await fetch(sub.endpoint, { method: "POST", body, headers: {
    Authorization: await vapidAuth(v, sub.endpoint), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "900", Urgency: "high" } });
  return r.status;
}
async function subKey(endpoint) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(endpoint))).slice(0, 24); }
function cleanSub(o) {
  const s = o && (o.sub || o) || {}, k = s.keys || {};
  let u; try { u = new URL(String(s.endpoint || "")); } catch (e) { return null; }
  if (u.protocol !== "https:" || !PUSH_HOST.test(u.hostname) || u.href.length > 1000) return null;
  const ua = unb64u(k.p256dh || ""), au = unb64u(k.auth || "");
  if (!ua || ua.length !== 65 || ua[0] !== 4 || !au || au.length < 16 || au.length > 32) return null;
  return { endpoint: u.href, p256dh: String(k.p256dh), auth: String(k.auth), dev: String(o.dev || "").slice(0, 40) };
}
async function pushRoute(req, env, url) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!env.FIREBASE_SECRET) return json({ error: "relay not configured" }, 503, CORS);
  if (req.method === "GET" && url.pathname === "/push/key") return json({ key: (await vapid(env)).pub }, 200, CORS);
  if (req.method !== "POST") return json({ error: "not found" }, 404, CORS);
  let o; try { o = JSON.parse(await req.text()); } catch (e) { return json({ error: "bad json" }, 400, CORS); }
  const ep = String(o && (o.endpoint || (o.sub && o.sub.endpoint)) || "");
  if (url.pathname === "/push/sub") {
    const s = cleanSub(o); if (!s) return json({ error: "not a push subscription" }, 400, CORS);
    const k = await subKey(s.endpoint), now = Date.now(), all = (await fb(env, "GET", "push/subs")) || {};
    const patch = { ["push/subs/" + k]: Object.assign(s, { since: (all[k] && all[k].since) || now, seen: now }) };
    const others = Object.keys(all).filter(x => x !== k).sort((a, b) => (all[b].seen || 0) - (all[a].seen || 0));
    for (const x of others.slice(MAX_SUBS - 1)) patch["push/subs/" + x] = null; // keep the phones seen most recently
    await fb(env, "PATCH", "", patch);
    return json({ ok: true, key: (await vapid(env)).pub }, 200, CORS);
  }
  if (url.pathname === "/push/unsub") {
    if (ep) await fb(env, "DELETE", "push/subs/" + await subKey(ep));
    return json({ ok: true }, 200, CORS);
  }
  if (url.pathname === "/push/test") {
    const k = ep && await subKey(ep), s = k && await fb(env, "GET", "push/subs/" + k);
    if (!s) return json({ error: "this phone isn't signed up" }, 404, CORS);
    if (s.lastTest && Date.now() - s.lastTest < 15000) return json({ error: "wait a few seconds" }, 429, CORS);
    await fb(env, "PATCH", "push/subs/" + k, { lastTest: Date.now() });
    const st = await sendPush(await vapid(env), s, { title: "Heads up, Somm!", body: "Alerts are on. This is what a bottle order from Toast looks like.", tag: "test", url: "./" });
    if (st === 404 || st === 410) await fb(env, "DELETE", "push/subs/" + k);
    return json({ ok: st >= 200 && st < 300, status: st }, 200, CORS);
  }
  return json({ error: "not found" }, 404, CORS);
}
function where(s) {
  const t = String(s.table || "").trim();
  if (t) return /^table\b/i.test(t) ? t : /^\d+[a-z]?$/i.test(t) ? "Table " + t : t;
  if (s.tab) return s.tab;
  return s.check ? "check #" + s.check : "";
}
function pullAlert(env, id, s, wine) {
  wine = String(wine || s.name || "a bottle").trim();
  const what = s.qty > 1 ? s.qty + " bottles of " + wine : wine, to = where(s);
  return { title: "Heads up, Somm!", body: "Grab " + what + (to ? " for " + to : "") + "!\nSlot " + s.slots.join(" / ") + (s.status === "HOLD" ? " · on hold" : ""),
    tag: "pull-" + id, id, slot: s.slots[0], db: env.FIREBASE_DB.replace(/\/+$/, ""), url: "./?pull=" + encodeURIComponent(s.slots[0]) };
}
async function alertPulls(env, fresh) {
  const subs = (await fb(env, "GET", "push/subs")) || {}, ks = Object.keys(subs);
  if (!ks.length) return;
  const v = await vapid(env);
  const names = await Promise.all(fresh.map(f => fb(env, "GET", "tower/state/slots/" + encodeURIComponent(f.s.slots[0]) + "/n").catch(() => null)));
  const gone = {}; let sent = 0, failed = 0, lastFail = null;
  for (let i = 0; i < fresh.length && i < 6; i++) {
    const msg = pullAlert(env, fresh[i].id, fresh[i].s, names[i]);
    await Promise.all(ks.map(async k => {
      const st = await sendPush(v, subs[k], msg).catch(() => 0);
      if (st === 404 || st === 410) gone["push/subs/" + k] = null; else if (st >= 200 && st < 300) sent++; else { failed++; lastFail = st; }
    }));
  }
  if (Object.keys(gone).length) await fb(env, "PATCH", "", gone);
  await status(env, { lastAlertAt: Date.now(), alertsSent: sent, alertsFailed: failed, lastAlertFail: lastFail, alertPhones: ks.length - Object.keys(gone).length });
}
