const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  vm = require("node:vm");
const root = path.resolve(__dirname, ".."),
  sourceRoot = root,
  original = false,
  results = [];
const pw = require("playwright");
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log("PASS", name);
  } catch (error) {
    results.push({ name, pass: false, error: error.message });
    console.error("FAIL", name, error.message);
  }
}
async function main() {
  require("esbuild").buildSync({
    entryPoints: [path.join(__dirname, "native-fixture.jsx")],
    bundle: true,
    write: true,
    outfile: path.join(__dirname, ".generated/native-fixture.js"),
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const browser = await pw.firefox.launch({ headless: true });
  async function page(options = {}) {
    const p = await browser.newPage();
    p.on("pageerror", (e) => console.error("PAGE ERROR", e.message));
    await p.route("**/*", (r) =>
      r.fulfill({
        status: 200,
        contentType:
          r.request().resourceType() === "image"
            ? "image/svg+xml"
            : "text/html",
        body:
          r.request().resourceType() === "image"
            ? '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="85"><rect width="180" height="85" fill="#185789"/></svg>'
            : '<html><body><div id="root"></div></body></html>',
      }),
    );
    await p.goto(
      "https://store.steampowered.com/wishlist/id/test/?sort=discount",
    );
    await p.addScriptTag({
      content: fs.readFileSync(
        path.join(__dirname, ".generated/native-fixture.js"),
        "utf8",
      ),
    });
    await p.waitForFunction(() => window.fixture?.result);
    await p.evaluate((o) => Object.assign(fixture, o), options);
    await p.addScriptTag({
      content: fs.readFileSync(path.join(root, "native-renderer.js"), "utf8"),
    });
    await p.evaluate(() => {
      window.browser = {
        runtime: {
          sendMessage: async (m) => {
            if (m.type === "NATIVE_WISHLIST_VIEW") {
              if (window.bridgeDelay)
                await new Promise((r) => setTimeout(r, bridgeDelay));
              return nativeWishlistBridge(m.command);
            }
            if (m.type === "GET_STEAM_REVIEW_COUNTS") {
              fixture.calls.steam++;
              if (window.failSteam) return { ok: false, counts: {}, names: {} };
              if (window.metadataDelay)
                await new Promise((r) => setTimeout(r, metadataDelay));
              const counts = {},
                names = {};
              for (const id of m.appids) {
                let g = fixture.games.find((g) => String(g.appid) === id);
                if (g) {
                  names[id] = g.name;
                  if (g.reviews !== null) counts[id] = g.reviews;
                }
              }
              return { ok: true, counts, names };
            }
            if (m.type === "GET_HLTB") {
              fixture.calls.hltb++;
              let g = fixture.games.find(
                (g) => String(g.appid) === String(m.appid),
              );
              if (window.failHltb)
                return {
                  ok: false,
                  error: "cooldown",
                  retryAt: Date.now() + 60000,
                };
              return {
                ok: true,
                data: g?.hours
                  ? { mainStory: g.hours, hltbId: g.appid, gameName: g.name }
                  : null,
              };
            }
          },
        },
      };
    });
    await p.addStyleTag({
      content: fs.readFileSync(path.join(root, "styles.css"), "utf8"),
    });
    await p.addScriptTag({
      content:
        fs.readFileSync(path.join(root, "content.js"), "utf8") +
        "\nwindow.testApi={activateHltbSort,activateReviewSort,setMinimumReviewFilter,deactivateCustomSort,state:()=>({scanning:!!pipelinePromise,active:nativePresentationActive,minimum:activeReviewMin,mode:getActiveCustomSortMode(),expected:snapshotRecord?.expected})};",
    });
    await p.waitForTimeout(200);
    return p;
  }
  async function settled(p) {
    await p.waitForFunction(() => !testApi.state().scanning);
    await p.waitForTimeout(250);
  }
  async function ids(p) {
    return p.evaluate(() => fixture.result.items.map((g) => String(g.appid)));
  }
  async function expected(p, mode, min = 0) {
    return p.evaluate(
      ({ mode, min }) => {
        let rows = fixture.active.filter(
          (g) => !min || (g.reviews !== null && g.reviews >= min),
        );
        const source = new Map(fixture.active.map((g, i) => [g.appid, i]));
        return rows
          .slice()
          .sort((a, b) => {
            let key = mode.startsWith("reviews") ? "reviews" : "hours";
            let x = a[key],
              y = b[key];
            if (!mode) return source.get(a.appid) - source.get(b.appid);
            if (x === null || y === null)
              return x === y
                ? source.get(a.appid) - source.get(b.appid)
                : x === null
                  ? 1
                  : -1;
            return (
              (mode === "reviews-most" || mode === "longest" ? y - x : x - y) ||
              source.get(a.appid) - source.get(b.appid)
            );
          })
          .map((g) => String(g.appid));
      },
      { mode, min },
    );
  }
  async function nativeInformation(p) {
    await p.waitForTimeout(500);
    const violations = await p
      .locator("[data-rfd-draggable-id]")
      .evaluateAll((rows) =>
        rows.flatMap((row) => {
          let id = +row.dataset.rfdDraggableId.match(/WishlistItem-(\d+)/)[1],
            g = fixture.games.find((g) => g.appid === id);
          return !g ||
            !row.textContent.includes(g.price) ||
            !row.textContent.includes(`-${g.discount}%`) ||
            !row.textContent.includes(g.name) ||
            !row.querySelector('svg[aria-label="Windows"]') ||
            !row.querySelector("img") ||
            !row.querySelector(".cart") ||
            !row.querySelector(".remove") ||
            !row.querySelector(".category") ||
            !row.textContent.includes("Release Date") ||
            !row.textContent.includes("Very Positive") ||
            !row.textContent.includes("Added on")
            ? [id]
            : [];
        }),
      );
    assert.deepEqual(violations, []);
    assert.equal(await p.locator(".swpf-hltb-custom-sort-view").count(), 0);
  }
  for (const mode of ["reviews-most", "reviews-fewest", "shortest", "longest"])
    await check(
      `485 genuine React items: ${mode} retains all native information and HLTB`,
      async () => {
        let p = await page();
        await p.evaluate(
          (mode) =>
            mode.startsWith("reviews")
              ? testApi.activateReviewSort(mode)
              : testApi.activateHltbSort(mode),
          mode,
        );
        await settled(p);
        assert.deepEqual(await ids(p), await expected(p, mode));
        await nativeInformation(p);
        await p.waitForFunction(() =>
          Array.from(
            document.querySelectorAll("[data-rfd-draggable-id]"),
          ).every((r) => r.querySelector(".swpf-hltb-badge,.swpf-hltb-error")),
        );
        assert.ok(
          (
            await p.locator("#sort").evaluate((b) => {
              const css = getComputedStyle(b, "::after").content;
              return css.startsWith("attr(")
                ? b.dataset.swpfHltbSortLabel
                : css;
            })
          ).includes(
            mode === "shortest"
              ? "HLTB Shortest"
              : mode === "longest"
                ? "HLTB Longest"
                : mode === "reviews-most"
                  ? "Reviews Most"
                  : "Reviews Fewest",
          ),
        );
        await p.close();
      },
    );
  await check(
    "review minimum and clearing retain native prices, controls, graphics and selected sort",
    async () => {
      let p = await page();
      await p.evaluate(() => testApi.activateReviewSort("reviews-most"));
      for (const n of [2345, 1, 19999, 0]) {
        await p.evaluate((n) => testApi.setMinimumReviewFilter(n), n);
        await settled(p);
        assert.deepEqual(await ids(p), await expected(p, "reviews-most", n));
        assert.equal(
          await p.locator("#count").evaluate((e) => e.dataset.swpfDisplayCount),
          `${(await ids(p)).length.toLocaleString()} ITEMS`,
        );
        await nativeInformation(p);
      }
      await p.close();
    },
  );
  await check(
    "native 75% loading transition and clearing review minimum preserve genuine cards",
    async () => {
      let p = await page({ filterDelay: 800 });
      await p.evaluate(() => testApi.activateReviewSort("reviews-most"));
      await p.click("#options");
      await p.waitForFunction(
        () =>
          testApi.state().expected === 162 &&
          testApi.state().active &&
          !testApi.state().scanning,
      );
      await nativeInformation(p);
      await p.evaluate(() => testApi.setMinimumReviewFilter(2345));
      assert.deepEqual(await ids(p), await expected(p, "reviews-most", 2345));
      await p.evaluate(() => testApi.setMinimumReviewFilter(0));
      assert.equal((await ids(p)).length, 162);
      assert.ok(p.url().includes("min_discount=75"));
      await p.close();
    },
  );
  await check(
    "repeated all sorts and thresholds use one metadata membership result",
    async () => {
      let p = await page();
      for (let i = 0; i < 3; i++)
        for (const mode of [
          "reviews-most",
          "reviews-fewest",
          "shortest",
          "longest",
        ]) {
          await p.evaluate(
            (mode) =>
              mode.startsWith("reviews")
                ? testApi.activateReviewSort(mode)
                : testApi.activateHltbSort(mode),
            mode,
          );
          assert.deepEqual(await ids(p), await expected(p, mode));
        }
      assert.equal(await p.evaluate(() => fixture.calls.steam), 1);
      await nativeInformation(p);
      await p.close();
    },
  );
  await check(
    "latest intent wins during delayed metadata and native bridge calls",
    async () => {
      let p = await page();
      await p.evaluate(() => {
        window.metadataDelay = 250;
        window.bridgeDelay = 30;
        testApi.activateHltbSort("shortest");
        testApi.activateReviewSort("reviews-most");
        testApi.setMinimumReviewFilter(2000);
        testApi.activateReviewSort("reviews-fewest");
      });
      await settled(p);
      assert.deepEqual(await ids(p), await expected(p, "reviews-fewest", 2000));
      await nativeInformation(p);
      await p.close();
    },
  );
  await check(
    "scrolling hundreds of native virtual rows never caches stale prices or loses badges",
    async () => {
      let p = await page({ delay: 100 });
      await p.evaluate(() => testApi.activateReviewSort("reviews-most"));
      for (const offset of [12000, 44000, 76000, 0]) {
        await p
          .locator("#native-scroller")
          .evaluate((e, n) => (e.scrollTop = n), offset);
        await p.waitForTimeout(700);
        await nativeInformation(p);
        await p.waitForFunction(() =>
          Array.from(
            document.querySelectorAll("[data-rfd-draggable-id]"),
          ).every(
            (r) =>
              r.querySelector(".swpf-review-count-badge") &&
              r.querySelector(".swpf-hltb-badge,.swpf-hltb-error"),
          ),
        );
      }
      await p.close();
    },
  );
  await check(
    "slow partially rendered rows do not prevent authoritative 485-item native sort",
    async () => {
      let p = await page({ delay: 2200, paintDelay: 2200, shells: true });
      await p.evaluate(() => testApi.activateReviewSort("reviews-fewest"));
      assert.equal((await ids(p)).length, 485);
      assert.deepEqual(await ids(p), await expected(p, "reviews-fewest"));
      await p.waitForTimeout(2600);
      await nativeInformation(p);
      await p.close();
    },
  );
  await check(
    "real native cart and category callbacks survive custom sorting",
    async () => {
      let p = await page();
      await p.evaluate(() => testApi.activateReviewSort("reviews-most"));
      await nativeInformation(p);
      const id = await p
        .locator("[data-rfd-draggable-id]")
        .first()
        .getAttribute("data-rfd-draggable-id");
      await p.locator(".cart").first().click();
      await p.locator(".category").first().click();
      assert.equal(
        await p.evaluate(() => fixture.cart[0]),
        +id.match(/WishlistItem-(\d+)/)[1],
      );
      assert.equal(
        await p.evaluate(() => fixture.category),
        await p.evaluate(() => fixture.cart[0]),
      );
      await p.close();
    },
  );
  await check(
    "native local removal updates authoritative membership without resurrecting the item",
    async () => {
      let p = await page();
      await p.evaluate(() => testApi.activateReviewSort("reviews-most"));
      await nativeInformation(p);
      await p.locator(".remove").first().click();
      await p.waitForFunction(
        () =>
          testApi.state().expected === 484 &&
          testApi.state().active &&
          !testApi.state().scanning,
      );
      assert.equal((await ids(p)).length, 484);
      assert.ok(
        !(await ids(p)).includes(
          String(await p.evaluate(() => fixture.removed[0])),
        ),
      );
      await p.close();
    },
  );
  await check(
    "native search and clearing recalculate custom result without replacing cards",
    async () => {
      let p = await page();
      await p.evaluate(() => testApi.activateReviewSort("reviews-most"));
      await p.fill("#search", "Game 04");
      await p.waitForFunction(
        () =>
          testApi.state().expected === 10 &&
          testApi.state().active &&
          !testApi.state().scanning,
      );
      assert.deepEqual(await ids(p), await expected(p, "reviews-most"));
      await nativeInformation(p);
      await p.fill("#search", "");
      await p.waitForFunction(
        () =>
          testApi.state().expected === 485 &&
          testApi.state().active &&
          !testApi.state().scanning,
      );
      await p.close();
    },
  );
  await check(
    "zero-result review minimum and clear recover the native renderer",
    async () => {
      let p = await page();
      await p.evaluate(() => testApi.activateReviewSort("reviews-most"));
      await p.evaluate(() => testApi.setMinimumReviewFilter(999999));
      await settled(p);
      assert.equal((await ids(p)).length, 0);
      await p.evaluate(() => testApi.setMinimumReviewFilter(0));
      await settled(p);
      assert.equal((await ids(p)).length, 485);
      await nativeInformation(p);
      await p.close();
    },
  );
  await check(
    "clearing a standalone review filter restores exact native order",
    async () => {
      let p = await page();
      let original = await ids(p);
      await p.evaluate(() => testApi.setMinimumReviewFilter(2345));
      await p.evaluate(() => testApi.setMinimumReviewFilter(0));
      await settled(p);
      assert.deepEqual(await ids(p), original);
      await nativeInformation(p);
      await p.close();
    },
  );
  await check(
    "native sort restores original React state and native callbacks",
    async () => {
      let p = await page();
      await p.evaluate(() => testApi.activateReviewSort("reviews-most"));
      await p.click("#sort");
      await p
        .locator("#menu button")
        .filter({ hasText: /^Name$/ })
        .click();
      await settled(p);
      assert.equal(await p.evaluate(() => testApi.state().mode), null);
      assert.deepEqual(
        await ids(p),
        await p.evaluate(() => fixture.active.map((g) => String(g.appid))),
      );
      await nativeInformation(p);
      await p.close();
    },
  );
  await check(
    "API outage leaves complete original native cards available",
    async () => {
      let p = await page();
      let before = await ids(p);
      await p.evaluate(() => {
        window.failSteam = true;
        return testApi.activateReviewSort("reviews-most");
      });
      await settled(p);
      assert.deepEqual(await ids(p), before);
      assert.equal(await p.evaluate(() => testApi.state().active), false);
      await nativeInformation(p);
      await p.close();
    },
  );
  await check(
    "unsupported React structure fails without simplifying, hiding, or cloning native cards",
    async () => {
      let p = await page();
      let before = await ids(p);
      await p.evaluate(() => {
        nativeWishlistBridge = () => ({
          ok: false,
          error: "Unsupported native renderer",
        });
        return testApi.activateReviewSort("reviews-most");
      });
      await settled(p);
      assert.deepEqual(await ids(p), before);
      assert.equal(await p.locator(".swpf-hltb-custom-sort-view").count(), 0);
      await nativeInformation(p);
      await p.close();
    },
  );
  await check(
    "bridge rejects incomplete, stale, or foreign item mappings and restores safely",
    async () => {
      let p = await page();
      const r = await p.evaluate(() => {
        let source = nativeWishlistBridge({ action: "read" });
        let stale = nativeWishlistBridge({
          action: "apply",
          sourceAppids: ["bad"],
          appids: [],
        });
        let foreign = nativeWishlistBridge({
          action: "apply",
          sourceAppids: source.appids,
          appids: ["999999999"],
        });
        return { stale, foreign };
      });
      assert.equal(r.stale.ok, false);
      assert.equal(r.foreign.ok, false);
      assert.equal((await ids(p)).length, 485);
      await p.close();
    },
  );
  await browser.close();
  await check(
    "Firefox retained old host permissions: do not fetch or misreport missing access",
    async () => {
      const c = background();
      vm.runInContext(
        "browser.permissions = { contains: async () => false }",
        c,
      );
      const result = await vm.runInContext('getSteamReviewCounts(["1313"])', c);
      assert.equal(result.ok, false);
      assert.equal(result.error, "missing-steam-api-permission");
      assert.equal(c.requests.length, 0);
      vm.runInContext(
        "browser.permissions = { contains: async () => true }",
        c,
      );
      const retried = await vm.runInContext(
        'getSteamReviewCounts(["1313"])',
        c,
      );
      assert.equal(retried.counts["1313"], 13130);
      assert.equal(c.requests.length, 1);
    },
  );
  await check("background null count never becomes zero", async () => {
    const c = background();
    assert.equal(
      vm.runInContext(
        "pickSteamReviewCount({reviews:{summary_language_specific:{review_count:null},summary_filtered:{review_count:123}}})",
        c,
      ),
      123,
    );
    assert.equal(
      vm.runInContext(
        "pickSteamReviewCount({reviews:{summary_filtered:{review_count:null}}})",
        c,
      ),
      null,
    );
  });
  await check(
    "background cross-tab deduplication: 485 games use four cached batches",
    async () => {
      const c = background();
      await vm.runInContext(
        "Promise.all([getSteamReviewCounts(Array.from({length:485},(_,i)=>String(i+1))),getSteamReviewCounts(Array.from({length:485},(_,i)=>String(i+1)))])",
        c,
      );
      assert.equal(c.requests.length, 4);
      await vm.runInContext(
        "getSteamReviewCounts(Array.from({length:485},(_,i)=>String(i+1)))",
        c,
      );
      assert.equal(c.requests.length, 4);
    },
  );
  await check(
    "Steam rate-limit circuit stops remaining and subsequent batches",
    async () => {
      const c = background(429);
      await vm.runInContext(
        "getSteamReviewCounts(Array.from({length:485},(_,i)=>String(i+1)))",
        c,
      );
      await vm.runInContext("getSteamReviewCounts([999])", c);
      assert.equal(c.requests.length, 1);
    },
  );
  await check(
    "HLTB duplicate concurrent lookups share one request",
    async () => {
      const c = background();
      vm.runInContext(
        'queryHltb=async()=>{hltbCalls++;await sleep(20);return {mainStory:10,gameName:"Test"}}',
        c,
      );
      await vm.runInContext(
        'Promise.all([getHltbForGame("1","Test"),getHltbForGame("1","Test")])',
        c,
      );
      assert.equal(c.hltbCalls, 1);
    },
  );
  await check(
    "review cache separates languages, expires and preserves real zero",
    async () => {
      const c = background();
      await vm.runInContext('getSteamReviewCounts(["1"],"english")', c);
      await vm.runInContext('getSteamReviewCounts(["1"],"german")', c);
      assert.equal(c.requests.length, 2);
      await vm.runInContext(
        'browser.storage.local.set({[reviewCacheKey("1","english")]:{savedAt:Date.now()-8*86400000,count:1,name:"Old"}})',
        c,
      );
      await vm.runInContext('getSteamReviewCounts(["1"],"english")', c);
      assert.equal(c.requests.length, 3);
      await vm.runInContext(
        'browser.storage.local.set({[reviewCacheKey("2","english")]:{savedAt:Date.now(),count:0,name:"Zero"}})',
        c,
      );
      assert.equal(
        (await vm.runInContext('getSteamReviewCounts(["2"],"english")', c))
          .counts["2"],
        0,
      );
      assert.equal(c.requests.length, 3);
    },
  );
  await check(
    "missing Steam items are negatively cached without invented counts",
    async () => {
      const c = background();
      c.fetch = async () => {
        c.requests.push("missing");
        return {
          ok: true,
          json: async () => ({ response: { store_items: [] } }),
        };
      };
      const a = await vm.runInContext('getSteamReviewCounts(["1"])', c);
      const b = await vm.runInContext('getSteamReviewCounts(["1"])', c);
      assert.equal(a.counts["1"], undefined);
      assert.equal(b.counts["1"], undefined);
      assert.equal(c.requests.length, 1);
    },
  );
  await check(
    "HLTB title matching rejects conflicting sequel numbers and Steam IDs",
    async () => {
      const c = background();
      assert.equal(
        vm.runInContext('calculateTitleSimilarity("Portal","Portal 2")', c),
        0,
      );
      vm.runInContext(
        'getAuthData=async()=>({token:"test"});performSearch=async()=>({data:[{profile_steam:2,game_id:5,game_name:"Portal",comp_main:3600}]})',
        c,
      );
      assert.equal(
        await vm.runInContext('queryHltbOnce("Portal","1","/api/test")', c),
        null,
      );
    },
  );
  await check(
    "live HLTB cooldown resolves queued misses instead of stalling the full sort",
    async () => {
      const c = background();
      vm.runInContext(
        "getCached=async()=>undefined;hltbBlockedUntil=Date.now()+60000;",
        c,
      );
      c.setTimeout = () => 0;
      const result = await Promise.race([
        vm.runInContext(
          'Promise.all([getHltbForGame("1","One"),getHltbForGame("2","Two")])',
          c,
        ),
        new Promise((resolve) => setTimeout(() => resolve(null), 150)),
      ]);
      assert.ok(result, "queued HLTB lookups stalled during cooldown");
      assert.ok(result.every((r) => r.ok === false && r.retryAt > Date.now()));
      assert.equal(c.requests.length, 0);
      assert.equal(vm.runInContext("hltbRequestQueue.length", c), 0);
    },
  );
  await check("HLTB shared cooldown prevents HTTP requests", async () => {
    const c = background();
    vm.runInContext("hltbBlockedUntil=Date.now()+60000", c);
    await assert.rejects(
      vm.runInContext(
        'pacedHltbFetch("https://howlongtobeat.com/api/test",{})',
        c,
      ),
    );
    assert.equal(c.requests.length, 0);
  });
  await check(
    "HLTB cache expires positive data and invalidates changed negative titles",
    async () => {
      const c = background();
      await vm.runInContext('saveCached("1",null,"Wrong title")', c);
      assert.equal(
        await vm.runInContext('getCached("1","Canonical title")', c),
        undefined,
      );
      await vm.runInContext(
        'browser.storage.local.set({[cacheKey("2")]:{cachedAt:Date.now()-8*86400000,found:true,cacheVersion:CACHE_SCHEMA_VERSION,sourceName:"Portal",data:{gameName:"Portal",steamId:2}}})',
        c,
      );
      assert.equal(
        await vm.runInContext('getCached("2","Portal")', c),
        undefined,
      );
    },
  );
  await check(
    "real Steam response contract: country code yields canonical names and counts",
    async () => {
      const c = background();
      const observed = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "responses/steam-ca-two-games.json"),
          "utf8",
        ),
      );
      c.fetch = async (url) => {
        c.requests.push(url);
        const p = JSON.parse(new URL(url).searchParams.get("input_json"));
        assert.equal(p.context.country_code, "CA");
        return { ok: true, status: 200, json: async () => observed };
      };
      const result = await vm.runInContext(
        'getSteamReviewCounts(["1313","1700"],"english","CA")',
        c,
      );
      assert.equal(result.names["1313"], "SiN Gold (1998)");
      assert.equal(result.names["1700"], "Arx Fatalis");
      assert.equal(result.counts["1700"], 1261);
      assert.equal(c.requests.length, 1);
    },
  );
  await check(
    "HTTP 200 empty response is a failure and cannot poison the metadata cache",
    async () => {
      const c = background();
      const observed = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "responses/steam-missing-country.json"),
          "utf8",
        ),
      );
      c.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => observed,
      });
      await assert.rejects(
        vm.runInContext('fetchSteamReviewBatch(["1313"],"english","CA")', c),
      );
      assert.equal(
        (
          await vm.runInContext(
            'getCachedReviewCounts(["1313"],"english","CA")',
            c,
          )
        ).missing.length,
        1,
      );
    },
  );
  await check("review cache separates country contexts", async () => {
    const c = background();
    await vm.runInContext('getSteamReviewCounts(["1"],"english","CA")', c);
    await vm.runInContext('getSteamReviewCounts(["1"],"english","US")', c);
    assert.equal(c.requests.length, 2);
  });
  fs.writeFileSync(
    path.join(root, "test-results.json"),
    JSON.stringify(
      {
        browser: "Firefox",
        renderer: "Real React native wishlist fixture",
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    `${results.filter((r) => r.pass).length}/${results.length} scenarios passed`,
  );
  if (results.some((r) => !r.pass)) process.exitCode = 1;
}
function background(status = 200) {
  const stored = {},
    requests = [];
  const c = vm.createContext({
    console: { log() {}, warn() {}, debug() {} },
    setTimeout,
    clearTimeout,
    URL,
    AbortController,
    requests,
    hltbCalls: 0,
    fetch: async (url) => {
      requests.push(url);
      const payload = JSON.parse(new URL(url).searchParams.get("input_json"));
      const ids = payload.ids;
      // Steam returns HTTP 200 with an empty response if country_code is omitted.
      if (!payload.context.country_code)
        return { ok: true, status: 200, json: async () => ({ response: {} }) };
      return {
        ok: status === 200,
        status,
        headers: { get: () => "60" },
        json: async () => ({
          response: {
            store_items: ids.map(({ appid }) => ({
              appid,
              name: `Game ${appid}`,
              reviews: { summary_filtered: { review_count: appid * 10 } },
            })),
          },
        }),
      };
    },
    browser: {
      storage: {
        local: {
          get: async (keys) =>
            keys === null
              ? stored
              : Object.fromEntries(
                  (Array.isArray(keys) ? keys : [keys]).map((k) => [
                    k,
                    stored[k],
                  ]),
                ),
          set: async (o) => Object.assign(stored, o),
          remove: async () => {},
        },
      },
      runtime: { onMessage: { addListener() {} } },
      declarativeNetRequest: { updateDynamicRules: async () => {} },
    },
  });
  vm.runInContext(
    fs.readFileSync(path.join(sourceRoot, "background.js"), "utf8"),
    c,
  );
  return c;
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
