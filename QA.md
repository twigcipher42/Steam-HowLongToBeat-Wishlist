# QA — Firefox 0.13.0

**33/33 scenarios pass** via `./test.sh`. The renderer fixture uses actual React 19.2 and ReactDOM, with the production MAIN-world adapter and content controller. Tests require real native information and handlers, not just a count of custom cards.

Each of the four sorts checks 485 ordered unique items and retention of prices, discounts, images, SVG/platform graphics, native review text, tags, release/added dates, cart/category/remove controls, and HLTB badges. Other cases cover arbitrary minimums/clearing, native 75% loading transitions, latest concurrent intent, repeated cached operations, hundreds of recycled/staged rows, stale content, delayed rendering, native callbacks, local removal, search, zero results, return to native sort, outages, unsupported React structures and invalid/stale item mappings. Background checks cover batching, cache TTL/country/language isolation, null versus zero, title matching, deduplication and cooldown handling.

The earlier 0.12.2 tests passed despite missing native information. Those tests were inadequate for product correctness. The simplified renderer and DOM crawl were removed. Only the current regression suite is included in this release.

Offline tests make no Steam/HLTB requests. Separate signed-in live results are documented in LIVE-QA-0.13.0.md. Future Steam changes and external-service availability cannot be proven by an offline suite.
