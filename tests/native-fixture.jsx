import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
const games = Array.from({ length: 485 }, (_, i) => ({
  appid: 10000 + i,
  name: `Game ${String(i).padStart(3, "0")}`,
  reviews: i % 19 === 0 ? null : (i * 137) % 20001,
  hours: i % 23 === 0 ? null : (i % 97) + 1,
  discount: i % 3 === 0 ? 75 : 20,
  price: `C$ ${(i + 1).toFixed(2)}`,
}));
window.fixture = {
  games,
  calls: { steam: 0, hltb: 0 },
  cart: [],
  removed: [],
  delay: 40,
  paintDelay: 0,
};
function Row({ item, index }) {
  const [display, setDisplay] = useState(window.fixture.shells ? null : item);
  useEffect(() => {
    const t = setTimeout(() => setDisplay(item), window.fixture.delay);
    return () => clearTimeout(t);
  }, [item]);
  return (
    <div className="Panel" data-index={index} style={{ height: 174 }}>
      <div data-rfd-draggable-id={`WishlistItem-${item.appid}-${index}`}>
        {display && (
          <>
            <a href={`https://store.steampowered.com/app/${display.appid}/`}>
              <img
                width="180"
                height="85"
                alt={display.name}
                src={`https://cdn.steamstatic.com/steam/apps/${display.appid}/header.jpg`}
              />
            </a>
            <div>
              <a
                className="native-title"
                href={`https://store.steampowered.com/app/${display.appid}/`}
              >
                {display.name}
              </a>
            </div>
            <div className="native-information">
              Release Date: Oct 4, 2025 <span>Very Positive</span>
              <span>Action RPG Singleplayer</span>
              <svg aria-label="Windows" width="10" height="10">
                <rect width="10" height="10" />
              </svg>
              <span className="discount">-{display.discount}%</span>
              <span className="price">{display.price}</span>
            </div>
            <button
              className="cart"
              onClick={() => fixture.cart.push(display.appid)}
            >
              Add to Cart
            </button>
            <button
              className="category"
              onClick={() => (fixture.category = display.appid)}
            >
              Manage categories
            </button>
            <button
              className="remove"
              onClick={() => fixture.remove(display.appid)}
            >
              remove
            </button>
            <span>Added on Oct 4, 2025</span>
          </>
        )}
      </div>
    </div>
  );
}
function Wishlist({ data }) {
  const result = useMemo(
    () => ({ steamid: "fixture", items: data.items.slice() }),
    [data],
  );
  const [selection, setSelection] = useState(() => new Map());
  const [start, setStart] = useState(0);
  fixture.result = result;
  useEffect(() => {
    fixture.selection = selection;
  }, [selection]);
  const rows = result.items.slice(start, start + 14);
  return (
    <div
      data-rfd-droppable-id="droppable"
      id="native-scroller"
      style={{ height: 800, overflowY: "auto" }}
      onScroll={(e) => {
        let top = e.currentTarget.scrollTop;
        setTimeout(() => {
          if (document.hidden && fixture.pauseHidden) {
            fixture.pendingStart = Math.floor(top / 174);
            return;
          }
          setStart(
            Math.min(
              Math.floor(top / 174),
              Math.max(0, result.items.length - 14),
            ),
          );
        }, fixture.paintDelay);
      }}
    >
      <div
        id="native-spacer"
        style={{ position: "relative", height: result.items.length * 174 }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            width: "100%",
            transform: `translateY(${Math.min(start, Math.max(0, result.items.length - 14)) * 174}px)`,
          }}
        >
          {rows.map((item, offset) => (
            <Row key={offset} item={item} index={start + offset} />
          ))}
        </div>
      </div>
    </div>
  );
}
function App() {
  const [discount, setDiscount] = useState(false),
    [search, setSearch] = useState(""),
    [removed, setRemoved] = useState([]),
    [loading, setLoading] = useState(false),
    [nativeSort, setNativeSort] = useState("Discount"),
    [menu, setMenu] = useState(false);
  const data = useMemo(
    () => ({
      steamid: "fixture",
      items: games
        .filter(
          (g) =>
            (!discount || g.discount >= 75) &&
            g.name.toLowerCase().includes(search.toLowerCase()) &&
            !removed.includes(g.appid),
        )
        .sort((a, b) =>
          nativeSort === "Name" ? b.appid - a.appid : a.appid - b.appid,
        ),
    }),
    [discount, search, removed, nativeSort],
  );
  fixture.active = data.items;
  fixture.remove = (id) => {
    fixture.removed.push(id);
    setRemoved((r) => [...r, id]);
  };
  fixture.nativeDiscount = () => {
    setLoading(true);
    history.pushState(
      {},
      "",
      discount ? "?sort=discount" : "?sort=discount&min_discount=75",
    );
    setTimeout(() => {
      setDiscount(!discount);
      setLoading(false);
    }, fixture.filterDelay || 0);
  };
  return (
    <>
      <div id="toolbar">
        <button id="options" onClick={fixture.nativeDiscount}>
          75% discount
        </button>
        <input
          id="search"
          placeholder="Search by name, tag, or category"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button id="sort" onClick={() => setMenu(!menu)}>
          Sort by: {nativeSort}
        </button>
        {!loading && <span id="count">{data.items.length} ITEMS</span>}
      </div>
      {menu && (
        <div id="menu">
          {[
            "Your Rank",
            "Name",
            "Price",
            "Discount",
            "Date Added",
            "Top Selling",
            "Release Date",
            "Review Score",
          ].map((label) => (
            <button
              key={label}
              onClick={() => {
                setNativeSort(label);
                setMenu(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <Wishlist data={data} />
    </>
  );
}
createRoot(document.getElementById("root")).render(<App />);
