/* Runs in Steam's MAIN world. Reuses the native React result and renderer;
 * never clones cards, edits the saved wishlist, or invokes purchase/removal. */
function nativeWishlistBridge(command) {
  const key = "__swpfNativeWishlistViewV1";
  function hooks(fiber) {
    const result = [];
    for (let h = fiber?.memoizedState, i = 0; h && i < 100; h = h.next, i++)
      result.push(h);
    return result;
  }
  function resultOf(fiber) {
    for (const h of hooks(fiber)) {
      const value = h.memoizedState;
      if (
        Array.isArray(value) &&
        value[0] &&
        Array.isArray(value[0].items) &&
        Object.hasOwn(value[0], "steamid") &&
        value[0].items.every(
          (item) => Number.isInteger(item?.appid) && item.appid > 0,
        )
      )
        return value[0];
    }
    return null;
  }
  function currentRoot(node) {
    let f =
      node?.[
        Object.keys(node || {}).find((k) => k.startsWith("__reactFiber$"))
      ];
    if (!f) return null;
    while (f.return) f = f.return;
    return f.stateNode?.current || null;
  }
  function walk(root, predicate) {
    const stack = root ? [root] : [];
    let budget = 20000;
    while (stack.length && budget--) {
      const f = stack.pop();
      if (predicate(f)) return f;
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return null;
  }
  function discover() {
    const node =
      document.querySelector('[data-rfd-draggable-id^="WishlistItem-"]') ||
      document.querySelector("[data-rfd-droppable-id]");
    const previous = window[key];
    const root = currentRoot(node) || previous?.root?.stateNode?.current;
    const current = walk(root, (f) => f.stateNode === node);
    let owner = current;
    while (owner && !resultOf(owner)) owner = owner.return;
    if (!owner && previous)
      owner = walk(root, (f) => f.type === previous.ownerType && resultOf(f));
    if (!owner)
      throw new Error(
        "Steam native wishlist renderer is not ready or has changed",
      );
    const object = resultOf(owner);
    // Copying this Map requests a render without changing its contents. No
    // query/mutation/purchase callback is called and no raw cached data is edited.
    const redraw = hooks(owner).find(
      (h) =>
        h.memoizedState instanceof Map &&
        typeof h.queue?.dispatch === "function",
    )?.queue.dispatch;
    if (!redraw)
      throw new Error(
        "Unsupported Steam native wishlist renderer; original cards retained",
      );
    const baseItems =
      previous?.object === object ? previous.baseItems : object.items.slice();
    if (new Set(baseItems.map((item) => item.appid)).size !== baseItems.length)
      throw new Error("Steam native wishlist contains duplicate IDs");
    return { root, ownerType: owner.type, object, redraw, baseItems };
  }
  try {
    if (command.action === "restore") {
      const previous = window[key];
      if (previous) {
        const current = discover();
        previous.object.items = previous.baseItems;
        delete window[key];
        if (current.object === previous.object)
          current.redraw((value) => new Map(value));
      }
      return { ok: true };
    }
    const found = discover();
    const ids = found.baseItems.map((item) => String(item.appid));
    if (command.action === "read") return { ok: true, appids: ids };
    if (command.action !== "apply")
      throw new Error("Unknown native renderer operation");
    if (
      !Array.isArray(command.sourceAppids) ||
      ids.length !== command.sourceAppids.length ||
      ids.some((id, i) => id !== command.sourceAppids[i])
    )
      throw new Error("Steam native result changed before sorting");
    const byId = new Map(
      found.baseItems.map((item) => [String(item.appid), item]),
    );
    if (
      !Array.isArray(command.appids) ||
      new Set(command.appids).size !== command.appids.length ||
      command.appids.some((id) => !byId.has(id))
    )
      throw new Error("Invalid custom wishlist membership");
    const items = command.appids.map((id) => byId.get(id));
    window[key] = { ...found, viewAppids: command.appids.slice() };
    found.object.items = items;
    found.redraw((value) => new Map(value));
    return { ok: true, appids: command.appids.slice(), native: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
