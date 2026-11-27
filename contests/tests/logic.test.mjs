// Run: node --test contests/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const L = createRequire(import.meta.url)("../logic.js");

const roster = { a: { n: "Ana", r: "server", on: true }, b: { n: "Ben", r: "host", on: true }, c: { n: "Cy", r: "barback", on: true } };
const at = (ymd, hms) => Date.parse(`${ymd}T${hms}-07:00`);

test("Arizona day boundaries", () => {
  assert.equal(L.dayStart("2026-12-31"), at("2026-12-31", "00:00:00.000"));
  assert.equal(L.dayEnd("2026-12-31"), at("2026-12-31", "23:59:59.999"));
  assert.equal(L.azToday(at("2026-12-31", "23:59:00")), "2026-12-31");
  assert.equal(L.azToday(at("2027-01-01", "00:00:30")), "2027-01-01");
  assert.equal(L.addDays("2026-12-28", 6), "2027-01-03");
});

test("jackpot counts entries up to midnight AZ on the last day only", () => {
  const jp = { s: "2026-12-01", e: "2026-12-31" };
  const entries = {
    e1: { s: "a", c: "k", q: 1, t: at("2026-12-31", "23:59:00") },
    e2: { s: "b", c: "k", q: 1, t: at("2027-01-01", "00:01:00") },
    e3: { s: "b", c: "k", q: 1, t: at("2026-11-30", "23:59:59") },
    e4: { s: "c", c: "k", q: 2, t: at("2026-12-01", "00:00:00") },
  };
  assert.deepEqual(L.jackpotTally(entries, jp, roster), [{ s: "c", n: 2 }, { s: "a", n: 1 }]);
});

test("removed entries never count", () => {
  const entries = {
    e1: { s: "a", c: "k", q: 3, t: 1, x: { by: "m", t: 2 } },
    e2: { s: "b", c: "k", q: 1, t: 1 },
    e3: { s: "a", c: "other", q: 5, t: 1 },
  };
  assert.deepEqual(L.contestTally(entries, "k", roster), [{ s: "b", n: 1 }]);
  assert.deepEqual(L.live(entries).map(e => e.k).sort(), ["e2", "e3"]);
});

test("tally sorts by count desc then name", () => {
  const entries = { 1: { s: "b", c: "k", t: 1 }, 2: { s: "a", c: "k", t: 1 }, 3: { s: "c", c: "k", q: 2, t: 1 } };
  assert.deepEqual(L.contestTally(entries, "k", roster), [{ s: "c", n: 2 }, { s: "a", n: 1 }, { s: "b", n: 1 }]);
});

test("lottery is weighted by tickets", () => {
  const tally = [{ s: "a", n: 3 }, { s: "b", n: 1 }];
  assert.equal(L.pickWinner(tally, "lottery", () => 0).w, "a");
  assert.equal(L.pickWinner(tally, "lottery", () => 0.74).w, "a");
  assert.equal(L.pickWinner(tally, "lottery", () => 0.75).w, "b");
  assert.equal(L.pickWinner(tally, "lottery", () => 0.9999999).w, "b");
  const r = L.pickWinner(tally, "lottery", () => 0.5);
  assert.equal(r.tk, 4); assert.equal(r.pool, 2); assert.equal(r.tie, undefined);
});

test("most entries wins; ties go to a random pick among the tied", () => {
  const tally = [{ s: "a", n: 4 }, { s: "b", n: 4 }, { s: "c", n: 1 }];
  assert.equal(L.pickWinner(tally, "most", () => 0).w, "a");
  const r = L.pickWinner(tally, "most", () => 0.99);
  assert.equal(r.w, "b"); assert.equal(r.tie, 2); assert.equal(r.tk, 9);
  assert.equal(L.pickWinner([{ s: "c", n: 2 }, { s: "a", n: 1 }], "most", () => 0.99).w, "c");
});

test("no tickets means no winner", () => {
  assert.equal(L.pickWinner([], "lottery", () => 0), null);
  assert.equal(L.pickWinner([], "most", () => 0), null);
});

test("current draw is the earliest one not voided", () => {
  assert.equal(L.currentDraw(null), null);
  const node = {
    d1: { w: "a", t: 100, v: { by: "o", t: 150 } },
    d3: { w: "c", t: 300 },
    d2: { w: "b", t: 200 },
  };
  assert.equal(L.currentDraw(node).w, "b");
  assert.equal(L.currentDraw(node).k, "d2");
  assert.equal(L.voidedDraws(node).length, 1);
});

test("contest status follows dates and draws", () => {
  const c = { s: "2026-12-01", e: "2026-12-07" };
  assert.equal(L.contestStatus(c, at("2026-11-30", "23:59:59"), null), "upcoming");
  assert.equal(L.contestStatus(c, at("2026-12-01", "00:00:00"), null), "active");
  assert.equal(L.contestStatus(c, at("2026-12-07", "23:59:59"), null), "active");
  assert.equal(L.contestStatus(c, at("2026-12-08", "00:00:00"), null), "ended");
  assert.equal(L.contestStatus(c, at("2026-12-03", "12:00:00"), { w: "a" }), "done");
});

test("ids are safe database keys and unique", () => {
  const ids = new Set(Array.from({ length: 500 }, () => L.newId()));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^[a-z0-9]{10,24}$/);
});

test("default random source is in [0,1)", () => {
  for (let i = 0; i < 200; i++) { const r = L.rand(); assert.ok(r >= 0 && r < 1); }
});
