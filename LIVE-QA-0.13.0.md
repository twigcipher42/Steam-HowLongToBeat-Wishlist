# Signed-in Firefox verification — 0.13.0

The previous simplified-card implementation removed normal Steam information. That was an architectural regression, and passing mock tests did not establish product correctness. Version 0.13.0 keeps Steam's actual React cards and adds badges to them.

Tested the existing temporary add-on on the real signed-in 485-game wishlist through Firefox's debugger and its actual WebExtension message/scripting path. Signed-in screenshots and session captures are kept outside this public repository.

## Results

- Reviews Most and Fewest: 485 unique native items, correct ordering, visible labels; 482 known counts and three unknowns last.
- HLTB Shortest and Longest: 485 unique native items, correct ordering, visible labels; 441 known times and unavailable entries last.
- Review minimum 2,345: 198 items; native 75% discount plus that minimum: 52 items; clearing the minimum restores the 162-item discount result; clearing native discount restores 485.
- On the first actual Reviews Most card, HELLDIVERS 2 retains artwork/graphics, categories, release date, native English review rating, tags, -25%, C$49.99/C$37.49, Add to Cart, added date, remove control, REV 635,207, and HLTB 32h. Red Dead Redemption 2 retains -75%, C$79.99/C$19.99, and HLTB 51h. The Witcher 3 retains -50%, C$69.99/C$34.99, and HLTB 57h.
- A 40,000px scroll in HLTB Longest produced 27 recycled/overscan rows at indices 217–243. Every row matched the corresponding item in the native sorted result, retained matching app links, had nonzero card height, and included both review and HLTB badges.
- Zero simplified/replacement cards were present. Native React remains responsible for pricing, content hydration, graphics and control handlers. Live cart/removal actions were not invoked; corresponding callbacks were exercised in the React fixture.

The installed files match the tested source. All 33 automated scenarios pass independently of these live checks. Review metadata/order was cross-checked against the actual background cache; HLTB ordering was cross-checked against actual cached times. Unknown values remain explicit. Final state: Reviews Most, 485 native cards, no review minimum and no native discount minimum.

## Limits

This validates the current Steam React implementation and this signed-in dataset. The isolated adapter uses undocumented React presentation internals; future changes may require an update. Unsupported structures must retain native cards and report failure. Live service availability and unavailable/unmatched HLTB entries are not guaranteed.
