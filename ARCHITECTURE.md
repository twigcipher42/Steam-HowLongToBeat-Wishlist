# Architecture — v0.13.0

Steam owns the wishlist data, native filters, React cards and virtualizer. Earlier implementations treated mounted DOM snapshots as application state and cloned or replaced cards. Recycled rows could retain stale metadata, incomplete snapshots could omit games, clones lost React handlers, and reduced replacement cards removed prices, discounts and native information.

`native-renderer.js` is an isolated MAIN-world adapter. It locates the current React presentation result, reads its already-filtered item membership, validates unique IDs and exact source membership, and requests native rendering of the ordered/filtered item objects. It restores the source presentation when returning to native sorting. It does not change saved wishlist ranks or rebuild cards. Unsupported layouts retain native cards and report failure.

`content.js` has one latest-intent controller for custom sorts and review minimums. Native search/filter changes invalidate membership. Badges are bound to the current mounted app identity; rows need not be fully hydrated for membership to be known. Steam retains prices, regional formatting, graphics, context and control callbacks.

`background.js` owns metadata transport, country/language cache isolation, batched review requests, shared request queues, HLTB deduplication and cooldowns. Unknown values stay distinct from zero and sort last. Transport failures are not cached as successful unmatched HLTB results.

The adapter relies on undocumented Steam React internals. Actual React fixtures exercise virtualization, delayed hydration, stale rows, native fields and callbacks. Signed-in live verification is recorded in LIVE-QA-0.13.0.md; offline tests alone cannot establish compatibility with future Steam changes.
