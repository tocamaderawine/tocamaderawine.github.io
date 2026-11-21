# Toca Madera Wine Tower

Staff copy of the wine tower map: where every wine sits, how many are on hand, and what needs restocking.

- `index.html` is the app.
- `wines.js` holds the slot map.
- `counts.js` is rewritten by the weekly Bevager pull.
- `costs.js` is rewritten by the same pull: unit cost from the latest full audit and bottles sold in the last 90 days (Depletion Summary), keyed by wine name. Restock > Reorder uses it with the Budget box to rank what to buy: fastest sellers first, as many as fit.
- A Bevager count never overwrites a slot that was counted in the app after the audit date.

Staff address: https://tocamaderawine.github.io
