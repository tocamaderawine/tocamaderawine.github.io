# Toca Madera Wine Tower

Staff copy of the wine tower map: where every wine sits, how many are on hand, and what needs restocking.

- `index.html` is the app.
- `wines.js` holds the slot map.
- `counts.js` is rewritten by the weekly Bevager pull. A Bevager count never overwrites a slot that was counted in the app after the audit date. An entry with `n` also renames the slot.

Staff address: https://tocamaderawine.github.io

## Contests

`contests/` is the staff contest hub: https://tocamaderawine.github.io/contests/

- Same live database and manager logins as the tower. Everyone can see standings; only the owner and approved editors can change anything.
- Data lives under `contests/` in the database. Its rules are the `contests` section of `firebase-rules.json` (publish them in the Firebase console after changing).
- `contests/logic.js` does the counting and drawing. Tests: `node --test contests/tests/*.test.mjs`. `contests/tests/mock.js` is an in-memory database for trying the page without touching live data.
