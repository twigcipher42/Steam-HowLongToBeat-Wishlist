/*
 * Steam Wishlist Plus - Firefox HLTB background script
 * Firefox port based on the Apache-2.0 Steam Wishlist Plus project:
 * https://github.com/keyunjie96/steam-wishlist-plus
 *
 * HLTB's internal search endpoint is intentionally NOT hard-coded. HLTB has
 * changed it multiple times, so this script discovers the current POST
 * /api/... endpoint from the site's JS bundles and refreshes it on failures.
 */

"use strict";

const ext = globalThis.browser ?? globalThis.chrome;

const HLTB_BASE_URL = "https://howlongtobeat.com";
const CACHE_PREFIX = "swpf_hltb_";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_SCHEMA_VERSION = 6;
const ENDPOINT_CACHE_KEY = "swpf_hltb_search_endpoint";
const ENDPOINT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const HLTB_MAX_CONCURRENT = 3;
const HLTB_MIN_START_GAP_MS = 350;
const HLTB_REQUEST_TIMEOUT_MS = 9000;
const RULE_ID = 7001;
const REVIEW_CACHE_PREFIX = "swpf_review_v11_";
const REVIEW_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STEAM_REVIEW_BATCH_SIZE = 150;
const STEAM_REVIEW_TIMEOUT_MS = 9000;

let hltbActiveRequests = 0;
let hltbLastStartAt = 0;
let hltbBlockedUntil = 0;
const hltbFlights = new Map();
let authFlight = null;
let hltbHttpGate = Promise.resolve();
let hltbLastHttpStart = 0;
async function pacedHltbFetch(url, options) {
  const gate = hltbHttpGate.then(async () => {
    if (Date.now() < hltbBlockedUntil) {
      const error = new Error("HLTB rate-limit cooldown");
      error.status = 429;
      throw error;
    }
    await sleep(
      Math.max(0, HLTB_MIN_START_GAP_MS - (Date.now() - hltbLastHttpStart)),
    );
    hltbLastHttpStart = Date.now();
  });
  hltbHttpGate = gate.catch(() => {});
  await gate;
  const response = await fetch(url, options);
  if (response.status === 429) {
    const value = response.headers?.get("Retry-After");
    const seconds = Number(value),
      date = Date.parse(value);
    const delay =
      Number.isFinite(seconds) && seconds > 0
        ? seconds * 1000
        : Number.isFinite(date)
          ? date - Date.now()
          : 60000;
    hltbBlockedUntil = Date.now() + Math.max(60000, delay);
  }
  return response;
}
const hltbRequestQueue = [];
let headerRuleReady = null;
let inMemorySearchEndpoint = null;
let endpointDiscoveryPromise = null;
let hltbAuthCache = null;
const HLTB_AUTH_TTL_MS = 5 * 60 * 1000;

async function timedFetch(url, options = {}) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), HLTB_REQUEST_TIMEOUT_MS);
  try {
    return await pacedHltbFetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeGameName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function calculateSimilarity(a, b) {
  const aNorm = normalizeGameName(a);
  const bNorm = normalizeGameName(b);

  if (!aNorm || !bNorm) return 0;
  if (aNorm === bNorm) return 1;

  if (aNorm.includes(bNorm) || bNorm.includes(aNorm)) {
    const shorter = aNorm.length < bNorm.length ? aNorm : bNorm;
    const longer = aNorm.length >= bNorm.length ? aNorm : bNorm;
    return shorter.length / longer.length;
  }

  const ngrams = (value) => {
    const set = new Set();
    for (let i = 0; i < value.length - 1; i += 1) {
      set.add(value.slice(i, i + 2));
    }
    return set;
  };

  const aa = ngrams(aNorm);
  const bb = ngrams(bNorm);
  if (!aa.size || !bb.size) return 0;

  let intersection = 0;
  for (const gram of aa) {
    if (bb.has(gram)) intersection += 1;
  }
  const union = aa.size + bb.size - intersection;
  return union ? intersection / union : 0;
}

function titleTokens(name) {
  const roman = {
    i: "1",
    ii: "2",
    iii: "3",
    iv: "4",
    v: "5",
    vi: "6",
    vii: "7",
    viii: "8",
    ix: "9",
    x: "10",
  };

  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => roman[token] || token);
}

function tokenDiceSimilarity(a, b) {
  const aa = titleTokens(a);
  const bb = titleTokens(b);
  if (!aa.length || !bb.length) return 0;

  const aCounts = new Map();
  const bCounts = new Map();
  for (const token of aa) aCounts.set(token, (aCounts.get(token) || 0) + 1);
  for (const token of bb) bCounts.set(token, (bCounts.get(token) || 0) + 1);

  let intersection = 0;
  for (const [token, count] of aCounts) {
    intersection += Math.min(count, bCounts.get(token) || 0);
  }

  return (2 * intersection) / (aa.length + bb.length);
}

function calculateTitleSimilarity(a, b) {
  if (!a || !b) return 0;
  const numbers = (value) =>
    titleTokens(value)
      .filter((token) => /^\d+$/.test(token))
      .join(",");
  if (numbers(a) !== numbers(b)) return 0;
  return Math.max(calculateSimilarity(a, b), tokenDiceSimilarity(a, b));
}

function getSafeSteamTitleVariants(name) {
  const original = normalizeSearchText(name);
  const cleaned = cleanGameNameForSearch(original);
  const variants = [];
  const seen = new Set();

  const add = (value) => {
    value = normalizeSearchText(value).trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(value);
  };

  add(original);
  add(cleaned);

  // Some Steam titles contain a descriptive subtitle that HLTB omits, e.g.
  // "Fallout 2: A Post Nuclear Role Playing Game" -> "Fallout 2".
  // Only trust the prefix when it contains at least two meaningful tokens or
  // a number. This deliberately rejects a one-word prefix such as "Fobia" in
  // "Fobia - St. Dinfna Hotel", preventing the false match fixed in v0.10.10.
  for (const source of [original, cleaned]) {
    const match = source.match(/^(.+?)(?:\s*:\s*|\s+-\s+|\s+\|\s+).+$/);
    if (!match) continue;
    const prefix = match[1].trim();
    const tokens = titleTokens(prefix);
    const hasNumber = /\d/.test(prefix);
    if (tokens.length >= 2 || hasNumber) add(prefix);
  }

  return variants;
}

function getGameTitleVariants(game) {
  const variants = [String(game?.game_name || "")];
  const alias = String(game?.game_alias || "").trim();
  if (alias) {
    variants.push(alias);
    // HLTB sometimes stores multiple aliases in a single field.
    alias.split(/\s*[|;]\s*/).forEach((value) => {
      if (value) variants.push(value);
    });
  }
  return variants.filter(Boolean);
}

const EDITION_SUFFIXES = [
  "Definitive Edition",
  "Game of the Year Edition",
  "GOTY Edition",
  "Enhanced Edition",
  "Complete Edition",
  "Ultimate Edition",
  "Special Edition",
  "Deluxe Edition",
  "Anniversary Edition",
  "Gold Edition",
  "Reloaded Edition",
  "Collector's Edition",
  "Digital Deluxe Edition",
  "Remastered",
  "Remaster",
  "HD Remaster",
  "HD Remastered",
  "Director's Cut Edition",
  "Director's Cut",
  "Veteran Edition",
  "Steam Edition",
  "The Original Classic",
  "Classic",
];

function normalizeSearchText(name) {
  return String(name || "")
    .replace(/[™®©]/g, "")
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function stripEditionSuffix(name) {
  let value = normalizeSearchText(name);
  const lower = value.toLowerCase();

  for (const suffix of EDITION_SUFFIXES) {
    const suffixLower = suffix.toLowerCase();
    if (!lower.endsWith(suffixLower)) continue;

    value = value.slice(0, value.length - suffix.length).trim();
    // Steam commonly separates edition names with '-', ':', or parentheses.
    value = value
      .replace(/\s*[-:|]\s*$/, "")
      .replace(/[\s(\[]+$/, "")
      .trim();
    return value;
  }

  return value;
}

function cleanGameNameForSearch(name) {
  let cleaned = normalizeSearchText(name);

  // Remove trailing bracketed edition/platform labels first.
  cleaned = cleaned
    .replace(
      /\s*[\[(](?:[^\])]*(?:edition|remaster|remastered|classic|version|bundle))[^\])]*[\])]\s*$/i,
      "",
    )
    .trim();
  cleaned = stripEditionSuffix(cleaned);

  return cleaned || normalizeSearchText(name);
}

function generateSearchAlternatives(name) {
  const original = normalizeSearchText(name);
  const cleaned = cleanGameNameForSearch(original);
  const alternatives = [];
  const seen = new Set();

  const add = (value) => {
    value = normalizeSearchText(value)
      .replace(/\s*[-:|]\s*$/, "")
      .trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    alternatives.push(value);
  };

  add(original);
  add(cleaned);

  // Steam sometimes uses a hyphen where HLTB uses a subtitle colon. This is
  // particularly important for names such as "Fobia - St. Dinfna Hotel".
  add(cleaned.replace(/\s+-\s+/g, ": "));

  // If Steam appended an edition after a separator, try the base title.
  add(
    original.replace(
      /\s+(?:-|:|\|)\s+(?:the\s+)?(?:gold|complete|ultimate|special|deluxe|definitive|enhanced|anniversary|reloaded|original|collector'?s?|digital deluxe).*$/i,
      "",
    ),
  );

  // HLTB often omits a marketing subtitle after a colon. Keep this as a
  // fallback only; exact Steam App ID matching still wins when available.
  const colonIndex = cleaned.indexOf(":");
  if (colonIndex > 2) add(cleaned.slice(0, colonIndex));

  // HLTB search behaves like an AND search for some titles. Gradually remove
  // trailing marketing words until at least two useful title words remain.
  // This is especially helpful for "Wasteland 1 - The Original Classic" and
  // "Dying Light 2 Stay Human: Reloaded Edition" style Steam names.
  const words = cleaned.split(/\s+/).filter((word) => /[a-z0-9]/i.test(word));
  for (
    let length = words.length - 1;
    length >= 2 && alternatives.length < 7;
    length -= 1
  ) {
    add(words.slice(0, length).join(" "));
  }

  // Parenthetical Steam subtitles/labels are often absent on HLTB.
  add(
    cleaned
      .replace(/\s*\([^)]*\)\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  add(
    cleaned
      .replace(/\s*\[[^\]]*\]\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

  // '&' and 'and' are indexed inconsistently across storefronts.
  if (cleaned.includes("&")) add(cleaned.replace(/&/g, "and"));
  if (/\band\b/i.test(cleaned)) add(cleaned.replace(/\band\b/gi, "&"));

  // Roman numerals versus Arabic numerals are another common storefront mismatch.
  const romanToArabic = {
    I: "1",
    II: "2",
    III: "3",
    IV: "4",
    V: "5",
    VI: "6",
    VII: "7",
    VIII: "8",
    IX: "9",
    X: "10",
  };
  add(
    cleaned
      .split(/\s+/)
      .map((word) => romanToArabic[word.toUpperCase()] || word)
      .join(" "),
  );

  // Colon insertion helps titles where HLTB uses punctuation Steam omits.
  if (!cleaned.includes(":")) {
    const cleanWords = cleaned
      .split(/\s+/)
      .filter((word) => /[a-z0-9]/i.test(word));
    for (
      let i = 1;
      i <= Math.min(cleanWords.length - 1, 4) && alternatives.length < 14;
      i += 1
    ) {
      add(
        `${cleanWords.slice(0, i).join(" ")}: ${cleanWords.slice(i).join(" ")}`,
      );
    }
  }

  return alternatives.slice(0, 14);
}

function secondsToHours(seconds) {
  const value = Number(seconds) || 0;
  return value > 0 ? Math.round((value / 3600) * 10) / 10 : 0;
}

function convertGameData(game) {
  return {
    hltbId: Number(game.game_id) || 0,
    gameName: String(game.game_name || ""),
    steamId: Number(game.profile_steam) || null,
    mainStory: secondsToHours(game.comp_main),
    mainExtra: secondsToHours(game.comp_plus),
    completionist: secondsToHours(game.comp_100),
    allStyles: secondsToHours(game.comp_all),
  };
}

async function ensureHeaderRule() {
  if (headerRuleReady) return headerRuleReady;

  headerRuleReady = (async () => {
    const dnr = ext?.declarativeNetRequest;
    if (!dnr?.updateDynamicRules) return false;

    try {
      await dnr.updateDynamicRules({
        removeRuleIds: [RULE_ID],
        addRules: [
          {
            id: RULE_ID,
            priority: 1,
            action: {
              type: "modifyHeaders",
              requestHeaders: [
                { header: "Origin", operation: "set", value: HLTB_BASE_URL },
                {
                  header: "Referer",
                  operation: "set",
                  value: `${HLTB_BASE_URL}/`,
                },
              ],
            },
            condition: {
              urlFilter: "||howlongtobeat.com/api/",
              resourceTypes: ["xmlhttprequest"],
            },
          },
        ],
      });
      return true;
    } catch (error) {
      console.warn("[SWP Firefox] Could not install HLTB header rule:", error);
      return false;
    }
  })();

  return headerRuleReady;
}

function extractScriptUrls(html) {
  const urls = [];
  const seen = new Set();
  const regex = /<script[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const src = match[1];
    if (!src || seen.has(src)) continue;
    seen.add(src);
    urls.push(src);
  }

  // HLTB's current search code has typically lived in the _app bundle.
  return [
    ...urls.filter((url) => url.includes("_app-")),
    ...urls.filter((url) => !url.includes("_app-")),
  ];
}

function extractSearchEndpoint(scriptText) {
  // Mirrors the strategy used by current HLTB clients: find a JS fetch() call
  // that POSTs to a /api/... path. "find" is the retired legacy endpoint.
  const regex =
    /fetch\s*\(\s*["']\/api\/([a-zA-Z0-9_/]+)[^"']*["']\s*,\s*\{[\s\S]*?method\s*:\s*["']POST["'][\s\S]*?\}/gi;
  let match;

  while ((match = regex.exec(scriptText)) !== null) {
    const suffix = String(match[1] || "").replace(/^\/+|\/+$/g, "");
    if (!suffix) continue;

    const firstSegment = suffix.split("/")[0].toLowerCase();
    if (firstSegment === "find") continue;
    return `/api/${suffix}`;
  }

  return null;
}

async function readCachedEndpoint() {
  try {
    const stored = await ext.storage.local.get(ENDPOINT_CACHE_KEY);
    const record = stored?.[ENDPOINT_CACHE_KEY];
    if (!record?.endpoint || typeof record.cachedAt !== "number") return null;
    if (Date.now() - record.cachedAt > ENDPOINT_CACHE_TTL_MS) return null;
    return String(record.endpoint);
  } catch {
    return null;
  }
}

async function saveEndpoint(endpoint) {
  try {
    await ext.storage.local.set({
      [ENDPOINT_CACHE_KEY]: {
        endpoint,
        cachedAt: Date.now(),
      },
    });
  } catch {
    // Endpoint caching is just an optimization; discovery can still work.
  }
}

async function clearEndpointCache() {
  inMemorySearchEndpoint = null;
  try {
    await ext.storage.local.remove(ENDPOINT_CACHE_KEY);
  } catch {
    // Ignore storage cleanup failures.
  }
}

async function discoverSearchEndpoint(forceRefresh = false) {
  if (!forceRefresh && inMemorySearchEndpoint) return inMemorySearchEndpoint;

  if (!forceRefresh) {
    const cached = await readCachedEndpoint();
    if (cached) {
      inMemorySearchEndpoint = cached;
      return cached;
    }
  }

  if (endpointDiscoveryPromise) return endpointDiscoveryPromise;

  endpointDiscoveryPromise = (async () => {
    console.log("[SWP Firefox] Discovering current HLTB search endpoint...");

    const homepageResponse = await timedFetch(`${HLTB_BASE_URL}/`, {
      cache: "no-store",
      credentials: "omit",
    });
    if (!homepageResponse.ok) {
      throw new Error(`HLTB homepage returned ${homepageResponse.status}`);
    }

    const html = await homepageResponse.text();
    const scriptUrls = extractScriptUrls(html);
    if (!scriptUrls.length) {
      throw new Error("HLTB endpoint discovery found no script bundles");
    }

    for (const src of scriptUrls) {
      let scriptUrl;
      try {
        scriptUrl = new URL(src, `${HLTB_BASE_URL}/`).href;
      } catch {
        continue;
      }

      try {
        const response = await timedFetch(scriptUrl, {
          cache: "no-store",
          credentials: "omit",
        });
        if (!response.ok) continue;

        const scriptText = await response.text();
        const endpoint = extractSearchEndpoint(scriptText);
        if (!endpoint) continue;

        inMemorySearchEndpoint = endpoint;
        await saveEndpoint(endpoint);
        console.log(`[SWP Firefox] Discovered HLTB endpoint: ${endpoint}`);
        return endpoint;
      } catch (error) {
        console.debug(
          "[SWP Firefox] Skipping HLTB script during endpoint discovery:",
          error,
        );
      }
    }

    throw new Error("Could not discover HLTB search endpoint");
  })();

  try {
    return await endpointDiscoveryPromise;
  } finally {
    endpointDiscoveryPromise = null;
  }
}

function getAuthData(endpoint, forceRefresh = false) {
  if (authFlight) return authFlight;
  authFlight = fetchAuthData(endpoint, forceRefresh).finally(() => {
    authFlight = null;
  });
  return authFlight;
}
async function fetchAuthData(endpoint, forceRefresh = false) {
  if (
    !forceRefresh &&
    hltbAuthCache &&
    hltbAuthCache.endpoint === endpoint &&
    Date.now() - hltbAuthCache.cachedAt < HLTB_AUTH_TTL_MS
  ) {
    return hltbAuthCache.data;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HLTB_REQUEST_TIMEOUT_MS);
  try {
    const response = await pacedHltbFetch(
      `${HLTB_BASE_URL}${endpoint}/init?t=${Date.now()}`,
      {
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const error = new Error(`HLTB init returned ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
    if (!data?.token) throw new Error("HLTB init did not return an auth token");

    const auth = {
      token: String(data.token),
      hpKey: String(data.hpKey || "").trim(),
      hpVal: String(data.hpVal || "").trim(),
    };
    hltbAuthCache = { endpoint, data: auth, cachedAt: Date.now() };
    return auth;
  } finally {
    clearTimeout(timeout);
  }
}

function createSearchPayload(gameName, auth) {
  const payload = {
    searchType: "games",
    searchTerms: gameName.trim().split(/\s+/),
    searchPage: 1,
    size: 20,
    searchOptions: {
      games: {
        userId: 0,
        platform: "",
        sortCategory: "popular",
        rangeCategory: "main",
        rangeTime: { min: 0, max: 0 },
        gameplay: { perspective: "", flow: "", genre: "", difficulty: "" },
        rangeYear: { min: "", max: "" },
        modifier: "",
      },
      users: { sortCategory: "postcount" },
      lists: { sortCategory: "follows" },
      filter: "",
      sort: 0,
      randomizer: 0,
    },
    useCache: true,
  };

  // Newer HLTB auth can be token-only. Add honeypot data only when HLTB
  // actually supplied both fields.
  if (auth.hpKey && auth.hpVal) {
    payload[auth.hpKey] = auth.hpVal;
  }

  return payload;
}

async function performSearch(endpoint, searchName, auth) {
  const headers = {
    "Content-Type": "application/json",
    "x-auth-token": auth.token,
  };

  if (auth.hpKey && auth.hpVal) {
    headers["x-hp-key"] = auth.hpKey;
    headers["x-hp-val"] = auth.hpVal;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HLTB_REQUEST_TIMEOUT_MS);
  try {
    const response = await pacedHltbFetch(`${HLTB_BASE_URL}${endpoint}`, {
      method: "POST",
      credentials: "omit",
      headers,
      body: JSON.stringify(createSearchPayload(searchName, auth)),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = new Error(`HLTB search returned ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function queryHltbOnce(
  gameName,
  steamAppId,
  endpoint,
  forceAuthRefresh = false,
) {
  const originalName = normalizeSearchText(gameName);
  const cleanedName = cleanGameNameForSearch(originalName);
  const alternatives = generateSearchAlternatives(originalName);
  const auth = await getAuthData(endpoint, forceAuthRefresh);
  const appIdNum = Number(steamAppId);

  let best = null;
  let bestScore = 0;
  const seenGameIds = new Set();

  for (const candidate of alternatives) {
    const result = await performSearch(endpoint, candidate, auth);
    const games = Array.isArray(result?.data) ? result.data : [];
    if (!games.length) continue;

    // Steam App ID is the strongest possible match. Keep searching alternate
    // title forms until this is found instead of stopping at the first fuzzy
    // result set.
    if (Number.isFinite(appIdNum)) {
      const exactSteamMatch = games.find(
        (game) => Number(game.profile_steam) === appIdNum,
      );
      if (exactSteamMatch) return convertGameData(exactSteamMatch);
    }

    for (const game of games) {
      if (
        Number(game.profile_steam) > 0 &&
        Number(game.profile_steam) !== appIdNum
      )
        continue;
      const gameId = Number(game.game_id) || `${game.game_name}`;
      if (seenGameIds.has(gameId)) continue;
      seenGameIds.add(gameId);

      // Score against the Steam title, the cleaned title, and the specific
      // fallback query that produced this result. Edition-heavy Steam titles
      // can otherwise unfairly fail the confidence threshold.
      // Fallback queries are retrieval aids only. Never score a result against
      // a shortened fallback such as "Fobia": doing that can turn an
      // unrelated short-title result into a fake 100% match for a longer Steam
      // title such as "Fobia - St. Dinfna Hotel". Confidence is based only
      // on the real Steam title (or its safe edition-stripped form).
      const titleVariants = getGameTitleVariants(game);
      const steamTitleVariants = getSafeSteamTitleVariants(originalName);
      const score = Math.max(
        ...titleVariants.flatMap((title) =>
          steamTitleVariants.map((reference) =>
            calculateTitleSimilarity(reference, title),
          ),
        ),
      );

      if (score > bestScore) {
        bestScore = score;
        best = game;
      }
    }

    // Once a very strong textual match is found, more progressively shorter
    // queries are unlikely to improve it and only add network traffic.
    if (
      bestScore >= 0.985 &&
      (candidate === originalName || candidate === cleanedName)
    )
      break;
  }

  // Avoid confidently wrong fuzzy matches, but allow cleaned-edition names to
  // match slightly more generously than the previous implementation.
  if (!best || bestScore < 0.85) return null;
  return convertGameData(best);
}

async function queryHltb(gameName, steamAppId) {
  await ensureHeaderRule();

  let endpoint = await discoverSearchEndpoint(false);

  try {
    return await queryHltbOnce(gameName, steamAppId, endpoint);
  } catch (error) {
    // A 404/405 normally means HLTB deployed a new internal search endpoint.
    // Invalidate the endpoint and discover the fresh one immediately.
    if (error?.status === 404 || error?.status === 405) {
      console.warn(
        `[SWP Firefox] HLTB endpoint ${endpoint} is stale; rediscovering...`,
      );
      await clearEndpointCache();
      hltbAuthCache = null;
      endpoint = await discoverSearchEndpoint(true);
      return queryHltbOnce(gameName, steamAppId, endpoint, true);
    }
    if (error?.status === 401 || error?.status === 403) {
      hltbAuthCache = null;
      return queryHltbOnce(gameName, steamAppId, endpoint, true);
    }
    throw error;
  }
}

function cacheKey(appid) {
  return `${CACHE_PREFIX}${appid}`;
}

async function getCached(appid, gameName) {
  try {
    const result = await ext.storage.local.get(cacheKey(appid));
    const record = result?.[cacheKey(appid)];
    if (!record || typeof record.cachedAt !== "number") return undefined;

    // Matcher v5 adds conservative subtitle-prefix matching while preserving strict fallback validation. Old negative records
    // must be retried, and old positive records are kept only when they still
    // pass the stricter title/App-ID validation. This invalidates a cached
    // wrong "Fobia" match without throwing away every good cached result.
    if (
      record.cacheVersion !== CACHE_SCHEMA_VERSION ||
      (record.found && record.sourceName !== normalizeSearchText(gameName))
    ) {
      if (record.found === false) return undefined;

      const cachedData = record.data || {};
      const appIdNum = Number(appid);
      const cachedSteamId = Number(cachedData.steamId);
      const exactSteamId =
        Number.isFinite(appIdNum) &&
        Number.isFinite(cachedSteamId) &&
        cachedSteamId > 0 &&
        cachedSteamId === appIdNum;
      const titleScore = Math.max(
        calculateTitleSimilarity(
          normalizeSearchText(gameName),
          cachedData.gameName || "",
        ),
        calculateTitleSimilarity(
          cleanGameNameForSearch(gameName),
          cachedData.gameName || "",
        ),
      );

      if (!exactSteamId && titleScore < 0.85) return undefined;
    }

    if (record.data?.steamId && Number(record.data.steamId) !== Number(appid))
      return undefined;
    if (
      record.found === false &&
      record.sourceName !== normalizeSearchText(gameName)
    )
      return undefined;
    const ttl = record.found === false ? NOT_FOUND_TTL_MS : CACHE_TTL_MS;
    if (Date.now() - record.cachedAt > ttl) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

async function saveCached(appid, data, gameName) {
  const record = {
    found: Boolean(data),
    data: data || null,
    cachedAt: Date.now(),
    cacheVersion: CACHE_SCHEMA_VERSION,
    sourceName: normalizeSearchText(gameName),
  };
  await ext.storage.local.set({ [cacheKey(appid)]: record });
}

function pumpHltbQueue() {
  if (!hltbRequestQueue.length) return;
  const now = Date.now();
  // A rate limit is an unavailable result, not a delayed invitation to resume
  // hundreds of queued searches. Cached results still resolve before enqueue.
  if (now < hltbBlockedUntil) {
    while (hltbRequestQueue.length) {
      hltbRequestQueue.shift().resolve({
        ok: false,
        data: null,
        error: "HLTB rate-limit cooldown",
        retryAt: hltbBlockedUntil,
      });
    }
    return;
  }
  if (hltbActiveRequests >= HLTB_MAX_CONCURRENT) return;
  const waitFor = Math.max(0, HLTB_MIN_START_GAP_MS - (now - hltbLastStartAt));
  if (waitFor > 0) {
    setTimeout(pumpHltbQueue, waitFor);
    return;
  }

  const entry = hltbRequestQueue.shift();
  hltbActiveRequests += 1;
  hltbLastStartAt = Date.now();

  Promise.resolve()
    .then(entry.task)
    .then(entry.resolve, entry.reject)
    .finally(() => {
      hltbActiveRequests = Math.max(0, hltbActiveRequests - 1);
      pumpHltbQueue();
    });

  // Fill the remaining concurrency slots, but respect the minimum start gap.
  if (hltbActiveRequests < HLTB_MAX_CONCURRENT && hltbRequestQueue.length) {
    setTimeout(pumpHltbQueue, HLTB_MIN_START_GAP_MS);
  }
}

function enqueueSearch(task) {
  return new Promise((resolve, reject) => {
    hltbRequestQueue.push({ task, resolve, reject });
    pumpHltbQueue();
  });
}

function getHltbForGame(appid, gameName) {
  const key = String(appid);
  if (hltbFlights.has(key)) return hltbFlights.get(key);
  const task = fetchHltbForGame(appid, gameName).finally(() =>
    hltbFlights.delete(key),
  );
  hltbFlights.set(key, task);
  return task;
}
async function fetchHltbForGame(appid, gameName) {
  const cached = await getCached(appid, gameName);
  if (cached !== undefined) {
    return { ok: true, data: cached.found ? cached.data : null, cached: true };
  }

  return enqueueSearch(async () => {
    let lastError = null;

    // HLTB occasionally returns a transient 429/5xx or a network failure when
    // a large wishlist is being resolved. Retry those instead of leaving a
    // permanent-looking `HLTB ?` on an otherwise valid game.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const data = await queryHltb(gameName, appid);
        try {
          await saveCached(appid, data, gameName);
        } catch {}
        return { ok: true, data, cached: false };
      } catch (error) {
        lastError = error;
        const status = Number(error?.status) || 0;
        const transient =
          status === 429 || status >= 500 || error instanceof TypeError;
        if (!transient || attempt >= 2) break;

        const retryDelay =
          status === 429
            ? Math.max(60000, error.retryMs || 0)
            : 1500 * (attempt + 1);
        if (status === 429) {
          hltbBlockedUntil = Date.now() + retryDelay;
          break;
        }
        console.warn(
          `[SWP Firefox] Transient HLTB failure for ${gameName}; retrying in ${retryDelay}ms`,
          error,
        );
        await sleep(retryDelay);
      }
    }

    console.warn(
      `[SWP Firefox] HLTB lookup failed for ${gameName}:`,
      lastError,
    );
    return {
      ok: false,
      data: null,
      error: lastError instanceof Error ? lastError.message : String(lastError),
      retryAt: Math.max(Date.now() + 60000, hltbBlockedUntil),
    };
  });
}

// Steam review-count support.
//
// Fetch review metadata with Steam's public StoreBrowse batch endpoint.  A
// 485-game wishlist needs only four requests at 150 appids/request, instead of
// one request per game.  This is intentionally separate from the Store page
// crawler so changing the review threshold never re-requests metadata.
// One serialized metadata service across all tabs. Cache entries record unknown
// separately from zero, and are scoped to Steam's review language.
const reviewFlightQueue = { tail: Promise.resolve() };
let steamBlockedUntil = 0;
const STEAM_UNKNOWN_TTL_MS = 30 * 60 * 1000;
function normalizeLanguage(language) {
  return /^[a-z]{2,24}$/.test(String(language || ""))
    ? String(language)
    : "english";
}
function reviewCacheKey(appid, language = "english", country = "US") {
  return `${REVIEW_CACHE_PREFIX}${normalizeLanguage(language)}_${normalizeCountry(country)}_${appid}`;
}
function normalizeCountry(country) {
  return /^[A-Z]{2}$/.test(String(country)) ? String(country) : "US";
}
function validCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}
function pickSteamReviewCount(item) {
  const reviews = item?.reviews || {};
  for (const summary of [
    reviews.summary_language_specific,
    reviews.summary_filtered,
  ]) {
    const count = validCount(summary?.review_count);
    if (count !== null) return count;
  }
  // An all-language total cannot substitute for a language-filtered total.
  return null;
}
async function getCachedReviewCounts(
  appids,
  language = "english",
  country = "US",
) {
  let stored = {};
  try {
    stored = await ext.storage.local.get(
      appids.map((id) => reviewCacheKey(id, language, country)),
    );
  } catch {}
  const counts = {},
    names = {},
    missing = [];
  for (const id of appids) {
    const entry = stored?.[reviewCacheKey(id, language, country)];
    const ttl =
      validCount(entry?.count) === null
        ? STEAM_UNKNOWN_TTL_MS
        : REVIEW_CACHE_TTL_MS;
    if (
      !entry ||
      typeof entry.savedAt !== "number" ||
      Date.now() - entry.savedAt >= ttl
    ) {
      missing.push(id);
      continue;
    }
    const count = validCount(entry.count);
    if (count !== null) counts[id] = count;
    if (typeof entry.name === "string" && entry.name.trim())
      names[id] = entry.name.trim();
  }
  return { counts, names, missing };
}
async function fetchSteamReviewBatch(
  appids,
  language = "english",
  country = "US",
) {
  const payload = {
    ids: appids.map((appid) => ({ appid: Number(appid) })),
    context: {
      language: normalizeLanguage(language),
      country_code: normalizeCountry(country),
      steam_realm: 1,
    },
    data_request: { include_reviews: true, include_basic_info: true },
  };
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), STEAM_REVIEW_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(payload))}`,
      { signal: controller.signal, credentials: "omit" },
    );
    if (!response.ok) {
      const error = new Error(`Steam metadata HTTP ${response.status}`);
      error.status = response.status;
      const header = response.headers?.get("Retry-After"),
        seconds = Number(header),
        date = Date.parse(header);
      error.retryMs =
        Number.isFinite(seconds) && seconds > 0
          ? seconds * 1000
          : Number.isFinite(date)
            ? Math.max(0, date - Date.now())
            : 60000;
      throw error;
    }
    const json = await response.json();
    if (!Array.isArray(json?.response?.store_items))
      throw new Error("Malformed Steam metadata response");
    const counts = {},
      names = {},
      allowed = new Set(appids);
    for (const item of json.response.store_items) {
      const id = String(item.appid);
      if (!allowed.has(id)) continue;
      const count = pickSteamReviewCount(item);
      if (count !== null) counts[id] = count;
      if (typeof item.name === "string" && item.name.trim())
        names[id] = item.name.trim();
    }
    return { counts, names };
  } finally {
    clearTimeout(timer);
  }
}
function getSteamReviewCounts(appids, language = "english", country = "US") {
  const ids = Array.from(
    new Set(
      (Array.isArray(appids) ? appids : [])
        .map(String)
        .filter((id) => /^[1-9]\d*$/.test(id)),
    ),
  );
  language = normalizeLanguage(language);
  country = normalizeCountry(country);
  const task = reviewFlightQueue.tail.then(async () => {
    if (
      ext.permissions?.contains &&
      !(await ext.permissions.contains({
        origins: ["https://api.steampowered.com/*"],
      }))
    ) {
      return {
        ok: false,
        error: "missing-steam-api-permission",
        counts: {},
        names: {},
        missing: ids,
      };
    }
    const cached = await getCachedReviewCounts(ids, language, country),
      counts = { ...cached.counts },
      names = { ...cached.names };
    for (
      let offset = 0;
      offset < cached.missing.length;
      offset += STEAM_REVIEW_BATCH_SIZE
    ) {
      if (Date.now() < steamBlockedUntil) break;
      const batch = cached.missing.slice(
        offset,
        offset + STEAM_REVIEW_BATCH_SIZE,
      );
      try {
        const data = await fetchSteamReviewBatch(batch, language, country);
        Object.assign(counts, data.counts);
        Object.assign(names, data.names);
        const writes = {};
        for (const id of batch)
          writes[reviewCacheKey(id, language, country)] = {
            count: validCount(data.counts[id]),
            name: data.names[id] || "",
            savedAt: Date.now(),
          };
        // Storage failures must not discard a successful response.
        try {
          await ext.storage.local.set(writes);
        } catch {}
      } catch (error) {
        steamBlockedUntil =
          Date.now() + Math.max(30000, error.retryMs || 60000);
        console.warn("[SWPF] Steam metadata paused:", error.message);
        break;
      }
      if (offset + STEAM_REVIEW_BATCH_SIZE < cached.missing.length)
        await sleep(350);
    }
    return {
      ok: true,
      counts,
      names,
      missing: ids.filter((id) => validCount(counts[id]) === null),
      retryAt: steamBlockedUntil,
    };
  });
  reviewFlightQueue.tail = task.catch(() => {});
  return task;
}

const nativeRendererQueues = new Map();
function executeNativeWishlist(sender, command) {
  const tabId = sender.tab?.id;
  if (
    !Number.isInteger(tabId) ||
    !/^https:\/\/store\.steampowered\.com\/wishlist\//.test(sender.url || "")
  )
    return Promise.resolve({
      ok: false,
      error: "Native wishlist access requires a Steam wishlist tab",
    });
  const previous = nativeRendererQueues.get(tabId) || Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(async () => {
      try {
        const results = await ext.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: nativeWishlistBridge,
          args: [command],
        });
        return (
          results[0]?.result || {
            ok: false,
            error: "Steam native renderer returned no result",
          }
        );
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
  nativeRendererQueues.set(tabId, task);
  task.finally(() => {
    if (nativeRendererQueues.get(tabId) === task)
      nativeRendererQueues.delete(tabId);
  });
  return task;
}
ext.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== "object") return undefined;

  if (message.type === "NATIVE_WISHLIST_VIEW")
    return executeNativeWishlist(sender, message.command);

  if (message.type === "GET_STEAM_REVIEW_COUNTS") {
    return getSteamReviewCounts(
      message.appids,
      message.language,
      message.country,
    );
  }

  if (message.type === "GET_HLTB") {
    if (!message.appid || !message.gameName) {
      return Promise.resolve({
        ok: false,
        data: null,
        error: "Missing appid or gameName",
      });
    }
    return getHltbForGame(String(message.appid), String(message.gameName));
  }

  if (message.type === "CLEAR_HLTB_CACHE") {
    return ext.storage.local.get(null).then(async (all) => {
      const keys = Object.keys(all || {}).filter(
        (key) =>
          key.startsWith(CACHE_PREFIX) ||
          key.startsWith(REVIEW_CACHE_PREFIX) ||
          key === ENDPOINT_CACHE_KEY,
      );
      if (keys.length) await ext.storage.local.remove(keys);
      inMemorySearchEndpoint = null;
      return { ok: true, removed: keys.length };
    });
  }

  return undefined;
});

ensureHeaderRule().catch(() => undefined);
console.log("[SWP Firefox] HLTB background script ready");
