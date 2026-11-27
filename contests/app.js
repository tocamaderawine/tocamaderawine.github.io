"use strict";
/* Toca Madera Contests. Same live database and manager logins as the Wine Tower (../config.js).
   Everyone can read /contests; only the tower's owner and approved editors can change it (see ../firebase-rules.json). */
(function () {
const L = window.CL;
const FBC = window.FB || {};
const MOCK = window.CONTEST_MOCK || null;          // tests swap the database for an in-memory one
const LSK = "toca-tower-v1-fb";                    // the tower's saved login: one sign-in covers both
const LSP = "toca-contests-v1";
const SV = { ".sv": "timestamp" };
const ROLES = [["server", "Server", "Servers"], ["bartender", "Bartender", "Bartenders"], ["barback", "Barback", "Barbacks"], ["backserver", "Backserver", "Backservers"], ["host", "Host", "Hosts"], ["other", "Other", "Other"]];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const TROPHY = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#D6BE8C" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0V4z"/><path d="M8 6H5v1a3 3 0 0 0 3 3M16 6h3v1a3 3 0 0 1-3 3M12 13v4M8.5 20h7M10 17h4"/></svg>';

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
const roleName = r => (ROLES.find(x => x[0] === r) || [0, "Staff"])[1];
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);
const now = () => Date.now();

const S = { tree: {}, got: false, conn: "connecting", user: null, tok: "", exp: 0, role: "viewer", admin: { req: {}, ed: {} }, poll: null, view: null,
  lg: { c: null, s: null, q: 1, role: "all", busy: false }, ro: { role: "server" }, toastT: null };
let P = {}; try { P = JSON.parse(localStorage.getItem(LSP) || "{}") || {}; } catch (e) {}
function saveP() { try { localStorage.setItem(LSP, JSON.stringify(P)); } catch (e) {} }

/* ---------- database ---------- */
function setPath(box, segs, val) {
  if (!segs.length) { box.v = val; return; }
  if (box.v == null || typeof box.v !== "object") box.v = {};
  let o = box.v;
  for (let i = 0; i < segs.length - 1; i++) { if (o[segs[i]] == null || typeof o[segs[i]] !== "object") o[segs[i]] = {}; o = o[segs[i]]; }
  const k = segs[segs.length - 1];
  if (val === null || val === undefined) delete o[k]; else o[k] = val;
}
function delta(box, msg, patch) {
  const base = String(msg.path || "/").split("/").filter(Boolean);
  if (patch && msg.data && typeof msg.data === "object") for (const k in msg.data) setPath(box, base.concat(k.split("/").filter(Boolean)), msg.data[k]);
  else setPath(box, base, msg.data);
}
const AUTH_ERR = { INVALID_LOGIN_CREDENTIALS: "That email and password don't match.", EMAIL_NOT_FOUND: "That email and password don't match.", INVALID_PASSWORD: "That email and password don't match.", INVALID_EMAIL: "That doesn't look like an email address.", USER_DISABLED: "This login has been switched off.", TOO_MANY_ATTEMPTS_TRY_LATER: "Too many tries. Wait a few minutes and try again." };
const REAL = {
  url(path, tok) { return String(FBC.db || "").replace(/\/+$/, "") + "/" + path + ".json" + (tok ? "?auth=" + encodeURIComponent(tok) : ""); },
  async req(method, path, body, tok) {
    const r = await fetch(this.url(path, tok), { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw { status: r.status };
    return r.json();
  },
  listen(onData, onConn) {
    const box = { v: null }; let es = null, retry = null;
    const open = () => {
      try { es = new EventSource(this.url("contests")); } catch (e) { onConn("down"); return; }
      const on = patch => e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (!m) return; delta(box, m, patch); onData(box.v || {}); };
      es.addEventListener("put", on(false)); es.addEventListener("patch", on(true));
      es.addEventListener("cancel", () => { onConn("denied"); es.close(); clearTimeout(retry); retry = setTimeout(open, 30000); });
      es.onopen = () => onConn("live");
      es.onerror = () => { if (es.readyState === 2) { onConn("down"); clearTimeout(retry); retry = setTimeout(open, 5000); } else onConn("connecting"); };
    };
    open();
  },
  async signIn(email, pw) {
    let r, j;
    try { r = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + encodeURIComponent(FBC.apiKey), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pw, returnSecureToken: true }) }); j = await r.json(); }
    catch (e) { throw new Error("Couldn't reach the sign-in service. Check your connection."); }
    if (!r.ok) { const code = String(j && j.error && j.error.message || "").split(" ")[0]; throw new Error(AUTH_ERR[code] || "Sign-in failed. Try again."); }
    return { uid: j.localId, email: j.email || email, rt: j.refreshToken, tok: j.idToken, exp: Date.now() + (+j.expiresIn || 3600) * 1000 };
  },
  async refresh(rt) {
    const r = await fetch("https://securetoken.googleapis.com/v1/token?key=" + encodeURIComponent(FBC.apiKey), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(rt) });
    if (!r.ok) throw { status: r.status };
    const j = await r.json();
    return { tok: j.id_token, exp: Date.now() + (+j.expires_in || 3600) * 1000, rt: j.refresh_token };
  }
};
const api = MOCK ? MOCK.api : REAL;

/* ---------- sign-in and roles (same rules as the tower: owner + editors the owner approved) ---------- */
function loadUser() { try { const u = JSON.parse(localStorage.getItem(LSK) || "null"); if (u && u.rt && u.uid) S.user = { rt: u.rt, uid: u.uid, email: u.email || "" }; } catch (e) {} }
function saveUser() { try { if (S.user) localStorage.setItem(LSK, JSON.stringify({ rt: S.user.rt, uid: S.user.uid, email: S.user.email })); else localStorage.removeItem(LSK); } catch (e) {} }
async function token() {
  if (!S.user) throw { status: 401 };
  if (S.tok && now() < S.exp - 60000) return S.tok;
  let r;
  try { r = await api.refresh(S.user.rt); }
  catch (e) { if (e && (e.status === 400 || e.status === 401 || e.status === 403)) { signOut(); throw { status: 401 }; } throw { net: true }; }
  S.tok = r.tok; S.exp = r.exp; if (r.rt && r.rt !== S.user.rt) { S.user.rt = r.rt; saveUser(); }
  return S.tok;
}
async function req(method, path, body) { const tok = await token(); return api.req(method, path, body, tok); }
const isMgr = () => !!S.user && (S.role === "owner" || S.role === "editor");
const uid = () => S.user && S.user.uid;
async function checkRole() {
  if (!S.user) { S.role = "viewer"; render(); return; }
  const me = S.user.uid; let role = null;
  try {
    const owner = await api.req("GET", "owner");
    if (owner === me) role = "owner";
    else {
      const ed = await req("GET", "editors/" + me).catch(e => { if (e && e.net) throw e; return null; });
      if (ed) role = "editor";
      else { role = "pending"; try { await req("PUT", "requests/" + me, { email: String(S.user.email).slice(0, 100), t: Date.now() }); } catch (e) {} }
    }
  } catch (e) { role = (P.roles || {})[me] || "pending"; }
  if (!S.user || S.user.uid !== me) return;
  S.role = role; P.roles = { [me]: role }; saveP();
  clearInterval(S.poll); S.poll = null;
  if (role === "pending") S.poll = setInterval(checkRole, 30000);
  if (role === "owner") { loadAdmin(); S.poll = setInterval(loadAdmin, 30000); }
  render(); if (sheetKind === "acct") openAcct();
}
async function loadAdmin() {
  if (S.role !== "owner") return;
  try { const [rq, ed] = await Promise.all([req("GET", "requests"), req("GET", "editors")]); S.admin = { req: rq || {}, ed: ed || {} }; const box = $("ac-adm"); if (box) box.innerHTML = adminHtml(); } catch (e) {}
}
function signOut() {
  S.user = null; S.tok = ""; S.exp = 0; S.role = "viewer"; S.admin = { req: {}, ed: {} };
  clearInterval(S.poll); S.poll = null; saveUser(); render();
}
function errMsg(e) {
  const s = e && e.status;
  if (s === 401 || s === 403) return S.user ? "Not saved. This login can't make changes here." : "Not saved. Sign in first.";
  if (s) return "Not saved (error " + s + "). Try again.";
  return "Not saved. No connection. Try again.";
}
async function save(method, path, body) { try { await req(method, path, body); return true; } catch (e) { toast(errMsg(e), { err: true }); return false; } }

/* ---------- data helpers ---------- */
const T = () => S.tree || {};
const roster = () => T().roster || {};
const contests = () => T().list || {};
const entries = () => T().entries || {};
const jackpots = () => T().jackpots || {};
const draws = g => (T().draws || {})[g] || null;
const myName = () => { const m = (T().mgr || {})[uid()]; return m && m.n || ""; };
const mgrName = id => { const m = (T().mgr || {})[id]; return m && m.n || "a manager"; };
const staffName = sid => { const r = roster()[sid]; return r && r.n || "(removed)"; };
const activeRoster = () => L.rows(roster()).filter(r => r.on !== false).sort((a, b) => norm(a.n).localeCompare(norm(b.n)));
const qtyOf = e => (+e.q >= 1 ? Math.floor(+e.q) : 1);
function contestModel(k) {
  const c = contests()[k]; if (!c) return null;
  const g = "c_" + k, draw = L.currentDraw(draws(g)), tally = L.contestTally(entries(), k, roster());
  return Object.assign({}, c, { k, g, kind: "c", draw, voided: L.voidedDraws(draws(g)), tally, tk: L.total(tally), st: L.contestStatus(c, now(), draw) });
}
function jackpotModel(k) {
  const j = jackpots()[k]; if (!j) return null;
  const g = "j_" + k, draw = L.currentDraw(draws(g)), tally = L.jackpotTally(entries(), j, roster());
  return Object.assign({}, j, { k, g, kind: "j", m: "lottery", draw, voided: L.voidedDraws(draws(g)), tally, tk: L.total(tally), st: L.contestStatus(j, now(), draw) });
}
const allContests = () => Object.keys(contests()).map(contestModel).filter(Boolean);
const allJackpots = () => Object.keys(jackpots()).map(jackpotModel).filter(Boolean);
function jackpotNow() { const t = now(); return allJackpots().filter(j => !j.draw && t >= L.dayStart(j.s) && t <= L.dayEnd(j.e)).sort((a, b) => a.e < b.e ? -1 : 1)[0] || null; }
function entryLocked(e) {
  if (L.currentDraw(draws("c_" + e.c))) return true;
  const js = jackpots();
  for (const k in js) { const j = js[k]; if (j && e.t >= L.dayStart(j.s) && e.t <= L.dayEnd(j.e) && L.currentDraw(draws("j_" + k))) return true; }
  return false;
}

/* ---------- formatting ---------- */
const TF = new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const TT = new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", hour: "numeric", minute: "2-digit" });
function fmtDay(ymd) { const [y, m, d] = String(ymd).split("-").map(Number); if (!m) return ""; const cy = +L.azToday(now()).slice(0, 4); return MON[m - 1] + " " + d + (y !== cy ? ", " + y : ""); }
const fmtRange = (s, e) => s === e ? fmtDay(s) : fmtDay(s) + " – " + fmtDay(e);
const fmtWhen = ms => (typeof ms !== "number" ? "" : L.azToday(ms) === L.azToday(now()) ? "Today " + TT.format(ms) : TF.format(ms));
function pct(n, tk) { if (!tk) return ""; const p = n / tk * 100; return p >= 99.5 ? "100%" : p >= 10 ? Math.round(p) + "%" : p >= 1 ? p.toFixed(1).replace(/\.0$/, "") + "%" : "<1%"; }
function leftText(m) {
  if (m.st === "upcoming") return "Starts " + fmtDay(m.s);
  if (m.st === "active") { const d = Math.round((L.dayStart(m.e) - L.dayStart(L.azToday(now()))) / 86400000); return d <= 0 ? "Ends tonight" : d === 1 ? "Ends tomorrow" : d + " days left"; }
  if (m.st === "ended") return "Ended " + fmtDay(m.e) + ". Ready to draw";
  return "Finished";
}
const BADGE = { active: '<span class="badge live">Live</span>', upcoming: '<span class="badge">Soon</span>', ended: '<span class="badge draw">Draw</span>', done: '<span class="badge done">Done</span>' };
const unit = m => m.m === "most" ? ["entry", "entries"] : ["ticket", "tickets"];
const modeText = m => m.m === "most" ? "Most entries wins" : "Lottery";
const MODE_HINT = { lottery: "Every entry is a ticket in the draw. More entries, better odds, but anyone with an entry can win.", most: "Whoever has the most entries wins. A tie is settled by a random draw among the tied." };

function board(m, limit) {
  if (!m.tally.length) return '<p class="note" style="margin-top:10px">No entries yet.</p>';
  const rows = limit ? m.tally.slice(0, limit) : m.tally, top = m.tally[0].n, lot = m.m !== "most";
  let rank = 0, prev = null;
  const h = rows.map((r, i) => {
    if (r.n !== prev) { rank = i + 1; prev = r.n; }
    const st = roster()[r.s];
    return `<div class="lr"><span class="rk">${rank}</span><div class="nmx">${esc(staffName(r.s))}<small>${esc(st ? roleName(st.r) : "")}</small><div class="bar"><i style="width:${Math.max(4, Math.round(r.n / top * 100))}%"></i></div></div><span class="n">${r.n}</span>${lot ? `<span class="od">${pct(r.n, m.tk)}</span>` : ""}</div>`;
  }).join("");
  const more = limit && m.tally.length > limit ? `<div class="note" style="padding-top:8px">+ ${plural(m.tally.length - limit, "more person", "more people")}</div>` : "";
  return `<div class="lb">${h}${more}</div>`;
}
function winBlock(m) {
  const d = m.draw; if (!d) return "";
  const u = unit(m);
  return `<div class="win">${TROPHY}<div><small>${m.kind === "j" ? "Jackpot winner" : "Winner"}</small><b>${esc(staffName(d.w))}</b><small>Drawn ${esc(fmtWhen(d.t))} by ${esc(mgrName(d.by))} · ${plural(d.tk, u[0], u[1])} from ${plural(d.pool || 0, "person", "people")}${d.tie ? ` · ${d.tie}-way tie settled by random draw` : ""}</small></div></div>`;
}

/* ---------- sheet, confirm, toast ---------- */
let sheetKind = null, sheetRefresh = null;
function openSheet(html, kind, refresh) {
  const sh = $("sheet"), box = sh.querySelector(".in"), same = sheetKind && sheetKind === kind && !sh.hidden, top = box.scrollTop;
  box.innerHTML = html; sh.hidden = false; sheetKind = kind || "x"; sheetRefresh = refresh || null;
  box.scrollTop = same ? top : 0; document.body.style.overflow = "hidden";
}
function closeSheet() { $("sheet").hidden = true; sheetKind = null; sheetRefresh = null; document.body.style.overflow = ""; }
const sheetTop = t => `<div class="top"><h2>${esc(t)}</h2><button type="button" class="x" data-act="close" aria-label="Close">×</button></div>`;
function confirmSheet(title, bodyHtml, okLabel, onOk, danger) {
  openSheet(sheetTop(title) + `<p class="note" style="font-size:15px;margin-top:8px">${bodyHtml}</p><div class="acts"><button type="button" class="btn" data-act="close">Cancel</button><button type="button" class="btn ${danger ? "danger" : "gold"}" id="cf-ok">${esc(okLabel)}</button></div>`, "confirm");
  $("cf-ok").onclick = async () => { $("cf-ok").disabled = true; await onOk(); };
}
function toast(msg, o) {
  o = o || {};
  const t = $("toast"), b = t.querySelector("button");
  t.querySelector("span").textContent = msg;
  if (o.undo) { b.hidden = false; b.textContent = "Undo"; b.onclick = () => { hideToast(); o.undo(); }; } else { b.hidden = true; b.onclick = null; }
  t.classList.toggle("err", !!o.err); t.hidden = false;
  clearTimeout(S.toastT); S.toastT = setTimeout(hideToast, o.undo ? 8000 : o.err ? 6000 : 3500);
}
function hideToast() { $("toast").hidden = true; }

/* ---------- render ---------- */
function render() {
  const mgr = isMgr(), views = mgr ? ["log", "contests", "jackpot", "roster"] : ["contests", "jackpot"];
  if (!S.view || !views.includes(S.view)) S.view = P.view && views.includes(P.view) ? P.view : views[0];
  document.querySelectorAll("#nav button").forEach(b => { b.hidden = !views.includes(b.dataset.v); b.setAttribute("aria-selected", b.dataset.v === S.view); });
  document.querySelectorAll(".view").forEach(s => s.classList.toggle("on", s.id === "v-" + S.view));
  const a = $("acct");
  a.textContent = !S.user ? "Manager sign in" : S.role === "pending" ? "Waiting for approval" : myName() || String(S.user.email).split("@")[0];
  const lv = $("live"), txt = { live: "Live", connecting: S.got ? "Reconnecting…" : "Connecting…", down: "Offline. Changes won't save.", denied: "Contests aren't switched on in the database yet." }[S.conn];
  lv.className = S.conn === "live" ? "on" : S.conn === "connecting" ? "" : "bad"; lv.querySelector("span").textContent = txt;
  ({ log: renderLog, contests: renderContests, jackpot: renderJackpot, roster: renderRoster })[S.view]();
  if (sheetRefresh) sheetRefresh();
}
const loading = () => `<div class="empty" style="margin-top:14px">${S.conn === "denied" ? "Contests aren't switched on in the database yet." : "Loading…"}</div>`;

/* Log */
function activeContestList() { return allContests().filter(c => c.st === "active").sort((a, b) => a.e < b.e ? -1 : a.e > b.e ? 1 : norm(a.n).localeCompare(norm(b.n))); }
function renderLog() {
  $("lg-form").hidden = !S.got;
  $("lg-gate").innerHTML = S.got ? "" : loading();
  $("lg-banner").innerHTML = S.got && isMgr() && !myName() ? `<div class="banner"><span>Add your name so entries show who logged them.</span><button type="button" class="btn gold" data-act="acct">Add name</button></div>` : "";
  if (!S.got) return;
  const act = activeContestList();
  if (!act.some(c => c.k === S.lg.c)) S.lg.c = act.some(c => c.k === P.lc) ? P.lc : act[0] ? act[0].k : null;
  $("lg-contests").innerHTML = act.length
    ? act.map(c => `<button type="button" class="chip" data-act="lg-c" data-k="${esc(c.k)}" aria-pressed="${c.k === S.lg.c}">${esc(c.n)}<b>${c.tk}</b></button>`).join("")
    : `<div class="empty" style="width:100%">No contests running today.<br><button type="button" class="btn gold" data-act="ct-new">+ New contest</button></div>`;
  const rs = activeRoster(), present = ROLES.filter(r => rs.some(x => x.r === r[0]));
  if (S.lg.role !== "all" && !present.some(r => r[0] === S.lg.role)) S.lg.role = "all";
  $("lg-roles").innerHTML = present.length > 1 ? [["all", "All", "All"]].concat(present).map(r => `<button type="button" class="chip sm" data-act="lg-role" data-r="${r[0]}" aria-pressed="${S.lg.role === r[0]}">${r[2]}</button>`).join("") : "";
  renderNames();
  $("lg-q").textContent = S.lg.q;
  const rec = L.rows(entries()).filter(e => typeof e.t === "number").sort((a, b) => b.t - a.t).slice(0, 25);
  $("lg-count").textContent = rec.length ? "latest " + rec.length : "";
  $("lg-recent").innerHTML = rec.length ? rec.map(e => entryRow(e, true)).join("") : '<p class="note">Nothing logged yet.</p>';
  updateAddBtn();
}
function renderNames() {
  const q = norm($("lg-search").value), rs = activeRoster();
  if (S.lg.pick && rs.some(r => r.k === S.lg.pick)) { S.lg.s = S.lg.pick; S.lg.pick = null; }   // someone just added from the Log tab
  if (S.lg.s && !rs.some(r => r.k === S.lg.s)) S.lg.s = null;
  let list = rs.filter(r => (S.lg.role === "all" || r.r === S.lg.role) && (!q || norm(r.n).includes(q)));
  if (S.lg.s && !list.some(r => r.k === S.lg.s)) list = rs.filter(r => r.k === S.lg.s).concat(list);
  let h = list.map(r => `<button type="button" class="nm" data-act="lg-s" data-k="${esc(r.k)}" aria-pressed="${r.k === S.lg.s}"><b>${esc(r.n)}</b><small>${esc(roleName(r.r))}</small></button>`).join("");
  const raw = $("lg-search").value.trim();
  if (q && !rs.some(r => norm(r.n) === q)) h += `<button type="button" class="nm add" data-act="lg-quick"><b>+ Add “${esc(raw)}”</b><small>to the roster</small></button>`;
  if (!rs.length && !q) h = `<div class="empty" style="grid-column:1/-1">The roster is empty. Type a name above to add someone.</div>`;
  else if (!list.length && !q) h = `<div class="empty" style="grid-column:1/-1">Nobody in this group.</div>`;
  $("lg-names").innerHTML = h;
  updateAddBtn();
}
function updateAddBtn() {
  const b = $("lg-add"), ok = !!(S.lg.c && S.lg.s && contests()[S.lg.c]);
  b.disabled = !ok || S.lg.busy;
  b.textContent = S.lg.busy ? "Saving…" : ok ? `Add ${plural(S.lg.q, "entry", "entries")} for ${staffName(S.lg.s)}` : !S.lg.c ? "Pick a contest" : "Pick who earned it";
}
function entryRow(e, showContest) {
  const gone = !!e.x, lock = !gone && entryLocked(e), c = contests()[e.c];
  const bits = [showContest ? (c ? c.n : "(deleted contest)") : null, fmtWhen(e.t), "by " + mgrName(e.by), e.n || null, gone ? "removed by " + mgrName(e.x.by) : null].filter(Boolean).map(esc).join(" · ");
  const act = isMgr() && !gone ? (lock ? '<span class="note">Locked</span>' : `<button type="button" class="btn" data-act="en-rm" data-k="${esc(e.k)}">Remove</button>`) : "";
  return `<div class="er${gone ? " gone" : ""}"><span class="q">+${qtyOf(e)}</span><div class="ei"><b>${esc(staffName(e.s))}</b><div>${bits}</div></div>${act}</div>`;
}
async function addEntry() {
  const c = S.lg.c, s = S.lg.s, q = S.lg.q, note = $("lg-note").value.trim().slice(0, 80);
  if (!c || !s || S.lg.busy || !isMgr()) return;
  S.lg.busy = true; updateAddBtn();
  const id = L.newId(), body = { s, c, q, by: uid(), t: SV };
  if (note) body.n = note;
  try {
    await req("PUT", "contests/entries/" + id, body);
    const jp = jackpotNow(), nm = staffName(s), cn = (contests()[c] || {}).n || "the contest";
    S.lg.s = null; S.lg.q = 1; $("lg-note").value = ""; $("lg-search").value = "";
    toast(`${nm} +${q} in ${cn}. ${jp ? "Counts toward " + jp.n + "." : "No jackpot period is running, so it isn't a jackpot ticket yet."}`, { undo: () => removeEntry(id) });
  } catch (e) { toast(errMsg(e), { err: true }); }
  S.lg.busy = false; $("lg-q").textContent = S.lg.q; renderNames();
}
async function removeEntry(id) { if (await save("PUT", "contests/entries/" + id + "/x", { by: uid(), t: SV })) toast("Entry removed."); }
function askRemoveEntry(id) {
  const e = entries()[id]; if (!e) return;
  const c = contests()[e.c];
  confirmSheet("Remove this entry?", `${esc(staffName(e.s))} +${qtyOf(e)} in ${esc(c ? c.n : "a deleted contest")}. It stops counting toward the contest and the jackpot. It stays in the history as removed.`, "Remove", async () => { closeSheet(); await removeEntry(id); }, true);
}
function openQuickAdd() {
  const name = $("lg-search").value.trim().slice(0, 60);
  let role = S.lg.role !== "all" ? S.lg.role : "server";
  openSheet(sheetTop("Add to roster") + `<label class="f" for="qa-n">Name</label><input id="qa-n" maxlength="60" value="${esc(name)}" autocapitalize="words"><label class="f">Role</label><div id="qa-r" class="chips"></div><div class="err-t" id="qa-err"></div><div class="acts"><button type="button" class="btn" data-act="close">Cancel</button><button type="button" class="btn gold" id="qa-ok">Add and pick</button></div>`, "quick");
  const chips = () => { $("qa-r").innerHTML = ROLES.map(r => `<button type="button" class="chip" data-r="${r[0]}" aria-pressed="${r[0] === role}">${r[1]}</button>`).join(""); };
  chips();
  $("qa-r").onclick = e => { const b = e.target.closest("[data-r]"); if (b) { role = b.dataset.r; chips(); } };
  $("qa-ok").onclick = async () => {
    const n = $("qa-n").value.trim().replace(/\s+/g, " ");
    const id = await addStaff(n, role, $("qa-err"));
    if (id) { closeSheet(); S.lg.pick = id; $("lg-search").value = ""; renderNames(); toast(`Added ${n} (${roleName(role)}).`); }
  };
}
async function addStaff(n, role, errEl) {
  if (!n) { errEl.textContent = "Type a name."; return null; }
  const dup = activeRoster().find(r => norm(r.n) === norm(n));
  if (dup) { errEl.textContent = `${dup.n} is already on the roster. Add a last initial to tell them apart.`; return null; }
  const id = L.newId();
  if (!(await save("PUT", "contests/roster/" + id, { n: n.slice(0, 60), r: role, on: true, t: SV }))) return null;
  return id;
}

/* Contests */
function contestCard(m) {
  return `<button type="button" class="card" data-act="ct-open" data-k="${esc(m.k)}"><div class="ct"><div><b class="t">${esc(m.n)}</b><div class="meta">${BADGE[m.st]} ${esc(fmtRange(m.s, m.e))} · ${esc(modeText(m))} · ${esc(leftText(m))}</div>${m.p ? `<div class="prize">Prize: ${esc(m.p)}</div>` : ""}</div><div class="big">${m.tk}<small>${unit(m)[m.tk === 1 ? 0 : 1]}</small></div></div>${m.draw ? winBlock(m) : board(m, 3)}</button>`;
}
function renderContests() {
  const el = $("v-contests");
  if (!S.got) { el.innerHTML = loading(); return; }
  const mgr = isMgr(), all = allContests();
  const by = st => all.filter(m => m.st === st);
  const act = by("active").sort((a, b) => a.e < b.e ? -1 : 1), up = by("upcoming").sort((a, b) => a.s < b.s ? -1 : 1), end = by("ended").sort((a, b) => a.e < b.e ? -1 : 1), done = by("done").sort((a, b) => (b.draw.t || 0) - (a.draw.t || 0));
  let h = mgr ? `<button type="button" class="btn gold" data-act="ct-new" style="width:100%;margin-top:4px">+ New contest</button>` : "";
  if (!all.length) h += `<div class="empty" style="margin-top:14px">No contests yet.${mgr ? "" : " Check back soon."}</div>`;
  const grp = (title, list) => list.length ? `<h2 class="sec">${title} <small>${list.length}</small></h2>` + list.map(contestCard).join("") : "";
  h += grp("Ready to draw", end) + grp("Running", act) + grp("Coming up", up);
  if (done.length) h += `<h2 class="sec">Finished <small>${done.length}</small></h2>` + done.slice(0, 4).map(contestCard).join("") + (done.length > 4 ? `<details class="more"><summary>Show ${done.length - 4} older</summary>${done.slice(4).map(contestCard).join("")}</details>` : "");
  el.innerHTML = h;
}
function openDetail(kind, k, wait) {
  const m = kind === "c" ? contestModel(k) : jackpotModel(k);
  if (!m) {   // just created: wait for it to come back from the database
    if (wait && Date.now() < wait) openSheet(sheetTop("Saving…") + '<p class="note">One moment.</p>', "detail-" + kind + k, () => openDetail(kind, k, wait));
    else closeSheet();
    return;
  }
  const mgr = isMgr(), owner = S.role === "owner" && !!S.user, u = unit(m);
  let h = sheetTop(m.n);
  h += `<div class="meta">${BADGE[m.st]} ${esc(fmtRange(m.s, m.e))} · ${esc(leftText(m))}</div>`;
  if (kind === "c") {
    if (m.d) h += `<p style="margin:10px 0 0">${esc(m.d)}</p>`;
    if (m.p) h += `<div class="prize">Prize: ${esc(m.p)}</div>`;
    h += `<p class="note" style="margin-top:8px">${esc(modeText(m))}. ${esc(MODE_HINT[m.m] || "")}</p>`;
  } else h += `<p class="note" style="margin-top:8px">Every entry from any contest logged in these dates is one ticket.</p>`;
  h += winBlock(m);
  if (m.draw && owner) h += `<div class="acts"><button type="button" class="btn danger" data-act="dr-void" data-kind="${kind}" data-k="${esc(k)}">Void this draw</button></div>`;
  if (!m.draw && mgr) {
    const early = m.st === "active" || m.st === "upcoming";
    h += m.tk ? `<button type="button" class="primary" data-act="dr-ask" data-kind="${kind}" data-k="${esc(k)}">${kind === "j" ? "Draw the jackpot" : "Draw the winner"}</button>${early ? `<p class="note" style="margin-top:6px">Still open until ${esc(fmtDay(m.e))}. Drawing now closes it.</p>` : ""}`
      : `<button type="button" class="primary" disabled>No ${u[1]} to draw from yet</button>`;
  }
  if (m.voided.length) h += `<p class="note" style="margin-top:10px">Voided: ${m.voided.map(d => `${esc(staffName(d.w))} (drawn ${esc(fmtWhen(d.t))}, voided ${esc(fmtWhen(d.v.t))} by ${esc(mgrName(d.v.by))})`).join("; ")}</p>`;
  h += `<h2 class="sec">Standings <small>${plural(m.tk, u[0], u[1])} · ${plural(m.tally.length, "person", "people")}</small></h2>` + board(m);
  if (mgr) {
    const list = L.rows(entries()).filter(e => typeof e.t === "number" && (kind === "c" ? e.c === k : e.t >= L.dayStart(m.s) && e.t <= L.dayEnd(m.e))).sort((a, b) => b.t - a.t);
    h += `<h2 class="sec">Entries <small>${list.length}</small></h2>` + (list.length ? list.map(e => entryRow(e, kind === "j")).join("") : '<p class="note">None yet.</p>');
    const used = kind === "c" ? (list.length || draws(m.g)) : draws(m.g);
    h += `<div class="acts">${!m.draw ? `<button type="button" class="btn" data-act="${kind === "c" ? "ct-edit" : "jp-edit"}" data-k="${esc(k)}">Edit</button>` : ""}${!used ? `<button type="button" class="btn danger" data-act="${kind}-del" data-k="${esc(k)}">Delete</button>` : ""}</div>`;
  }
  openSheet(h, "detail-" + kind + k, () => openDetail(kind, k));
}
function openContestForm(k) {
  const c = k ? contests()[k] : null, today = L.azToday(now());
  let mode = c ? c.m : "lottery";
  openSheet(sheetTop(c ? "Edit contest" : "New contest") +
    `<label class="f" for="cf-n">Name</label><input id="cf-n" maxlength="60" placeholder="Bottle Bonanza" value="${esc(c ? c.n : "")}">
     <label class="f" for="cf-d">What it rewards</label><textarea id="cf-d" maxlength="200" placeholder="Every bottle of rosé sold">${esc(c ? c.d || "" : "")}</textarea>
     <label class="f" for="cf-p">Prize</label><input id="cf-p" maxlength="100" placeholder="$50 bonus" value="${esc(c ? c.p || "" : "")}">
     <div class="two"><div><label class="f" for="cf-s">Starts</label><input id="cf-s" type="date" value="${esc(c ? c.s : today)}"></div><div><label class="f" for="cf-e">Ends</label><input id="cf-e" type="date" value="${esc(c ? c.e : L.addDays(today, 6))}"></div></div>
     <label class="f">How the winner is picked</label><div class="seg" id="cf-m"><button type="button" data-m="lottery">Lottery</button><button type="button" data-m="most">Most entries</button></div>
     <p class="note" id="cf-mh" style="margin-top:8px"></p><div class="err-t" id="cf-err"></div>
     <div class="acts"><button type="button" class="btn" data-act="close">Cancel</button><button type="button" class="btn gold" id="cf-ok">${c ? "Save" : "Create contest"}</button></div>`, "form");
  const seg = () => { $("cf-m").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.m === mode)); $("cf-mh").textContent = MODE_HINT[mode]; };
  seg();
  $("cf-m").onclick = e => { const b = e.target.closest("[data-m]"); if (b) { mode = b.dataset.m; seg(); } };
  $("cf-ok").onclick = async () => {
    const n = $("cf-n").value.trim(), s = $("cf-s").value, e = $("cf-e").value, err = $("cf-err");
    if (!n) { err.textContent = "Give the contest a name."; return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) { err.textContent = "Pick a start and end date."; return; }
    if (e < s) { err.textContent = "The end date is before the start date."; return; }
    const body = { n, d: $("cf-d").value.trim(), p: $("cf-p").value.trim(), s, e, m: mode };
    $("cf-ok").disabled = true;
    let ok, id = k;
    if (k) ok = await save("PATCH", "contests/list/" + k, body);
    else { id = L.newId(); ok = await save("PUT", "contests/list/" + id, Object.assign(body, { t: SV, by: uid() })); }
    if (!ok) { $("cf-ok").disabled = false; return; }
    if (!k && s <= today && e >= today) { S.lg.c = id; P.lc = id; saveP(); }
    toast(k ? "Contest saved." : `${n} is set up.`);
    openDetail("c", id, Date.now() + 8000);
    setTimeout(() => { if (sheetKind === "detail-c" + id && !contests()[id]) closeSheet(); }, 8100);
  };
}

/* Draws */
function askDraw(kind, k) {
  const m = kind === "c" ? contestModel(k) : jackpotModel(k);
  if (!m || m.draw || !m.tk || !isMgr()) return;
  const u = unit(m);
  confirmSheet(kind === "j" ? "Draw the jackpot?" : "Draw the winner?", `<b>${esc(m.n)}</b>: ${plural(m.tk, u[0], u[1])} from ${plural(m.tally.length, "person", "people")}. ${esc(modeText(m))}. The result is saved for every manager and can't be quietly redrawn.`, "Draw now", () => doDraw(kind, k));
}
async function doDraw(kind, k) {
  const m = kind === "c" ? contestModel(k) : jackpotModel(k);
  if (!m || !m.tk) { closeSheet(); return; }
  if (m.draw) { openDetail(kind, k); return; }
  const pick = L.pickWinner(m.tally, m.m), id = L.newId(), body = { w: pick.w, tk: pick.tk, pool: pick.pool, by: uid(), t: SV };
  if (pick.tie) body.tie = pick.tie;
  if (!(await save("PUT", "contests/draws/" + m.g + "/" + id, body))) { openDetail(kind, k); return; }
  reveal(m, pick, kind, k);
}
function reveal(m, pick, kind, k) {
  const names = m.tally.map(r => staffName(r.s)), u = unit(m);
  openSheet(sheetTop(m.n) + `<div class="reveal" id="rv"><div class="rn" id="rvn"></div><div class="rs" id="rvs">Drawing…</div></div><div class="acts"><button type="button" class="btn gold" id="rvd" data-act="${kind}-open" data-k="${esc(k)}" hidden>Done</button></div>`, "reveal");
  const t0 = Date.now(), dur = names.length > 1 ? 2400 : 500;
  (function tick() {
    const el = $("rvn"); if (!el || sheetKind !== "reveal") return;
    const p = (Date.now() - t0) / dur;
    if (p < 1) { el.textContent = names[Math.floor(L.rand() * names.length)]; setTimeout(tick, 55 + p * p * 260); return; }
    el.textContent = staffName(pick.w); $("rv").classList.add("landed");
    $("rvs").textContent = `${kind === "j" ? "Jackpot winner" : "Winner"} · ${plural(pick.tk, u[0], u[1])} from ${plural(pick.pool, "person", "people")}${pick.tie ? ` · ${pick.tie}-way tie settled by random draw` : ""}`;
    $("rvd").hidden = false;
  })();
}
function askVoid(kind, k) {
  const m = kind === "c" ? contestModel(k) : jackpotModel(k);
  if (!m || !m.draw || S.role !== "owner") return;
  confirmSheet("Void this draw?", `${esc(staffName(m.draw.w))} stays on record as a voided draw, with your name and the time. Then a new draw can be made.`, "Void draw", async () => {
    if (await save("PUT", "contests/draws/" + m.g + "/" + m.draw.k + "/v", { by: uid(), t: SV })) toast("Draw voided.");
    openDetail(kind, k);
  }, true);
}

/* Jackpot */
function renderJackpot() {
  const el = $("v-jackpot");
  if (!S.got) { el.innerHTML = loading(); return; }
  const mgr = isMgr(), all = allJackpots();
  const cur = all.filter(j => j.st !== "done").sort((a, b) => a.e < b.e ? -1 : 1), past = all.filter(j => j.st === "done").sort((a, b) => b.e < a.e ? -1 : 1);
  let h = `<p class="note" style="margin:2px 2px 12px">Every entry from any contest is one ticket in the jackpot for its dates.</p>`;
  if (!cur.length) h += `<div class="empty">No jackpot period is running.${mgr ? `<br><button type="button" class="btn gold" data-act="jp-new">Start a jackpot period</button>` : ""}</div>`;
  for (const j of cur) {
    h += `<div class="card"><div class="ct"><div><b class="t">${esc(j.n)}</b><div class="meta">${BADGE[j.st]} ${esc(fmtRange(j.s, j.e))} · ${esc(leftText(j))}</div></div><div class="big">${j.tk}<small>${j.tk === 1 ? "ticket" : "tickets"}</small></div></div>${board(j, 10)}`;
    if (mgr) h += j.tk ? `<button type="button" class="primary" data-act="dr-ask" data-kind="j" data-k="${esc(j.k)}">Draw the jackpot</button>${j.st !== "ended" ? `<p class="note" style="margin-top:6px">Runs until ${esc(fmtDay(j.e))}. Drawing early closes it.</p>` : ""}` : "";
    h += `<div class="acts" style="margin-top:10px"><button type="button" class="btn" data-act="j-open" data-k="${esc(j.k)}">Details</button></div></div>`;
  }
  if (mgr && cur.length) h += `<button type="button" class="btn" data-act="jp-new" style="width:100%">+ New jackpot period</button>`;
  if (past.length) h += `<h2 class="sec">Past jackpots <small>${past.length}</small></h2>` + past.map(j => `<button type="button" class="card" data-act="j-open" data-k="${esc(j.k)}"><div class="ct"><div><b class="t">${esc(j.n)}</b><div class="meta">${BADGE.done} ${esc(fmtRange(j.s, j.e))}</div></div><div class="big">${j.draw.tk}<small>tickets</small></div></div>${winBlock(j)}</button>`).join("");
  el.innerHTML = h;
}
function openJackpotForm(k) {
  const j = k ? jackpots()[k] : null, today = L.azToday(now()), y = +today.slice(0, 4), mo = +today.slice(5, 7);
  const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  openSheet(sheetTop(j ? "Edit jackpot period" : "New jackpot period") +
    `<label class="f" for="jf-n">Name</label><input id="jf-n" maxlength="60" value="${esc(j ? j.n : MONTH[mo - 1] + " Jackpot")}">
     <div class="two"><div><label class="f" for="jf-s">Starts</label><input id="jf-s" type="date" value="${esc(j ? j.s : today)}"></div><div><label class="f" for="jf-e">Ends</label><input id="jf-e" type="date" value="${esc(j ? j.e : last)}"></div></div>
     <p class="note" style="margin-top:8px">Entries logged from the start of the first day to midnight Arizona time on the last day count as tickets.</p><div class="err-t" id="jf-err"></div>
     <div class="acts"><button type="button" class="btn" data-act="close">Cancel</button><button type="button" class="btn gold" id="jf-ok">${j ? "Save" : "Start period"}</button></div>`, "form");
  $("jf-ok").onclick = async () => {
    const n = $("jf-n").value.trim(), s = $("jf-s").value, e = $("jf-e").value, err = $("jf-err");
    if (!n) { err.textContent = "Give it a name."; return; }
    if (!s || !e) { err.textContent = "Pick a start and end date."; return; }
    if (e < s) { err.textContent = "The end date is before the start date."; return; }
    $("jf-ok").disabled = true;
    let id = k, ok;
    if (k) ok = await save("PATCH", "contests/jackpots/" + k, { n, s, e });
    else { id = L.newId(); ok = await save("PUT", "contests/jackpots/" + id, { n, s, e, t: SV, by: uid() }); }
    if (!ok) { $("jf-ok").disabled = false; return; }
    toast(k ? "Saved." : `${n} is running.`); closeSheet();
  };
}

/* Roster */
function renderRoster() {
  $("ro-roles").innerHTML = ROLES.map(r => `<button type="button" class="chip" data-act="ro-role" data-r="${r[0]}" aria-pressed="${S.ro.role === r[0]}">${r[1]}</button>`).join("");
  $("ro-add").disabled = !$("ro-name").value.trim();
  const el = $("ro-list");
  if (!S.got) { el.innerHTML = loading(); return; }
  const live = L.live(entries()), cnt = {};
  for (const e of live) cnt[e.s] = (cnt[e.s] || 0) + qtyOf(e);
  const all = L.rows(roster()).sort((a, b) => norm(a.n).localeCompare(norm(b.n))), on = all.filter(r => r.on !== false), off = all.filter(r => r.on === false);
  const row = r => `<button type="button" class="er" data-act="ro-edit" data-k="${esc(r.k)}" style="width:100%;background:none;border-left:0;border-right:0;border-top:0;text-align:left"><div class="ei"><b>${esc(r.n)}</b><div>${esc(roleName(r.r))}</div></div><span class="note">${plural(cnt[r.k] || 0, "entry", "entries")}</span></button>`;
  let h = "";
  if (!on.length) h += `<div class="empty" style="margin-top:18px">Nobody on the roster yet. Add your team above, or add people from the Log tab as you go.</div>`;
  for (const r of ROLES) { const g = on.filter(x => x.r === r[0]); if (g.length) h += `<h2 class="sec">${r[2]} <small>${g.length}</small></h2>` + g.map(row).join(""); }
  const other = on.filter(x => !ROLES.some(r => r[0] === x.r));
  if (other.length) h += `<h2 class="sec">Other <small>${other.length}</small></h2>` + other.map(row).join("");
  if (off.length) h += `<details class="more"><summary>Retired (${off.length})</summary>${off.map(row).join("")}</details>`;
  el.innerHTML = h;
}
async function rosterAdd() {
  const inp = $("ro-name"), n = inp.value.trim().replace(/\s+/g, " ");
  const errBox = { set textContent(v) { toast(v, { err: true }); } };
  $("ro-add").disabled = true;
  const id = await addStaff(n, S.ro.role, errBox);
  if (id) { inp.value = ""; toast(`Added ${n} (${roleName(S.ro.role)}).`); }
  $("ro-add").disabled = !inp.value.trim(); inp.focus();
}
function openStaff(k) {
  const r = roster()[k]; if (!r) return;
  let role = r.r;
  openSheet(sheetTop(r.n) + `<label class="f" for="sf-n">Name</label><input id="sf-n" maxlength="60" value="${esc(r.n)}" autocapitalize="words"><label class="f">Role</label><div id="sf-r" class="chips"></div><div class="err-t" id="sf-err"></div>
    <div class="acts"><button type="button" class="btn ${r.on === false ? "gold" : "danger"}" id="sf-on">${r.on === false ? "Bring back" : "Retire"}</button><button type="button" class="btn gold" id="sf-ok">Save</button></div>
    <p class="note" style="margin-top:10px">${r.on === false ? "Retired staff are hidden from the Log tab. Their past entries and wins stay." : "Retiring hides them from the Log tab. Their past entries and wins stay."}</p>`, "form");
  const chips = () => { $("sf-r").innerHTML = ROLES.map(x => `<button type="button" class="chip" data-r="${x[0]}" aria-pressed="${x[0] === role}">${x[1]}</button>`).join(""); };
  chips();
  $("sf-r").onclick = e => { const b = e.target.closest("[data-r]"); if (b) { role = b.dataset.r; chips(); } };
  $("sf-ok").onclick = async () => {
    const n = $("sf-n").value.trim().replace(/\s+/g, " ");
    if (!n) { $("sf-err").textContent = "Type a name."; return; }
    const dup = activeRoster().find(x => x.k !== k && norm(x.n) === norm(n));
    if (dup) { $("sf-err").textContent = `${dup.n} is already on the roster.`; return; }
    if (await save("PATCH", "contests/roster/" + k, { n, r: role })) { toast("Saved."); closeSheet(); }
  };
  $("sf-on").onclick = async () => { if (await save("PATCH", "contests/roster/" + k, { on: r.on === false })) { toast(r.on === false ? `${r.n} is back on the roster.` : `${r.n} retired.`); closeSheet(); } };
}

/* Account */
function adminHtml() {
  const rq = Object.entries(S.admin.req || {}), ed = Object.entries(S.admin.ed || {});
  let h = `<h2 class="sec">Waiting for approval</h2>` + (rq.length ? rq.map(([u, r]) => `<div class="er"><div class="ei"><b style="font-family:var(--body);font-size:15px">${esc(r && r.email || u)}</b></div><button type="button" class="btn gold" data-act="ad-ok" data-u="${esc(u)}">Approve</button><button type="button" class="btn" data-act="ad-no" data-u="${esc(u)}">Decline</button></div>`).join("") : `<p class="note">Nobody is waiting. A manager asks by signing in with the login you made for them.</p>`);
  h += `<h2 class="sec">Managers <small>${ed.length}</small></h2>` + (ed.length ? ed.map(([u, r]) => `<div class="er"><div class="ei"><b style="font-family:var(--body);font-size:15px">${esc((T().mgr || {})[u] ? mgrName(u) + " · " : "")}${esc(r && r.email || u)}</b></div><button type="button" class="btn danger" data-act="ad-rm" data-u="${esc(u)}">Remove</button></div>`).join("") : `<p class="note">No other managers yet.</p>`);
  return h + `<p class="note" style="margin-top:8px">Managers here are the same people who can edit the Wine Tower.</p>`;
}
function openAcct() {
  let h;
  if (!S.user) {
    h = sheetTop("Manager sign in") + `<form id="ac-f"><p class="note">Use the same login as the Wine Tower. Staff don't need to sign in to see standings.</p>
      <label class="f" for="ac-e">Email</label><input id="ac-e" type="email" autocomplete="username" required>
      <label class="f" for="ac-p">Password</label><input id="ac-p" type="password" autocomplete="current-password" required>
      <div class="err-t" id="ac-err"></div><button class="primary" id="ac-go" type="submit">Sign in</button></form>`;
    openSheet(h, "acct");
    $("ac-f").onsubmit = async e => {
      e.preventDefault(); const go = $("ac-go"); go.disabled = true; $("ac-err").textContent = "";
      try { const u = await api.signIn($("ac-e").value.trim(), $("ac-p").value); S.user = { uid: u.uid, email: u.email, rt: u.rt }; S.tok = u.tok; S.exp = u.exp; saveUser(); await checkRole(); openAcct(); }
      catch (err) { $("ac-err").textContent = err && err.message || "Sign-in failed."; go.disabled = false; }
    };
    return;
  }
  h = sheetTop(S.role === "pending" ? "Waiting for approval" : "Your account") + `<p class="note">Signed in as ${esc(S.user.email)}</p>`;
  if (S.role === "pending") h += `<p style="margin-top:12px">Your login works, but it hasn't been approved yet. Ask the owner to approve it in the Wine Tower (Manage) or here.</p>`;
  if (isMgr()) {
    const def = myName() || String(S.user.email).split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    h += `<label class="f" for="ac-n">Your name on entries</label><div class="row"><input id="ac-n" maxlength="30" value="${esc(def)}"><button type="button" class="btn gold" id="ac-ns">Save</button></div>`;
  }
  if (S.role === "owner") h += `<div id="ac-adm">${adminHtml()}</div>`;
  h += `<div class="acts"><button type="button" class="btn" id="ac-out">Sign out</button></div><p class="note" style="margin-top:8px">Signing out here also signs this phone out of the Wine Tower.</p>`;
  openSheet(h, "acct");
  $("ac-out").onclick = () => { signOut(); closeSheet(); toast("Signed out."); };
  if ($("ac-ns")) $("ac-ns").onclick = async () => { const n = $("ac-n").value.trim().slice(0, 30); if (!n) return; if (await save("PUT", "contests/mgr/" + uid(), { n })) { toast("Name saved."); closeSheet(); } };
  if (S.role === "owner") loadAdmin();
}
async function adminAct(kind, u) {
  try {
    if (kind === "ok") { const r = S.admin.req[u] || {}; await req("PUT", "editors/" + u, { email: r.email || "", t: Date.now() }); await req("DELETE", "requests/" + u); toast("Approved."); }
    if (kind === "no") { await req("DELETE", "requests/" + u); toast("Declined."); }
    if (kind === "rm") { await req("DELETE", "editors/" + u); toast("Removed. They can no longer change contests or the tower."); }
  } catch (e) { toast(errMsg(e), { err: true }); }
  loadAdmin();
}

/* ---------- events ---------- */
const ACT = {
  close: () => closeSheet(),
  acct: () => openAcct(),
  "lg-c": d => { S.lg.c = d.k; P.lc = d.k; saveP(); renderLog(); },
  "lg-role": d => { S.lg.role = d.r; renderLog(); },
  "lg-s": d => { S.lg.s = S.lg.s === d.k ? null : d.k; renderNames(); },
  "lg-quick": () => openQuickAdd(),
  "en-rm": d => askRemoveEntry(d.k),
  "ct-new": () => openContestForm(null),
  "ct-open": d => openDetail("c", d.k),
  "c-open": d => openDetail("c", d.k),
  "j-open": d => openDetail("j", d.k),
  "ct-edit": d => openContestForm(d.k),
  "jp-new": () => openJackpotForm(null),
  "jp-edit": d => openJackpotForm(d.k),
  "c-del": d => { const c = contests()[d.k]; if (c) confirmSheet("Delete this contest?", `${esc(c.n)} has no entries, so nothing is lost.`, "Delete", async () => { if (await save("DELETE", "contests/list/" + d.k)) toast("Contest deleted."); closeSheet(); }, true); },
  "j-del": d => { const j = jackpots()[d.k]; if (j) confirmSheet("Delete this jackpot period?", `${esc(j.n)} hasn't been drawn. Entries stay; they just stop counting toward it.`, "Delete", async () => { if (await save("DELETE", "contests/jackpots/" + d.k)) toast("Jackpot period deleted."); closeSheet(); }, true); },
  "dr-ask": d => askDraw(d.kind, d.k),
  "dr-void": d => askVoid(d.kind, d.k),
  "ro-role": d => { S.ro.role = d.r; renderRoster(); },
  "ro-edit": d => openStaff(d.k),
  "ad-ok": d => adminAct("ok", d.u), "ad-no": d => adminAct("no", d.u),
  "ad-rm": d => { const r = S.admin.ed[d.u] || {}; confirmSheet("Remove this manager?", `${esc(r.email || d.u)} will no longer be able to change contests or the Wine Tower.`, "Remove", async () => { await adminAct("rm", d.u); openAcct(); }, true); }
};
document.addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b || b.disabled) return;
  const f = ACT[b.dataset.act]; if (f) { e.preventDefault(); f(b.dataset, b); }
});
$("sheet").addEventListener("click", e => { if (e.target === $("sheet")) closeSheet(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });
$("acct").onclick = openAcct;
document.querySelectorAll("#nav button").forEach(b => b.onclick = () => { S.view = b.dataset.v; P.view = S.view; saveP(); closeSheet(); render(); window.scrollTo(0, 0); });
$("lg-search").addEventListener("input", renderNames);
$("lg-search").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const q = norm(e.target.value), m = activeRoster().filter(r => (S.lg.role === "all" || r.r === S.lg.role) && norm(r.n).includes(q));
  if (q && m.length === 1) { S.lg.s = m[0].k; e.target.value = ""; renderNames(); e.target.blur(); }
});
$("lg-minus").onclick = () => { S.lg.q = Math.max(1, S.lg.q - 1); $("lg-q").textContent = S.lg.q; updateAddBtn(); };
$("lg-plus").onclick = () => { S.lg.q = Math.min(20, S.lg.q + 1); $("lg-q").textContent = S.lg.q; updateAddBtn(); };
$("lg-add").onclick = addEntry;
$("ro-name").addEventListener("input", () => { $("ro-add").disabled = !$("ro-name").value.trim(); });
$("ro-name").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); if ($("ro-name").value.trim()) rosterAdd(); } });
$("ro-add").onclick = rosterAdd;

/* ---------- start ---------- */
loadUser();
if (S.user) S.role = (P.roles || {})[S.user.uid] || "viewer";
render();
if (!MOCK && !(FBC.db && FBC.apiKey)) { S.conn = "down"; render(); }
else api.listen(tree => { S.tree = tree || {}; S.got = true; render(); }, c => { S.conn = c; render(); });
if (S.user) checkRole();
setInterval(() => { if (sheetKind === null || sheetRefresh) render(); }, 60000);   // contests open and close at midnight
window.addEventListener("storage", e => { if (e.key === LSK) { loadUser(); if (!S.user) signOut(); else checkRole(); } });
})();
