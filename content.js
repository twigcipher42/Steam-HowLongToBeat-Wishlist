/*
 * Steam Wishlist HLTB - Firefox content script
 *
 * Adds clickable HowLongToBeat badges to Steam wishlist rows and adds
 * "HLTB: Shortest" / "HLTB: Longest" to Steam's Sort by dropdown.
 */

"use strict";

const ext = globalThis.browser ?? globalThis.chrome;

const BADGE_CLASS = "swpf-hltb-badge";
const LOADER_CLASS = "swpf-hltb-loader";
const ERROR_CLASS = "swpf-hltb-error";
const MARKER_ATTR = "data-swpf-hltb-appid";

const HLTB_SORT_OPTION_CLASS = "swpf-hltb-sort-option";
const HLTB_SORT_INDICATOR_CLASS = "swpf-hltb-sort-indicator";
const HLTB_SORT_SHORTEST = "shortest";
const HLTB_SORT_LONGEST = "longest";
const CUSTOM_SORT_VIEW_CLASS = "swpf-hltb-custom-sort-view";
const REVIEW_FILTER_CONTROL_CLASS = "swpf-review-filter-control";
const REVIEW_FILTER_INPUT_CLASS = "swpf-review-filter-input";
const REVIEW_FILTER_CLEAR_CLASS = "swpf-review-filter-clear";
const REVIEW_BADGE_CLASS = "swpf-review-count-badge";
const REVIEW_SORT_MOST = "reviews-most";
const REVIEW_SORT_FEWEST = "reviews-fewest";
const ITEM_COUNT_PATCH_ATTR = "data-swpf-item-count-patched";

const STEAM_SORT_LABELS = [
  "Your Rank",
  "Name",
  "Price",
  "Discount",
  "Date Added",
  "Top Selling",
  "Release Date",
  "Review Score",
];

const pending = new Map();
const hltbTitleByAppId = new Map();
const hltbRetryAt = new Map();
const hltbDataByAppId = new Map();

let scanTimer = null;
let sortUiTimer = null;
let reviewFilterTimer = null;
let activeReviewMin = 0;
let activeHltbSort = null;
let activeReviewSort = null;
let nativePresentationActive = false;
let nativeRestorePromise = Promise.resolve();

// The completed native result is cached as plain records, scoped to its signature.
let patchedItemCountElement = null;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCustomWishlistModeActive() {
  return Boolean(activeHltbSort || activeReviewSort) || activeReviewMin > 0;
}

function getActiveCustomSortMode() {
  return activeHltbSort || activeReviewSort || null;
}

function extractAppIdFromUrl(url) {
  const match = String(url || "").match(/\/app\/(\d+)/i);
  return match ? match[1] : null;
}

function extractAppIdFromRow(row) {
  const draggable = row?.getAttribute?.("data-rfd-draggable-id") || "";
  const draggableMatch = draggable.match(/^WishlistItem-(\d+)-/);
  if (draggableMatch) return draggableMatch[1];

  const link = row?.querySelector?.('a[href*="/app/"]');
  return link
    ? extractAppIdFromUrl(link.getAttribute("href") || link.href)
    : null;
}

function isUsefulTitle(text) {
  const value = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!value || value.length > 180) return false;
  if (/^(view|visit|store|details|more|remove)$/i.test(value)) return false;
  return true;
}

function chooseBestTitleLink(links) {
  let best = null;
  let bestScore = -1;

  for (const link of links) {
    const text = (link.textContent || "").replace(/\s+/g, " ").trim();
    if (!isUsefulTitle(text)) continue;

    let score = text.length;
    if (link.querySelector("img")) score -= 100;
    if (link.children.length === 0) score += 20;
    if (text.length >= 2 && text.length <= 100) score += 20;

    if (score > bestScore) {
      bestScore = score;
      best = { link, gameName: text };
    }
  }

  if (best) return best;

  const imageLink = links.find((link) => link.querySelector("img[alt]"));
  const alt = imageLink?.querySelector("img[alt]")?.getAttribute("alt")?.trim();
  if (imageLink && isUsefulTitle(alt))
    return { link: imageLink, gameName: alt };

  return null;
}

function chooseTitleLink(appid) {
  const candidates = Array.from(
    document.querySelectorAll(`a[href*="/app/${appid}"]`),
  ).filter(
    (link) =>
      extractAppIdFromUrl(link.href) === String(appid) &&
      !link.closest(`.${CUSTOM_SORT_VIEW_CLASS}`),
  );
  return chooseBestTitleLink(candidates);
}

function chooseTitleLinkInRow(row, appid) {
  const candidates = Array.from(
    row.querySelectorAll(`a[href*="/app/${appid}"]`),
  ).filter((link) => extractAppIdFromUrl(link.href) === String(appid));
  return chooseBestTitleLink(candidates);
}

function findWishlistAppIds() {
  const ids = new Set();

  document
    .querySelectorAll('[data-rfd-draggable-id^="WishlistItem-"]')
    .forEach((row) => {
      if (row.closest(`.${CUSTOM_SORT_VIEW_CLASS}`) || row.closest("[hidden]"))
        return;
      const appid = extractAppIdFromRow(row);
      if (appid) ids.add(appid);
    });

  document.querySelectorAll('a[href*="/app/"]').forEach((link) => {
    if (link.closest(`.${CUSTOM_SORT_VIEW_CLASS}`)) return;
    const appid = extractAppIdFromUrl(link.getAttribute("href") || link.href);
    if (appid) ids.add(appid);
  });

  return ids;
}

function getFallbackTitleFromRow(row, appid) {
  if (!(row instanceof Element)) return "";

  // Steam occasionally mounts a wishlist card before the usual title text
  // node is populated. Do not drop the whole row just because that one node is
  // late: a missing row is much worse than a temporarily imperfect title.
  const appLinks = Array.from(row.querySelectorAll(`a[href*="/app/${appid}"]`));
  for (const link of appLinks) {
    const direct = String(link.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (isUsefulTitle(direct)) return direct;
    const labelled = String(
      link.getAttribute("aria-label") || link.getAttribute("title") || "",
    ).trim();
    if (isUsefulTitle(labelled)) return labelled;
    const imageAlt = String(
      link.querySelector("img[alt]")?.getAttribute("alt") || "",
    ).trim();
    if (isUsefulTitle(imageAlt)) return imageAlt;
  }

  for (const image of row.querySelectorAll("img[alt]")) {
    const alt = String(image.getAttribute("alt") || "").trim();
    if (isUsefulTitle(alt)) return alt;
  }

  // Never guess a game title from arbitrary card text such as
  // `USER TAGS:` or `ENGLISH REVIEWS:`. Steam can mount those fields before
  // the title while recycling a virtual row. An explicit app-id placeholder
  // is safer than poisoning HLTB matching with UI text.
  return `Steam app ${appid}`;
}

function getWishlistRows() {
  const rows = [];
  const seen = new Set();

  document
    .querySelectorAll('[data-rfd-draggable-id^="WishlistItem-"]')
    .forEach((row) => {
      if (row.closest(`.${CUSTOM_SORT_VIEW_CLASS}`) || row.closest("[hidden]"))
        return;
      const appid = extractAppIdFromRow(row);
      if (!appid || seen.has(appid)) return;

      const chosen = chooseTitleLinkInRow(row, appid) || chooseTitleLink(appid);
      const fallbackLink =
        row.querySelector(`a[href*="/app/${appid}"]`) ||
        row.querySelector('a[href*="/app/"]');
      const link = chosen?.link || fallbackLink;
      if (!(link instanceof Element)) return;

      seen.add(appid);
      rows.push({
        appid,
        gameName: chosen?.gameName || getFallbackTitleFromRow(row, appid),
        link,
        row,
      });
    });

  // Fallback for Steam layouts where the draggable attribute is absent.
  if (!rows.length) {
    for (const appid of findWishlistAppIds()) {
      const chosen = chooseTitleLink(appid);
      if (!chosen) continue;
      const row =
        chosen.link.closest('[data-rfd-draggable-id^="WishlistItem-"]') ||
        chosen.link.closest("div[class]");
      if (!row || row.closest(`.${CUSTOM_SORT_VIEW_CLASS}`) || seen.has(appid))
        continue;
      seen.add(appid);
      rows.push({ appid, gameName: chosen.gameName, link: chosen.link, row });
    }
  }

  return rows;
}

function getBadgeHost(link) {
  // Prefer Steam's platform icon group so the badge sits where the original
  // Steam Wishlist Plus extension places its extra metadata.
  const row =
    link.closest('[data-rfd-draggable-id^="WishlistItem-"]') ||
    link.parentElement?.parentElement;
  if (row) {
    const platformTitles = [
      "Windows",
      "macOS",
      "Linux",
      "SteamOS",
      "Steam Deck",
      "VR",
    ];
    const spans = Array.from(row.querySelectorAll("span[title]"));
    const platformIcon = spans.find((span) => {
      const title = span.getAttribute("title") || "";
      return platformTitles.some((pattern) => title.includes(pattern));
    });
    if (platformIcon?.parentElement) {
      return { host: platformIcon.parentElement, mode: "platforms" };
    }
  }

  // Fallback: put it immediately after the title link.
  return { host: link.parentElement || link, mode: "title" };
}

function formatHours(hours) {
  const value = Number(hours) || 0;
  if (value <= 0) return "";
  return value >= 10 ? `${Math.round(value)}h` : `${value.toFixed(1)}h`;
}

function getSortHours(data) {
  if (!data) return null;
  const value = Number(
    data.mainStory || data.mainExtra || data.completionist || 0,
  );
  return value > 0 ? value : null;
}

function buildTooltip(data) {
  const lines = [`HowLongToBeat — ${data.gameName || "match"}`];
  if (data.mainStory > 0)
    lines.push(`Main Story: ${formatHours(data.mainStory)}`);
  if (data.mainExtra > 0)
    lines.push(`Main + Extras: ${formatHours(data.mainExtra)}`);
  if (data.completionist > 0)
    lines.push(`Completionist: ${formatHours(data.completionist)}`);
  return lines.join("\n");
}

function getLiveRowForLink(link) {
  if (!(link instanceof Element)) return null;
  return (
    link.closest('[data-rfd-draggable-id^="WishlistItem-"]') ||
    link.closest("div[class]") ||
    link.parentElement
  );
}

/**
 * Remove extension UI only from the specific Steam row being updated.
 * Steam virtualizes/recycles wishlist rows, so global removal by appid can
 * accidentally delete a badge from our full-sort snapshot while a hidden
 * native row is being refreshed.
 */
function removeExistingFromRow(link) {
  const row = getLiveRowForLink(link);
  if (!row) return;
  row.querySelectorAll(`[${MARKER_ATTR}]`).forEach((el) => el.remove());
}

function addLoader(appid, link) {
  removeExistingFromRow(link);
  const { host, mode } = getBadgeHost(link);
  const loader = document.createElement("span");
  loader.className = LOADER_CLASS;
  loader.setAttribute(MARKER_ATTR, appid);
  loader.dataset.swpfPlacement = mode;
  loader.textContent = "HLTB …";
  loader.title = "Looking up HowLongToBeat time";
  host.appendChild(loader);
}

function addBadge(appid, link, data) {
  removeExistingFromRow(link);
  const { host, mode } = getBadgeHost(link);

  const badge = document.createElement(data.hltbId > 0 ? "a" : "span");
  badge.className = BADGE_CLASS;
  badge.setAttribute(MARKER_ATTR, appid);
  badge.dataset.swpfPlacement = mode;

  const displayed = formatHours(
    data.mainStory || data.mainExtra || data.completionist,
  );
  badge.textContent = displayed ? `HLTB ${displayed}` : "HLTB";
  badge.title = buildTooltip(data);

  if (badge instanceof HTMLAnchorElement && data.hltbId > 0) {
    badge.href = `https://howlongtobeat.com/game/${data.hltbId}`;
    badge.target = "_blank";
    badge.rel = "noopener noreferrer";
    badge.addEventListener("click", (event) => event.stopPropagation());
  }

  host.appendChild(badge);
}

function addError(appid, link, message) {
  removeExistingFromRow(link);
  const { host, mode } = getBadgeHost(link);
  const error = document.createElement("span");
  error.className = ERROR_CLASS;
  error.setAttribute(MARKER_ATTR, appid);
  error.dataset.swpfPlacement = mode;
  error.textContent = "HLTB ?";
  error.title = message || "No HowLongToBeat match found";
  host.appendChild(error);
}

async function lookup(appid, link, gameName) {
  const previousName = hltbTitleByAppId.get(appid);
  if (previousName && previousName !== gameName) {
    if (pending.has(appid)) await pending.get(appid);
    hltbDataByAppId.delete(appid);
    hltbRetryAt.delete(appid);
  }
  hltbTitleByAppId.set(appid, gameName);
  if (Date.now() < (hltbRetryAt.get(appid) || 0)) return null;
  // Cached HLTB data is reusable state, not a signal that the DOM is finished.
  // Steam recycles wishlist rows while scrolling and can remove our injected
  // badge at any time. Whenever a cached game reappears, redraw its badge.
  if (hltbDataByAppId.has(appid)) {
    const cached = hltbDataByAppId.get(appid);
    if (
      link?.isConnected &&
      extractAppIdFromRow(getLiveRowForLink(link)) === appid
    ) {
      if (cached) addBadge(appid, link, cached);
      else addError(appid, link, "No confident HowLongToBeat match found");
    }
    return cached;
  }

  if (pending.has(appid)) {
    // A lookup is already running, but this may be a newly recycled row. Show
    // its loading state now; completion will redraw whichever copy is current.
    if (
      link?.isConnected &&
      extractAppIdFromRow(getLiveRowForLink(link)) === appid
    )
      addLoader(appid, link);
    return pending.get(appid);
  }

  if (
    link?.isConnected &&
    extractAppIdFromRow(getLiveRowForLink(link)) === appid
  )
    addLoader(appid, link);

  const task = (async () => {
    try {
      const response = await ext.runtime.sendMessage({
        type: "GET_HLTB",
        appid,
        gameName,
      });

      const current = chooseTitleLink(appid);
      const targetLink = current?.link;

      if (response?.ok && response.data) {
        hltbDataByAppId.set(appid, response.data);
        if (targetLink?.isConnected) addBadge(appid, targetLink, response.data);
        return response.data;
      }

      if (response?.ok) {
        hltbDataByAppId.set(appid, null);
        if (targetLink?.isConnected)
          addError(appid, targetLink, "No confident HowLongToBeat match found");
        return null;
      }

      hltbRetryAt.set(
        appid,
        Math.max(Date.now() + 60000, response?.retryAt || 0),
      );
      if (targetLink?.isConnected) {
        addError(
          appid,
          targetLink,
          response?.error || "HowLongToBeat lookup failed",
        );
      }
      return null;
    } catch (error) {
      hltbRetryAt.set(appid, Date.now() + 60000);
      const current = chooseTitleLink(appid);
      if (current?.link) addError(appid, current.link, String(error));
      return null;
    } finally {
      pending.delete(appid);
    }
  })();

  pending.set(appid, task);
  return task;
}

async function ensureHltbData(rowInfo) {
  if (hltbDataByAppId.has(rowInfo.appid)) {
    return hltbDataByAppId.get(rowInfo.appid);
  }
  return lookup(rowInfo.appid, rowInfo.link, rowInfo.gameName);
}

const intersectionObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;

      const marker = entry.target;
      const appid = marker.dataset.swpfObserveAppid;
      if (!appid) continue;

      intersectionObserver.unobserve(marker);
      delete marker.dataset.swpfObserveAppid;

      const chosen = chooseTitleLink(appid);
      if (!chosen) continue;
      lookup(appid, chosen.link, chosen.gameName);
    }
  },
  { rootMargin: "900px 0px" },
);

function queueApp(appid) {
  const chosen = chooseTitleLink(appid);
  if (!chosen) return;

  const row = getLiveRowForLink(chosen.link);
  const metadata = snapshotRecord?.snapshots.find((r) => r.appid === appid);
  if (metadata) chosen.gameName = metadata.gameName;
  const existing = row?.querySelector?.(
    `[${MARKER_ATTR}="${CSS.escape(appid)}"]`,
  );
  if (existing) return;

  // If we already know this game's result, restore the badge immediately.
  // Do not wait for IntersectionObserver: recycled rows near the top should
  // never sit blank until the user scrolls again.
  if (hltbDataByAppId.has(appid)) {
    const cached = hltbDataByAppId.get(appid);
    if (cached) addBadge(appid, chosen.link, cached);
    else addError(appid, chosen.link, "No confident HowLongToBeat match found");
    return;
  }

  if (pending.has(appid)) {
    addLoader(appid, chosen.link);
    return;
  }

  // Custom views keep the native virtualizer. Decorate its mounted rows,
  // including overscan, without resolving the entire wishlist for review sorts.
  if (nativePresentationActive) {
    lookup(appid, chosen.link, chosen.gameName);
    return;
  }
  const marker =
    chosen.link.closest('[data-rfd-draggable-id^="WishlistItem-"]') ||
    chosen.link;
  if (marker.dataset.swpfObserveAppid === appid) return;
  marker.dataset.swpfObserveAppid = appid;
  intersectionObserver.observe(marker);
}

function scan() {
  for (const appid of findWishlistAppIds()) {
    const chosen = chooseTitleLink(appid),
      row = chosen && getLiveRowForLink(chosen.link);
    const metadata = snapshotRecord?.snapshots.find((r) => r.appid === appid);
    if (row && metadata) {
      const text =
        metadata.reviewCount === null
          ? "REV ?"
          : `REV ${metadata.reviewCount.toLocaleString()}`;
      const badge = row.querySelector(`.${REVIEW_BADGE_CLASS}`);
      if (
        !badge ||
        badge.dataset.swpfAppid !== appid ||
        badge.textContent !== text
      )
        addReviewBadge({ ...metadata, row });
    }
    queueApp(appid);
  }
}

function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, 180);
}

function isElementVisible(element) {
  if (!(element instanceof HTMLElement)) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function exactText(element) {
  return (element?.textContent || "").replace(/\s+/g, " ").trim();
}

function findExactTextElements(text) {
  return Array.from(
    document.querySelectorAll("div, span, a, button, li"),
  ).filter(
    (element) => exactText(element) === text && isElementVisible(element),
  );
}

function countSteamSortLabels(container) {
  const text = exactText(container);
  let count = 0;
  for (const label of STEAM_SORT_LABELS) {
    if (text.includes(label)) count += 1;
  }
  return count;
}

function findSteamSortMenu() {
  const anchors = [
    ...findExactTextElements("Review Score"),
    ...findExactTextElements("Top Selling"),
  ];

  let best = null;

  for (const anchor of anchors) {
    let node = anchor;
    for (
      let depth = 0;
      node && depth < 7;
      depth += 1, node = node.parentElement
    ) {
      if (!(node instanceof HTMLElement) || !isElementVisible(node)) continue;

      const rect = node.getBoundingClientRect();
      if (rect.width > 520 || rect.height > 760) continue;

      const labelCount = countSteamSortLabels(node);
      if (labelCount < 5) continue;

      const area = rect.width * rect.height;
      if (!best || area < best.area) best = { element: node, area };
    }
  }

  return best?.element || null;
}

function findNativeOptionNode(menu, label) {
  const candidates = Array.from(
    menu.querySelectorAll("div, span, a, button, li"),
  ).filter((element) => exactText(element) === label);
  if (!candidates.length) return null;

  // Start with the deepest exact-text node, then climb through wrappers whose
  // complete text is still just this one label. That preserves Steam's own
  // option classes when we clone it.
  let option = candidates.sort(
    (a, b) => b.childElementCount - a.childElementCount,
  )[0];
  while (
    option.parentElement &&
    option.parentElement !== menu &&
    exactText(option.parentElement) === label
  ) {
    option = option.parentElement;
  }
  return option;
}

function findSteamSortButton() {
  const matches = (element) =>
    isElementVisible(element) &&
    /^Sort by:\s*/i.test(exactText(element)) &&
    exactText(element).length < 80;
  const semantic = Array.from(
    document.querySelectorAll('button, [role="button"]'),
  ).find(matches);
  if (semantic) return semantic;
  return (
    Array.from(document.querySelectorAll("div,a")).find(
      (element) =>
        matches(element) && !Array.from(element.children).some(matches),
    ) || null
  );
}

function updateSteamSortButtonLabel() {
  document
    .querySelectorAll(".swpf-hltb-sort-button-active")
    .forEach((element) => {
      element.classList.remove("swpf-hltb-sort-button-active");
      delete element.dataset.swpfHltbSortLabel;
    });

  const mode = getActiveCustomSortMode();
  if (!mode || !nativePresentationActive) return;

  const button = findSteamSortButton();
  if (!button) return;

  let label = "";
  let title = "";
  if (mode === HLTB_SORT_SHORTEST) {
    label = "Sort by: HLTB Shortest";
    title = "Sorted by HowLongToBeat: shortest first";
  } else if (mode === HLTB_SORT_LONGEST) {
    label = "Sort by: HLTB Longest";
    title = "Sorted by HowLongToBeat: longest first";
  } else if (mode === REVIEW_SORT_MOST) {
    label = "Sort by: Reviews Most";
    title = "Sorted by Steam review count: most reviews first";
  } else if (mode === REVIEW_SORT_FEWEST) {
    label = "Sort by: Reviews Fewest";
    title = "Sorted by Steam review count: fewest reviews first";
  }
  if (!label) return;

  button.classList.add("swpf-hltb-sort-button-active");
  button.dataset.swpfHltbSortLabel = label;
  button.title = title;
}

function closeSteamSortMenu() {
  const menu = findSteamSortMenu();
  if (!menu) return;
  const button = findSteamSortButton();
  if (!button) return;

  setTimeout(() => {
    try {
      if (typeof button.click === "function") button.click();
      else
        button.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            view: window,
          }),
        );
    } catch {}
  }, 0);
}

function updateSortIndicator(text = null, title = null) {
  document
    .querySelectorAll(`.${HLTB_SORT_INDICATOR_CLASS}`)
    .forEach((element) => element.remove());
  updateSteamSortButtonLabel();

  const mode = getActiveCustomSortMode();
  if (!mode) return;

  const button = findSteamSortButton();
  if (!button?.parentElement) return;

  const indicator = document.createElement("span");
  indicator.className = HLTB_SORT_INDICATOR_CLASS;

  let defaultText = "";
  let defaultTitle = "";
  if (mode === HLTB_SORT_SHORTEST) {
    defaultText = "HLTB ↑";
    defaultTitle = "Sorted by HowLongToBeat: shortest first";
  } else if (mode === HLTB_SORT_LONGEST) {
    defaultText = "HLTB ↓";
    defaultTitle = "Sorted by HowLongToBeat: longest first";
  } else if (mode === REVIEW_SORT_MOST) {
    defaultText = "REV ↓";
    defaultTitle = "Sorted by Steam review count: most reviews first";
  } else if (mode === REVIEW_SORT_FEWEST) {
    defaultText = "REV ↑";
    defaultTitle = "Sorted by Steam review count: fewest reviews first";
  }

  indicator.textContent = text || defaultText;
  indicator.title = title || defaultTitle;
  button.insertAdjacentElement("afterend", indicator);
}

function formatReviewThreshold(value) {
  const number = Math.max(0, Math.floor(Number(value) || 0));
  return number ? number.toLocaleString() : "";
}

function syncReviewFilterControl(forceValue = false) {
  document
    .querySelectorAll(`.${REVIEW_FILTER_CONTROL_CLASS}`)
    .forEach((control) => {
      const input = control.querySelector(`.${REVIEW_FILTER_INPUT_CLASS}`);
      const clear = control.querySelector(`.${REVIEW_FILTER_CLEAR_CLASS}`);
      if (
        input instanceof HTMLInputElement &&
        (forceValue || document.activeElement !== input)
      ) {
        input.value = activeReviewMin > 0 ? String(activeReviewMin) : "";
      }
      control.classList.toggle(
        "swpf-review-filter-active",
        activeReviewMin > 0,
      );
      if (clear instanceof HTMLElement) clear.hidden = activeReviewMin <= 0;
      control.title =
        activeReviewMin > 0
          ? `Only showing games with at least ${formatReviewThreshold(activeReviewMin)} English Steam reviews`
          : "Filter by minimum English Steam review count";
    });
}

function ensureReviewFilterControl() {
  const sortButton = findSteamSortButton();
  if (!sortButton?.parentElement) return;
  const parent = sortButton.parentElement;
  let control = parent.querySelector(`.${REVIEW_FILTER_CONTROL_CLASS}`);
  if (control) {
    syncReviewFilterControl();
    return;
  }

  control = document.createElement("div");
  control.className = REVIEW_FILTER_CONTROL_CLASS;
  control.innerHTML = `
    <span class="swpf-review-filter-label">Reviews ≥</span>
    <input class="${REVIEW_FILTER_INPUT_CLASS}" type="number" min="0" step="1" inputmode="numeric" placeholder="Any" aria-label="Minimum Steam review count">
    <button class="${REVIEW_FILTER_CLEAR_CLASS}" type="button" title="Clear review-count filter" aria-label="Clear review-count filter" hidden>×</button>`;

  const input = control.querySelector(`.${REVIEW_FILTER_INPUT_CLASS}`);
  const clear = control.querySelector(`.${REVIEW_FILTER_CLEAR_CLASS}`);
  const apply = (immediate) => {
    clearTimeout(reviewFilterTimer);
    reviewFilterTimer = null;

    const rawValue = String(input?.value ?? "").trim();
    const value = Math.max(0, Math.floor(Number(rawValue || 0) || 0));

    // Clearing the field should feel like a native Steam filter: restore the
    // unfiltered-by-review result immediately. Do not leave the old custom
    // view visible for the normal typing debounce, because that makes an
    // empty input look as though the filter is still active.
    if (!rawValue || value <= 0) {
      activeReviewMin = 0;
      syncReviewFilterControl(false);
      void setMinimumReviewFilter(0);
      return;
    }

    activeReviewMin = value;
    syncReviewFilterControl(false);
    reviewFilterTimer = setTimeout(
      () => {
        reviewFilterTimer = null;
        void setMinimumReviewFilter(value);
      },
      immediate ? 0 : 350,
    );
  };

  input?.addEventListener("input", () => apply(false));
  input?.addEventListener("change", () => apply(true));
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      apply(true);
      input.blur();
    }
  });
  clear?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (input instanceof HTMLInputElement) input.value = "";
    activeReviewMin = 0;
    clearTimeout(reviewFilterTimer);
    reviewFilterTimer = null;
    setMinimumReviewFilter(0);
  });

  sortButton.insertAdjacentElement("beforebegin", control);
  syncReviewFilterControl(true);
}

function compareRowsByReviewCount(left, right, direction) {
  const leftCount = getReviewCountForRow(left);
  const rightCount = getReviewCountForRow(right);
  const leftKnown = Number.isFinite(leftCount);
  const rightKnown = Number.isFinite(rightCount);

  if (!leftKnown && !rightKnown) return stableRowTieBreak(left, right);
  if (!leftKnown) return 1;
  if (!rightKnown) return -1;

  const delta =
    direction === REVIEW_SORT_MOST
      ? rightCount - leftCount
      : leftCount - rightCount;
  return delta || stableRowTieBreak(left, right);
}

function stableRowTieBreak(left, right) {
  // Crawl timing can change the order in which Steam's virtualized rows are
  // discovered. Never use crawl order as the final tie-breaker: it makes two
  // identical HLTB sorts look slightly different. Title + appid is stable.
  const leftName = String(left?.gameName || "");
  const rightName = String(right?.gameName || "");
  const byName = leftName.localeCompare(rightName, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (byName !== 0) return byName;

  const leftId = Number(left?.appid);
  const rightId = Number(right?.appid);
  if (
    Number.isFinite(leftId) &&
    Number.isFinite(rightId) &&
    leftId !== rightId
  ) {
    return leftId - rightId;
  }
  return String(left?.appid || "").localeCompare(String(right?.appid || ""));
}

function compareRowsByHltb(left, right, direction) {
  const leftHours = getSortHours(hltbDataByAppId.get(left.appid));
  const rightHours = getSortHours(hltbDataByAppId.get(right.appid));

  // Unknown / no-match games always go to the bottom, regardless of direction.
  if (leftHours == null && rightHours == null)
    return stableRowTieBreak(left, right);
  if (leftHours == null) return 1;
  if (rightHours == null) return -1;

  const delta =
    direction === HLTB_SORT_LONGEST
      ? rightHours - leftHours
      : leftHours - rightHours;

  if (delta !== 0) return delta;
  return stableRowTieBreak(left, right);
}

function findNativeWishlistListContainer(rowInfos) {
  const rows = rowInfos.map((item) => item.row).filter(Boolean);
  if (!rows.length) return null;

  const sortButton = findSteamSortButton();
  let candidate = rows[0].parentElement;

  // Pick the lowest ancestor that actually groups multiple wishlist rows, but
  // never one that also contains Steam's search/filter/sort controls. This
  // keeps the native controls visible while our sorted snapshot replaces only
  // the virtualized card list.
  while (candidate && candidate !== document.body) {
    const wishlistRows = candidate.querySelectorAll(
      '[data-rfd-draggable-id^="WishlistItem-"]',
    );
    const containsAllMounted = rows.every((row) => candidate.contains(row));
    const containsControls = sortButton
      ? candidate.contains(sortButton)
      : false;

    if (
      containsAllMounted &&
      wishlistRows.length >= Math.min(2, rows.length) &&
      !containsControls
    ) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }

  // Fallback to the immediate parent only if it does not own the sort control.
  const fallback = rows[0].parentElement;
  if (fallback && (!sortButton || !fallback.contains(sortButton)))
    return fallback;
  return null;
}

function addReviewBadge(rowInfo) {
  const count = getReviewCountForRow(rowInfo);
  const nativeRow = rowInfo.row;
  nativeRow
    .querySelectorAll(`.${REVIEW_BADGE_CLASS}`)
    .forEach((element) => element.remove());
  const chosen = chooseTitleLinkInRow(nativeRow, rowInfo.appid);
  if (!chosen) return;
  const host = chosen.link.parentElement || chosen.link;
  const badge = document.createElement("span");
  badge.className = REVIEW_BADGE_CLASS;
  badge.dataset.swpfAppid = rowInfo.appid;
  badge.textContent =
    count === null ? "REV ?" : `REV ${count.toLocaleString()}`;
  badge.title =
    count === null
      ? "Steam review count unavailable; excluded by minimum filters"
      : `${count.toLocaleString()} Steam reviews (${getSteamLanguage()})`;
  host.appendChild(badge);
}

let datasetEpoch = 0;
let viewRevision = 0;
let pipelinePromise = null;
let nativeRefreshTimer = null;
let snapshotRecord = null;
class ObsoleteWishlist extends Error {}

function assertDataset(epoch, signature) {
  if (epoch !== datasetEpoch || signature !== getNativeWishlistSignature())
    throw new ObsoleteWishlist("Steam result changed");
}
// Native names are a fallback only after link and artwork identity agree.
function getWishlistSearchInput() {
  return (
    Array.from(document.querySelectorAll("input")).find(
      isWishlistSearchInput,
    ) || null
  );
}
function getNativeWishlistSignature() {
  const url = new URL(location.href);
  url.searchParams.delete("sort");
  url.searchParams.sort();
  return `${url.origin}${url.pathname}?${url.searchParams.toString()}|search=${getWishlistSearchInput()?.value || ""}`;
}
function findWishlistItemCountElement() {
  return (
    Array.from(document.querySelectorAll("span,div,p")).find(
      (el) =>
        !el.closest(`.${CUSTOM_SORT_VIEW_CLASS}`) &&
        /^[\d,]+\s+ITEMS?$/i.test(exactText(el)) &&
        !Array.from(el.children).some((child) =>
          /^[\d,]+\s+ITEMS?$/i.test(exactText(child)),
        ),
    ) || null
  );
}
function getExpectedWishlistItemCount() {
  const el = findWishlistItemCountElement();
  if (!el)
    throw new Error(
      "Steam item count is unavailable; refusing an unverified partial result",
    );
  // The overlay never changes React's text. Always read the current native
  // value, including when React reuses a detached count element.
  const text = exactText(el);
  return Number(text.match(/[\d,]+/)[0].replace(/,/g, ""));
}
// Cover the React count; never replace React-owned child nodes or restore stale text.
function patchWishlistItemCount(count) {
  const el = findWishlistItemCountElement();
  if (!el) return;
  el.setAttribute(ITEM_COUNT_PATCH_ATTR, "1");
  el.dataset.swpfDisplayCount = `${count.toLocaleString()} ${count === 1 ? "ITEM" : "ITEMS"}`;
  patchedItemCountElement = el;
}
function restoreWishlistItemCount() {
  document.querySelectorAll(`[${ITEM_COUNT_PATCH_ATTR}]`).forEach((el) => {
    el.removeAttribute(ITEM_COUNT_PATCH_ATTR);
    delete el.dataset.swpfOriginalItemCountText;
    delete el.dataset.swpfDisplayCount;
  });
  patchedItemCountElement = null;
}
function getReviewCountForRow(row) {
  return typeof row?.reviewCount === "number" &&
    Number.isFinite(row.reviewCount) &&
    row.reviewCount >= 0
    ? row.reviewCount
    : null;
}
function clearFullSnapshotCache() {
  snapshotRecord = null;
}
function hasUsableFullSnapshot() {
  return Boolean(
    snapshotRecord &&
      snapshotRecord.signature === getNativeWishlistSignature() &&
      snapshotRecord.nativeList?.isConnected,
  );
}
function getSteamLanguage() {
  const lang =
    new URL(location.href).searchParams.get("l") ||
    document.cookie.match(/(?:^|;\s*)Steam_Language=([^;]+)/)?.[1];
  const map = {
    en: "english",
    de: "german",
    fr: "french",
    es: "spanish",
    pt: "portuguese",
    ru: "russian",
    ja: "japanese",
    ko: "koreana",
    zh: "schinese",
  };
  return lang || map[document.documentElement.lang.split("-")[0]] || "english";
}
function getSteamCountry() {
  try {
    const raw = document.cookie.match(/(?:^|;\s*)steamCountry=([^;]+)/i)?.[1];
    const code = decodeURIComponent(raw || "")
      .split("|")[0]
      .toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : "US";
  } catch {
    return "US";
  }
}
async function prepareSnapshot() {
  if (hasUsableFullSnapshot()) return snapshotRecord;
  clearCustomSortView();
  await nativeRestorePromise;
  const epoch = datasetEpoch,
    signature = getNativeWishlistSignature();
  let response,
    remaining = 12000;
  while (remaining > 0) {
    assertDataset(epoch, signature);
    const countElement = findWishlistItemCountElement();
    if (countElement) {
      const expected = getExpectedWishlistItemCount();
      if (!expected) {
        snapshotRecord = {
          snapshots: [],
          expected: 0,
          nativeList: document.body,
          signature,
        };
        return snapshotRecord;
      }
      response = await ext.runtime.sendMessage({
        type: "NATIVE_WISHLIST_VIEW",
        command: { action: "read" },
      });
      if (response?.ok && response.appids?.length === expected) break;
    }
    updateSortIndicator(
      "Reading Steam…",
      "Waiting for Steam’s native wishlist result",
    );
    await wait(100);
    if (!document.hidden) remaining -= 100;
  }
  assertDataset(epoch, signature);
  if (!response?.ok)
    throw new Error(
      response?.error ||
        "Steam native wishlist renderer is unavailable; original cards retained",
    );
  const expected = getExpectedWishlistItemCount();
  if (
    response.appids.length !== expected ||
    new Set(response.appids).size !== expected
  )
    throw new Error(
      "Steam native wishlist membership does not match its current count",
    );
  const snapshots = response.appids.map((appid, originalIndex) => ({
    appid,
    originalIndex,
    gameName: chooseTitleLink(appid)?.gameName || `Steam app ${appid}`,
    reviewCount: null,
  }));
  const metadata = await ext.runtime.sendMessage({
    type: "GET_STEAM_REVIEW_COUNTS",
    appids: response.appids,
    language: getSteamLanguage(),
    country: getSteamCountry(),
  });
  assertDataset(epoch, signature);
  if (metadata?.error === "missing-steam-api-permission")
    throw new Error(
      "Firefox has not granted Steam API access. Enable api.steampowered.com under this add-on’s Permissions.",
    );
  for (const row of snapshots) {
    const name = metadata?.names?.[row.appid],
      count = metadata?.counts?.[row.appid];
    if (typeof name === "string" && isUsefulTitle(name)) row.gameName = name;
    row.reviewCount =
      typeof count === "number" && Number.isFinite(count) && count >= 0
        ? Math.floor(count)
        : null;
  }
  snapshotRecord = {
    snapshots,
    expected,
    nativeList:
      document.querySelector("[data-rfd-droppable-id]") || document.body,
    signature,
  };
  return snapshotRecord;
}
function clearCustomSortView() {
  if (nativePresentationActive) {
    nativePresentationActive = false;
    nativeRestorePromise = ext.runtime
      .sendMessage({
        type: "NATIVE_WISHLIST_VIEW",
        command: { action: "restore" },
      })
      .catch(() => {});
  }
  restoreWishlistItemCount();
  updateSteamSortButtonLabel();
}
async function renderFullSortedWishlist(rows, mode) {
  const sorted = rows.slice();
  if (mode === "shortest" || mode === "longest")
    sorted.sort((a, b) => compareRowsByHltb(a, b, mode));
  else if (mode === "reviews-most" || mode === "reviews-fewest")
    sorted.sort((a, b) => compareRowsByReviewCount(a, b, mode));
  else sorted.sort((a, b) => a.originalIndex - b.originalIndex);
  if (snapshotRecord.expected) {
    const result = await ext.runtime.sendMessage({
      type: "NATIVE_WISHLIST_VIEW",
      command: {
        action: "apply",
        appids: sorted.map((r) => r.appid),
        sourceAppids: snapshotRecord.snapshots.map((r) => r.appid),
      },
    });
    if (!result?.ok)
      throw new Error(
        result?.error ||
          "Steam native sort could not be applied; original cards retained",
      );
  }
  nativePresentationActive = true;
  patchWishlistItemCount(sorted.length);
  updateSortIndicator(
    `${sorted.length} games`,
    "Steam’s native cards, with HLTB and review badges",
  );
  updateSteamSortButtonLabel();
  scheduleScan();
}
async function runWishlistPipeline() {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    while (isCustomWishlistModeActive()) {
      const revision = viewRevision;
      try {
        const record = await prepareSnapshot();
        if (revision !== viewRevision) continue;
        const mode = getActiveCustomSortMode(),
          epoch = datasetEpoch;
        if (mode === "shortest" || mode === "longest") {
          let cursor = 0;
          await Promise.all(
            Array.from({ length: 3 }, async () => {
              while (cursor < record.snapshots.length) {
                if (epoch !== datasetEpoch || revision !== viewRevision) return;
                const row = record.snapshots[cursor++];
                if (!/^Steam app \d+$/.test(row.gameName))
                  await ensureHltbData(row);
              }
            }),
          );
        }
        if (revision !== viewRevision) continue;
        assertDataset(epoch, record.signature);
        if (
          record.snapshots.length &&
          (activeReviewSort || activeReviewMin > 0) &&
          !record.snapshots.some((row) => getReviewCountForRow(row) !== null)
        ) {
          throw new Error(
            "Steam review metadata is unavailable. Review sort/filter was not applied; the native wishlist is still visible.",
          );
        }
        const visible = record.snapshots.filter(
          (r) =>
            !activeReviewMin ||
            (getReviewCountForRow(r) !== null &&
              r.reviewCount >= activeReviewMin),
        );
        await renderFullSortedWishlist(visible, mode);
        if (revision !== viewRevision) {
          clearCustomSortView();
          continue;
        }
        break;
      } catch (error) {
        if (error instanceof ObsoleteWishlist) {
          await wait(180);
          continue;
        }
        clearCustomSortView();
        updateSortIndicator("Wishlist !", error.message);
        console.error("[SWPF]", error);
        break;
      }
    }
  })().finally(() => {
    pipelinePromise = null;
    syncReviewFilterControl(true);
  });
  return pipelinePromise;
}
function activateHltbSort(mode) {
  if (!["shortest", "longest"].includes(mode)) return Promise.resolve();
  activeHltbSort = mode;
  activeReviewSort = null;
  viewRevision++;
  clearTimeout(reviewFilterTimer);
  closeSteamSortMenu();
  return runWishlistPipeline();
}
function activateReviewSort(mode) {
  if (!["reviews-most", "reviews-fewest"].includes(mode))
    return Promise.resolve();
  activeReviewSort = mode;
  activeHltbSort = null;
  viewRevision++;
  clearTimeout(reviewFilterTimer);
  closeSteamSortMenu();
  return runWishlistPipeline();
}
function setMinimumReviewFilter(value) {
  clearTimeout(reviewFilterTimer);
  activeReviewMin = Math.max(0, Math.floor(Number(value) || 0));
  viewRevision++;
  syncReviewFilterControl(true);
  if (!isCustomWishlistModeActive()) {
    clearCustomSortView();
    return Promise.resolve();
  }
  return runWishlistPipeline();
}
function deactivateCustomSort({ preserveReviewFilter = false } = {}) {
  activeHltbSort = null;
  activeReviewSort = null;
  if (!preserveReviewFilter) activeReviewMin = 0;
  viewRevision++;
  datasetEpoch++;
  clearTimeout(nativeRefreshTimer);
  clearFullSnapshotCache();
  clearCustomSortView();
  updateSteamSortButtonLabel();
  syncReviewFilterControl(true);
}
function isWishlistSearchInput(target) {
  return (
    target instanceof HTMLInputElement &&
    /search by name, tag, or category/i.test(target.placeholder)
  );
}
function invalidateNativeResult() {
  datasetEpoch++;
  viewRevision++;
  clearFullSnapshotCache();
  clearCustomSortView();
  clearTimeout(nativeRefreshTimer);
  nativeRefreshTimer = setTimeout(() => {
    if (isCustomWishlistModeActive()) runWishlistPipeline();
  }, 250);
}
function scheduleHltbRefreshAfterSearch() {
  invalidateNativeResult();
}
function scheduleActiveSortRefresh() {}
function createHltbSortOption(template, label, direction) {
  // Copy only Steam's visual class, not the native option's data/React
  // attributes. Cloning the whole node can make Steam interpret our custom
  // HLTB entry as the native option it was cloned from (e.g. Review Score).
  const tagName = template?.tagName?.toLowerCase?.() || "div";
  const option = document.createElement(tagName);
  if (typeof template?.className === "string")
    option.className = template.className;
  option.classList.add(HLTB_SORT_OPTION_CLASS);
  option.dataset.swpfHltbSort = direction;
  option.textContent = label;
  option.setAttribute("role", "menuitem");
  option.setAttribute("tabindex", "0");

  const activate = (event) => {
    event.preventDefault();
    event.stopPropagation();
    // activateHltbSort closes the open Steam menu exactly once.
    activateHltbSort(direction);
  };

  option.addEventListener("click", activate, true);
  option.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" || event.key === " ") activate(event);
    },
    true,
  );

  return option;
}

function createReviewSortOption(template, label, direction) {
  const tagName = template?.tagName?.toLowerCase?.() || "div";
  const option = document.createElement(tagName);
  if (typeof template?.className === "string")
    option.className = template.className;
  option.classList.add(HLTB_SORT_OPTION_CLASS);
  option.dataset.swpfReviewSort = direction;
  option.textContent = label;
  option.setAttribute("role", "menuitem");
  option.setAttribute("tabindex", "0");

  const activate = (event) => {
    event.preventDefault();
    event.stopPropagation();
    activateReviewSort(direction);
  };
  option.addEventListener("click", activate, true);
  option.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" || event.key === " ") activate(event);
    },
    true,
  );
  return option;
}

function injectHltbSortOptions() {
  const menu = findSteamSortMenu();
  if (!menu) return;

  const template =
    findNativeOptionNode(menu, "Review Score") ||
    findNativeOptionNode(menu, "Release Date") ||
    findNativeOptionNode(menu, "Top Selling");
  if (!template?.parentElement) return;

  let anchor = template;
  const specs = [
    ["hltb", HLTB_SORT_SHORTEST, "HLTB: Shortest"],
    ["hltb", HLTB_SORT_LONGEST, "HLTB: Longest"],
    ["review", REVIEW_SORT_MOST, "Reviews: Most"],
    ["review", REVIEW_SORT_FEWEST, "Reviews: Fewest"],
  ];

  for (const [kind, direction, label] of specs) {
    const selector =
      kind === "hltb"
        ? `[data-swpf-hltb-sort="${direction}"]`
        : `[data-swpf-review-sort="${direction}"]`;
    let option = menu.querySelector(selector);
    if (!option) {
      option =
        kind === "hltb"
          ? createHltbSortOption(template, label, direction)
          : createReviewSortOption(template, label, direction);
      anchor.insertAdjacentElement("afterend", option);
    }
    anchor = option;
  }
}

function scheduleSortUiInjection() {
  clearTimeout(sortUiTimer);
  sortUiTimer = setTimeout(() => {
    injectHltbSortOptions();
    ensureReviewFilterControl();
  }, 60);
}

/**
 * Steam's React dropdown can be opened by toggling visibility/classes on an
 * existing menu instead of inserting a new DOM node. In that case our global
 * MutationObserver may not see anything useful. When the Sort by control is
 * pressed, retry injection across the next few animation frames/renders so the
 * HLTB options are present no matter how Steam chose to build the menu.
 */
function reinjectSortOptionsAfterOpen() {
  const delays = [0, 35, 90, 180, 320, 550];
  for (const delay of delays) {
    setTimeout(injectHltbSortOptions, delay);
  }
}

function isSteamSortControlTarget(target) {
  let node = target instanceof Element ? target : null;
  for (
    let depth = 0;
    node && depth < 7;
    depth += 1, node = node.parentElement
  ) {
    const text = exactText(node);
    if (/^Sort by:\s*/i.test(text) && text.length < 80) return true;
  }
  return false;
}

function getClickedSteamSortLabel(target) {
  let node = target instanceof Element ? target : null;
  for (
    let depth = 0;
    node && depth < 5;
    depth += 1, node = node.parentElement
  ) {
    const text = exactText(node);
    if (STEAM_SORT_LABELS.includes(text)) return text;
    if (node.classList?.contains(HLTB_SORT_OPTION_CLASS)) return null;
  }
  return null;
}

// Steam's text search does not necessarily change the URL. If an HLTB sort is
// active, rebuild it automatically against the newly filtered native list
// after the user pauses typing.

document.addEventListener(
  "input",
  (event) => {
    if (isWishlistSearchInput(event.target)) scheduleHltbRefreshAfterSearch();
  },
  true,
);
document.addEventListener(
  "pointerdown",
  (event) => {
    if (isSteamSortControlTarget(event.target)) reinjectSortOptionsAfterOpen();
  },
  true,
);
document.addEventListener(
  "click",
  (event) => {
    if (isSteamSortControlTarget(event.target)) reinjectSortOptionsAfterOpen();
    if (
      getClickedSteamSortLabel(event.target) &&
      isCustomWishlistModeActive()
    ) {
      const min = activeReviewMin;
      deactivateCustomSort({ preserveReviewFilter: min > 0 });
      if (min > 0)
        nativeRefreshTimer = setTimeout(() => runWishlistPipeline(), 250);
    }
  },
  true,
);
let observedSignature = getNativeWishlistSignature();
function checkNativeResult() {
  const signature = getNativeWishlistSignature();
  const countElement = findWishlistItemCountElement();
  const nativeCount = Number(
    exactText(countElement)
      .match(/[\d,]+/)?.[0]
      ?.replace(/,/g, ""),
  );
  if (
    signature !== observedSignature ||
    (snapshotRecord &&
      Number.isFinite(nativeCount) &&
      nativeCount !== snapshotRecord.expected)
  ) {
    observedSignature = signature;
    invalidateNativeResult();
  }
}
const mutationObserver = new MutationObserver((mutations) => {
  checkNativeResult();
  if (
    mutations.some(
      (m) =>
        !m.target.closest?.(".swpf-hltb-custom-sort-view") &&
        (m.addedNodes.length || m.type === "attributes"),
    )
  ) {
    scheduleScan();
    scheduleSortUiInjection();
  }
});
mutationObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: [
    "href",
    "data-rfd-draggable-id",
    "aria-expanded",
    "aria-hidden",
  ],
});
window.addEventListener("popstate", checkNativeResult);
// pushState does not dispatch popstate and may precede React mutations.
setInterval(checkNativeResult, 250);
window.addEventListener("pageshow", () => {
  checkNativeResult();
  scheduleScan();
  scheduleSortUiInjection();
});
scan();
scheduleSortUiInjection();
ensureReviewFilterControl();
console.log("[SWPF] Wishlist reliability pipeline ready (0.13.0)");

for (const eventName of ["dragstart", "pointerdown"])
  document.addEventListener(
    eventName,
    (event) => {
      if (
        nativePresentationActive &&
        event.target instanceof Element &&
        !event.target.closest("a,button,input,select,textarea") &&
        event.target.closest("[data-rfd-drag-handle-draggable-id]")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
