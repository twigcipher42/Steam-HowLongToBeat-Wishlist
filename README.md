# Steam-HowLongToBeat-Wishlist — Firefox 0.13.0

Adds HLTB Shortest/Longest, Reviews Most/Fewest, and an arbitrary review minimum while retaining Steam's genuine wishlist cards: current regional pricing, discounts, artwork, platforms, tags, dates, categories and native controls. HLTB and review badges remain visible in review sorts too.

## Firefox installation

1. Download this repository using **Code → Download ZIP**, or clone it, and extract the files.
2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and select the extracted `manifest.json`.
4. Allow the requested site access, then open or reload your Steam wishlist.
5. Select HLTB Shortest/Longest or Reviews Most/Fewest in the sort menu. Enter any minimum in **Reviews ≥**; clear the field to remove that filter. Steam's native filters still apply.

When updating an older temporary add-on, check **Permissions** in `about:addons` and enable access to `api.steampowered.com` if Firefox retained older host grants. Reload the add-on from `about:debugging`, then reload the wishlist.

Temporary add-ons are removed when Firefox closes; load it again after restarting Firefox. This repository contains an unsigned extension. Permanent installation in standard Firefox requires a Mozilla-signed package.

## Run QA

From the extracted source directory, run:

```bash
./test.sh
```

Requires Node.js 20+ and npm. Initial dependency and Firefox downloads require network. Later runs reuse them. The suite runs Firefox with real React native-card fixtures and the actual adapter/controller, plus background transport/cache tests. It makes no live Steam or HLTB requests. Results are in `test-results.json`; a failure exits nonzero.

## Architecture

The extension reads Steam's already-filtered, computed wishlist result through a small MAIN-world React adapter. It sorts/filters that presentation result and requests a native React render. It does not rebuild or clone cards, hide Steam's renderer, change saved wishlist ranks, or fetch replacement prices. The adapter is isolated in `native-renderer.js`, checks unique IDs and exact source membership, and refuses unsupported layouts. Steam continues to render its own items, context, artwork and live controls.

One latest-intent controller handles all custom sorts and review minimums. Steam's search and native filters remain authoritative. A changed native URL/search/count invalidates the snapshot; the pipeline waits for loading to finish. Returning to a native sort or clearing a standalone minimum restores the original native result. Custom dragging is suppressed to avoid writing a visual sort into saved ranks; ordinary native links/buttons remain active.

Review counts/names use Steam StoreBrowse in batches of up to 150 IDs. Metadata is cached by language/country, with seven days for known values and 30 minutes for unknowns. A cold 485-game result needs four batches. Unknown counts are distinct from zero, sort last, and fail positive minimums. Cached sorts and thresholds do not request reviews again.

HLTB times use cached, deduplicated and paced lookups. Review sorts decorate only the currently mounted native rows instead of resolving all 485 times. HLTB sorts resolve the entire membership. Known results last seven days, genuine unmatched titles six hours; transport errors are not cached as no-match. A rate limit resolves queued misses as unavailable rather than scheduling a deferred request burst. Unknown times sort last.

## Verification and limits

All 33 automated scenarios pass. The temporary add-on was separately tested on the real signed-in 485-game wishlist with all four sorts, review minimum/clearing, native 75% discount, and recycled rows after a 40,000px scroll. Prices, graphics, native information and both badges were checked; live checks were recorded separately. See `LIVE-QA-0.13.0.md`.

Steam's React internals can change. An unsupported adapter reports an error and retains native cards; it does not substitute reduced cards. Steam and HLTB service availability remain external dependencies. Attribution is preserved in LICENSE-NOTICE.txt.
