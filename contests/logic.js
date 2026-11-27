// Counting and drawing for the contest hub. No page or database code here, so it can be tested on its own.
// Arizona stays on UTC-7 all year, so a day is fixed: 00:00 to 23:59:59.999 at -07:00.
(function (root, make) {
  if (typeof module === "object" && module.exports) module.exports = make();
  else root.CL = make();
})(typeof self !== "undefined" ? self : this, function () {
  const OFF = 7 * 3600 * 1000, DAY = 86400000;

  function azToday(now) { return new Date((now == null ? Date.now() : now) - OFF).toISOString().slice(0, 10); }
  function dayStart(ymd) { return Date.parse(ymd + "T00:00:00.000Z") + OFF; }
  function dayEnd(ymd) { return dayStart(ymd) + DAY - 1; }
  function addDays(ymd, n) { return new Date(Date.parse(ymd + "T00:00:00.000Z") + n * DAY).toISOString().slice(0, 10); }

  function rows(node) {
    const out = [];
    if (!node || typeof node !== "object") return out;
    for (const k of Object.keys(node)) { const v = node[k]; if (v && typeof v === "object") out.push(Object.assign({ k }, v)); }
    return out;
  }
  function live(entries) { return rows(entries).filter(e => !e.x && e.s && typeof e.t === "number"); }
  function qty(e) { const q = +e.q; return q >= 1 ? Math.floor(q) : 1; }

  function tally(list, roster) {
    const m = new Map();
    for (const e of list) m.set(e.s, (m.get(e.s) || 0) + qty(e));
    const name = s => String((roster && roster[s] && roster[s].n) || "").toLowerCase();
    return [...m].map(([s, n]) => ({ s, n })).sort((a, b) => b.n - a.n || name(a.s).localeCompare(name(b.s)) || (a.s < b.s ? -1 : 1));
  }
  function contestTally(entries, cid, roster) { return tally(live(entries).filter(e => e.c === cid), roster); }
  function jackpotTally(entries, jp, roster) {
    const a = dayStart(jp.s), b = dayEnd(jp.e);
    return tally(live(entries).filter(e => e.t >= a && e.t <= b), roster);
  }
  function total(t) { return t.reduce((x, r) => x + r.n, 0); }

  // If two managers draw at the same moment, the earliest record stands, on every phone.
  function currentDraw(node) {
    return rows(node).filter(d => !d.v && d.w).sort((a, b) => (a.t || 0) - (b.t || 0) || (a.k < b.k ? -1 : 1))[0] || null;
  }
  function voidedDraws(node) { return rows(node).filter(d => d.v && d.w).sort((a, b) => (a.t || 0) - (b.t || 0)); }

  function contestStatus(c, now, draw) {
    if (draw) return "done";
    if (now < dayStart(c.s)) return "upcoming";
    if (now <= dayEnd(c.e)) return "active";
    return "ended";
  }

  function rand() {
    const c = (typeof globalThis !== "undefined" && globalThis.crypto) || null;
    if (c && c.getRandomValues) { const u = new Uint32Array(1); c.getRandomValues(u); return u[0] / 4294967296; }
    return Math.random();
  }

  // lottery: every ticket is one chance. most: highest count wins; a tie is settled by a random pick among the tied.
  function pickWinner(t, mode, rnd) {
    const r = rnd || rand, tk = total(t);
    if (!tk) return null;
    if (mode === "most") {
      const top = t.reduce((m, x) => Math.max(m, x.n), 0), tied = t.filter(x => x.n === top);
      const w = tied[Math.min(tied.length - 1, Math.floor(r() * tied.length))].s;
      const out = { w, tk, pool: t.length };
      if (tied.length > 1) out.tie = tied.length;
      return out;
    }
    let i = Math.min(tk - 1, Math.floor(r() * tk));
    for (const x of t) { if (i < x.n) return { w: x.s, tk, pool: t.length }; i -= x.n; }
    return { w: t[t.length - 1].s, tk, pool: t.length };
  }

  function newId() {
    let s = Date.now().toString(36);
    const a = "abcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 8; i++) s += a[Math.floor(rand() * 36)];
    return s;
  }

  return { azToday, dayStart, dayEnd, addDays, rows, live, contestTally, jackpotTally, total, currentDraw, voidedDraws, contestStatus, pickWinner, rand, newId };
});
