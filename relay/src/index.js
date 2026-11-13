// Wine Tower relay: Toast "order_updated" webhook -> bottle pulls in the Firebase live database.
// Bottles only. A Toast menu item counts as a tower bottle when toast-map.json maps it to a slot.

const TOAST_API = "https://ws-api.toasttab.com";
const KEEP_HOURS = 16;          // pulls older than this are cleared by the daily cleanup
const enc = new TextEncoder();
let MAP = null, MAP_AT = 0;     // cached slot map
let TABLES = null, TABLES_AT = 0;
let FB_TOKEN = null;            // cached service-account access token

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && (url.pathname === "/toast" || url.pathname === "/")) return await webhook(req, env);
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

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } }); }

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
async function webhook(req, env) {
  const body = await req.text();
  let msg; try { msg = JSON.parse(body); } catch (e) { return json({ error: "bad json" }, 400); }
  if (!env.TOAST_WEBHOOK_SECRET) return json({ error: "relay not configured" }, 503);
  const how = await verify(env.TOAST_WEBHOOK_SECRET, body, req.headers.get("Toast-Signature"), req.headers, msg);
  if (!how) { await status(env, { lastRejectAt: Date.now(), lastRejectType: String(msg && msg.eventType || "").slice(0, 40) }).catch(() => {}); return json({ error: "bad signature" }, 401); }
  const type = String(msg.eventType || msg.eventCategory || "");
  const details = msg.details || {};
  if (!/order_updated/.test(type) || !details.order) { await status(env, { lastEventAt: Date.now(), lastEventType: type.slice(0, 40), sig: how }); return json({ ok: true, ignored: type }); }
  const n = await handleOrder(env, details.order, details.restaurantGuid);
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
      const slots = slotsFor(map, sel);
      if (!slots || !slots.length) {
        if (!sel.voided && looksLikeBottle(map, sel)) {
          const k = (sel.item && sel.item.guid) || norm(sel.displayName).replace(/ /g, "_") || "unknown";
          unmatched["toast/unmatched/" + k] = { name: String(sel.displayName || "").slice(0, 120), item: (sel.item && sel.item.guid) || null, group: (sel.itemGroup && sel.itemGroup.guid) || null, last: Date.now() };
        }
        continue;
      }
      seen[sel.guid] = {
        slots: slots.slice(0, 6), name: String(sel.displayName || "").slice(0, 120), qty: Math.max(1, Math.round(+sel.quantity || 1)),
        check: String(check.displayNumber || "").slice(0, 20), tab: String(check.tabName || "").slice(0, 40), table: tableName.slice(0, 40),
        status: String(sel.fulfillmentStatus || ""), void: !!(orderGone || checkGone || sel.voided || sel.deleted),
        t: Date.parse(sel.createdDate) || Date.now(), order: order.guid
      };
    }
  }
  if (Object.keys(unmatched).length) await fb(env, "PATCH", "", unmatched);
  const prev = (await fb(env, "GET", "pulls", undefined, 'orderBy=%22order%22&equalTo=' + encodeURIComponent(JSON.stringify(order.guid)))) || {};
  const patch = {}, deltas = [];
  for (const id in prev) if (!seen[id] && !prev[id].void) { // removed from the check before it was paid
    patch["pulls/" + id + "/void"] = true;
    if (prev[id].dep) { patch["pulls/" + id + "/dep"] = 0; deltas.push([prev[id].slots, prev[id].dep, prev[id].name, id]); }
  }
  for (const id in seen) {
    const s = seen[id], p = prev[id];
    const want = map.deplete && !s.void ? s.qty : 0;
    if (!p) {
      if (s.void) continue; // never shown, never counted
      patch["pulls/" + id] = Object.assign({}, s, { dep: want, got: null });
      if (want) deltas.push([s.slots, -want, s.name, id]);
      continue;
    }
    for (const k of ["slots", "name", "qty", "check", "tab", "table", "status", "void"]) if (JSON.stringify(p[k]) !== JSON.stringify(s[k])) patch["pulls/" + id + "/" + k] = s[k];
    const had = p.dep || 0;
    if (want !== had) { patch["pulls/" + id + "/dep"] = want; deltas.push([s.slots, had - want, s.name, id]); }
  }
  if (deltas.length) {
    const { out, skipped } = await countChanges(env, deltas);
    Object.assign(patch, out);
    // a slot with no count yet is left alone, so nothing was taken off it to give back later
    for (const id of skipped) { if (patch["pulls/" + id]) patch["pulls/" + id].dep = 0; else patch["pulls/" + id + "/dep"] = 0; }
  }
  if (Object.keys(patch).length) await fb(env, "PATCH", "", patch);
  return Object.keys(seen).length;
}

// Bottles sold come off the tower count (and go back on if the bottle is voided).
// Slots linked to the same Bevager wine share one count, like on the site.
async function countChanges(env, deltas) {
  const slots = (await fb(env, "GET", "tower/state/slots")) || {}, out = {}, skipped = [], now = Date.now();
  for (const [list, delta, name, id] of deltas) {
    const first = list[0], s = slots[first];
    if (!s || s.c == null) { skipped.push(id); continue; } // not counted yet: leave it alone
    const group = s.w ? Object.keys(slots).filter(k => slots[k] && slots[k].w === s.w) : [first];
    const c = Math.max(0, Math.round((+s.c + delta) * 100) / 100);
    for (const k of group) { out["tower/state/slots/" + k + "/c"] = c; if (slots[k]) slots[k].c = c; }
    out["tower/log/" + now + "-" + Math.random().toString(36).slice(2, 8)] = { t: now, id: first, n: s.n || name, d: delta, src: "toast" };
  }
  if (Object.keys(out).length) out["tower/state/rev"] = now;
  return { out, skipped };
}

async function prune(env) {
  const old = (await fb(env, "GET", "pulls", undefined, 'orderBy=%22t%22&endAt=' + (Date.now() - KEEP_HOURS * 3600000) + "&limitToFirst=500")) || {};
  const patch = {}; for (const id in old) patch["pulls/" + id] = null;
  if (Object.keys(patch).length) await fb(env, "PATCH", "", patch);
  await status(env, { prunedAt: Date.now(), pruned: Object.keys(patch).length });
}
