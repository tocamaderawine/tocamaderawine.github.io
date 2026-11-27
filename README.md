# Toca Madera Wine Tower

Staff copy of the wine tower map: where every wine sits, how many are on hand, and what needs restocking.

- `index.html` is the app.
- `wines.js` holds the slot map.
- `counts.js` is rewritten by the weekly Bevager pull. A Bevager count never overwrites a slot that was counted in the app after the audit date. An entry with `n` also renames the slot.

Staff address: https://tocamaderawine.github.io

## Contests

The staff contest hub lives at its own address so it installs as its own app: https://toca-contests.github.io (repo: toca-contests/toca-contests.github.io). `contests/` here only forwards the old link. It uses this site's live database; its rules are the `contests` section of `firebase-rules.json`.
