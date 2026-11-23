(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const KINDS = [
    ["products", "New pieces", "When a brand adds pieces (Supreme: each week's droplist)"],
    ["upcoming", "Drop dates", "When a brand's next drop date is announced"],
    ["live", "Store opens", "When a locked store unlocks (drop is live)"],
    ["locked", "Store locks", "Stores lock right before a drop"],
    ["news", "Release news", "Upcoming drops and collabs reported in the news"],
  ];
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  let data = { brands: [], products: [], news: [], events: [] };
  const savedView = store.get("view", "drops");
  const S = {
    view: savedView === "brands" ? "catalog" : savedView,
    brand: null, q: "",
    off: new Set(store.get("brandsOff", [])),
    kinds: new Set(store.get("alertKinds", KINDS.map((k) => k[0]))),
    saved: store.get("saved", {}),
    lastVisit: store.get("lastVisit", null),
    shown: 15, drop: null,
    cat: null,                       // brand whose catalog is open
    cf: { col: null, type: "", sort: "new", stock: false, q: "", shown: 40 },
  };
  const cats = {};                   // loaded catalog files
  const on = (name) => !S.off.has(name);
  const brandInfo = (name) => data.brands.find((b) => b.name === name) || {};

  // ── formatting
  const DAY = 86400000;
  const t = (iso) => new Date(iso || 0).getTime();
  const fmtWhen = (iso) => {
    if (!iso) return "";
    const d = new Date(iso), s = (Date.now() - d) / 1000;
    if (s >= 0 && s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
    if (s >= 0 && s < 86400) return Math.round(s / 3600) + "h ago";
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }) +
      " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };
  const localDate = (ymd) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d); };
  const fmtDay = (d) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const daysUntil = (d) => Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(new Date().toDateString())) / DAY);
  const inDays = (n) => n === 0 ? "Today" : n === 1 ? "Tomorrow" : n < 0 ? `${-n}d ago` : `In ${n} days`;
  const fmtPrice = (p, v = p.price) => v == null ? "" : new Intl.NumberFormat(undefined, { style: "currency", currency: p.currency || "USD", maximumFractionDigits: v % 1 ? 2 : 0 }).format(v);
  const priceRange = (x) => x.priceMax != null && x.priceMax !== x.price ? `${fmtPrice(x)}–${fmtPrice(x, x.priceMax)}` : fmtPrice(x);
  const isNew = (x) => S.lastVisit && x.first_seen && x.first_seen > S.lastVisit;
  const matchQ = (txt, q = S.q) => !q || txt.toLowerCase().includes(q.toLowerCase());
  const small = (src) => (src || "").replace("width=900", "width=420").replace(/_768px\./, "_480px.").replace(/\?w=1260&/, "?w=600&").replace(/\?w=1200$/, "?w=600");
  const img = (src, alt = "", cls = "") => { const im = el("img", cls); im.loading = "lazy"; im.decoding = "async"; im.referrerPolicy = "no-referrer"; im.alt = alt; im.src = src; return im; };

  // ── grouping
  const DROP_GAP = 12 * 3600 * 1000;
  const COLOR_RE = /\s+[-–—|/]\s+[^-–—|/]+$/;
  const baseName = (title) => title.replace(COLOR_RE, "").replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
  function models(items) {
    const m = new Map();
    items.forEach((p) => {
      const k = p.brand + "|" + baseName(p.title);
      const g = m.get(k);
      if (!g) m.set(k, { ...p, title: p.title.replace(COLOR_RE, ""), variants: [p], colors: 1, priceMax: p.priceMax ?? p.price });
      else {
        g.variants.push(p); g.colors++;
        if (p.price != null) { g.price = Math.min(g.price ?? p.price, p.price); g.priceMax = Math.max(g.priceMax ?? p.price, p.priceMax ?? p.price); }
        g.available = g.available || p.available;
        if ((p.first_seen || "") > (g.first_seen || "")) g.first_seen = p.first_seen;
      }
    });
    return [...m.values()];
  }
  const STOP = new Set("the and with for from this that their your have will into over just more new its are was has been after first release releases info date".split(" "));
  const words = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
  function clusterNews(list) {
    const out = [];
    list.slice().sort((a, b) => b.released.localeCompare(a.released)).forEach((n) => {
      const w = words(n.title);
      const hit = out.find((c) => c.brands.some((b) => n.brands.includes(b)) && Math.abs(t(c.released) - t(n.released)) < 7 * DAY &&
        [...w].filter((x) => c.w.has(x)).length / Math.max(1, Math.min(w.size, c.w.size)) >= 0.34);
      if (hit) {
        hit.more.push(n); w.forEach((x) => hit.w.add(x));
        if (!hit.images.length && n.images.length) hit.images = n.images;
        if ((n.gallery || []).length > (hit.gallery || []).length) hit.gallery = n.gallery;
        if (!hit.drop && n.drop) hit.drop = n.drop;
      } else out.push({ ...n, w, more: [] });
    });
    return out;
  }
  function dropsFor(items) {
    const out = [], byBrand = {};
    items.forEach((p) => (byBrand[p.brand] = byBrand[p.brand] || []).push(p));
    Object.entries(byBrand).forEach(([brand, list]) => {
      list.sort((a, b) => t(b.released) - t(a.released));
      let cur = null;
      list.forEach((p) => {
        if (!cur || t(cur.start) - t(p.released) > DROP_GAP) { cur = { brand, end: p.released, start: p.released, items: [] }; out.push(cur); }
        cur.items.push(p); cur.start = p.released;
      });
    });
    return out;
  }
  function allDrops() {
    const drops = dropsFor(data.products.filter((p) => on(p.brand)));
    drops.forEach((d) => { d.models = models(d.items); d.key = d.brand + "|" + d.end; d.isNew = d.items.some(isNew); d.week = d.items[0].week; });
    const newsOnly = new Set(data.brands.filter((b) => b.kind === "news").map((b) => b.name));
    clusterNews(data.news.filter((n) => n.brands.some((b) => newsOnly.has(b) && on(b)))).forEach((c) =>
      drops.push({ brand: c.brands.join(" · "), brands: c.brands, end: c.released, story: c, key: "n|" + c.id, isNew: isNew(c) }));
    let list = drops;
    if (S.brand) list = list.filter((d) => (d.brands || [d.brand]).includes(S.brand));
    if (S.q) list = list.filter((d) => matchQ(d.brand + " " + (d.story ? d.story.title : d.items.map((i) => i.title + " " + (i.type || "")).join(" "))));
    return list.sort((a, b) => t(b.end) - t(a.end));
  }
  function newsList() {
    let list = data.news.filter((n) => n.brands.some(on));
    if (S.brand) list = list.filter((n) => n.brands.includes(S.brand));
    return clusterNews(list.filter((n) => matchQ(n.title + " " + n.brands.join(" "))));
  }

  // When does a brand usually drop? (from its past drops in the data)
  function pattern(brand) {
    const starts = dropsFor(data.products.filter((p) => p.brand === brand)).filter((d) => d.items.length >= 2).map((d) => new Date(d.start));
    if (starts.length < 3) return null;
    const recent = starts.slice(0, 10);
    const wd = {}; recent.forEach((d) => (wd[d.getDay()] = (wd[d.getDay()] || 0) + 1));
    const [day, n] = Object.entries(wd).sort((a, b) => b[1] - a[1])[0];
    const hrs = recent.filter((d) => d.getDay() == day).map((d) => d.getHours() + d.getMinutes() / 60).sort((a, b) => a - b);
    const hour = hrs[Math.floor(hrs.length / 2)];
    const gaps = recent.slice(0, -1).map((d, i) => (d - recent[i + 1]) / DAY).sort((a, b) => a - b);
    const gap = gaps[Math.floor(gaps.length / 2)];
    return { day: +day, hour, strong: n / recent.length >= 0.5, last: recent[0], gap, count: starts.length };
  }
  const dayName = (i) => new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: "long" });
  const hourName = (h) => { const d = new Date(); d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0); return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); };
  function patternText(p) {
    if (!p) return "";
    const base = p.strong ? `Usually drops ${dayName(p.day)}s around ${hourName(p.hour)}` : `Drops about every ${Math.max(1, Math.round(p.gap))} days`;
    return `${base} · last drop ${fmtDay(p.last)}`;
  }
  function nextLikely(p) {
    if (!p || !p.strong) return null;
    const d = new Date(); d.setHours(Math.floor(p.hour), Math.round((p.hour % 1) * 60), 0, 0);
    let add = (p.day - d.getDay() + 7) % 7; if (add === 0 && d < new Date()) add = 7;
    d.setDate(d.getDate() + add); return d;
  }

  // Everything with a date ahead: confirmed dates first, then expected ones
  function upcoming() {
    const today = new Date(new Date().toDateString());
    const out = [], seen = new Set();
    const add = (x) => { const k = x.brand + "|" + x.date.toDateString(); if (seen.has(k) || !on(x.brand)) return; seen.add(k); out.push(x); };
    data.brands.forEach((b) => {
      if (b.upcoming && b.upcoming.date) {
        const d = localDate(b.upcoming.date);
        if (d >= today) add({ brand: b.name, date: d, time: b.upcoming.time, said: b.upcoming.said, sure: true, col: b.upcoming.collection, src: b.upcoming.source || (b.name === "Supreme" ? "Droplist" : "") });
      }
    });
    clusterNews(data.news).forEach((n) => {
      if (!n.drop) return;
      const d = localDate(n.drop.date);
      if (d >= today) add({ brand: n.brands[0], date: d, time: n.drop.time, said: n.drop.said || n.title, sure: true, story: n, src: n.source });
    });
    data.brands.filter((b) => b.kind === "store" && b.status === "locked").forEach((b) => {
      if (out.some((x) => x.brand === b.name)) return;
      const p = pattern(b.name), d = nextLikely(p);
      add({ brand: b.name, date: d || new Date(today.getTime() + 365 * DAY), noDate: !d, time: d ? hourName(p.hour) : null, sure: false, locked: true,
        said: `Store locked since ${fmtDay(new Date(b.locked_since))}. ${p ? patternText(p) + "." : "A locked store usually means a drop is close."}` });
    });
    return out.sort((a, b) => (b.sure - a.sure) || (a.date - b.date));
  }

  // ── catalog files
  async function loadCatalog(name) {
    const b = brandInfo(name);
    if (!b.catalog) return null;
    if (cats[name]) return cats[name];
    const r = await fetch(`data/catalog/${b.catalog.file}.json?v=${encodeURIComponent(b.catalog.updated)}`);
    const c = await r.json();
    const sup = name === "Supreme";
    c.items = c.products.map((p) => ({
      id: (sup ? "supreme:" : c.store + ":") + p.i, brand: name, title: p.t, type: p.y, price: p.p, priceMax: p.q,
      currency: c.currency, available: p.a, images: p.img, sizes: p.s || [], desc: p.d || "",
      link: p.link || `https://${c.store}/products/${p.h}`, released: p.r, votes: p.v,
    }));
    const byId = new Map(c.items.map((x) => [x.id.split(":").pop(), x]));
    c.cols = c.collections.map((col) => ({ h: col.h, t: col.t, r: col.r, items: col.ids.map((i) => byId.get(i)).filter(Boolean) }));
    if (sup) c.cols.forEach((col) => col.items.forEach((x) => (x.week = x.week || col.t)));
    cats[name] = c;
    return c;
  }

  // ── cards (tap opens the piece inside Scene)
  function saveBtn(x) {
    const sv = el("button", "save"); sv.setAttribute("aria-label", "Save");
    const paint = () => { const s = !!S.saved[x.id]; sv.classList.toggle("on", s); sv.textContent = s ? "♥" : "♡"; };
    sv.onclick = (e) => { e.stopPropagation(); if (S.saved[x.id]) delete S.saved[x.id]; else { const { variants, ...keep } = x; S.saved[x.id] = keep; } store.set("saved", S.saved); paint(); if (S.view === "saved") render(); };
    paint();
    return sv;
  }
  function card(x) {
    const c = el("article", "card");
    const ph = el("div", "ph" + (x.story ? " story" : "")); ph.dataset.brand = x.brand;
    const imgs = x.images || [];
    if (imgs.length) imgs.slice(0, 2).forEach((src, i) => { const im = img(small(src), i ? "" : x.title, i ? "alt" : ""); im.onerror = () => { im.remove(); if (!ph.querySelector("img")) ph.classList.add("noimg"); }; ph.append(im); });
    else ph.classList.add("noimg");
    const badges = el("div", "badges");
    if (isNew(x)) badges.append(el("span", "badge new", "New"));
    if (x.available === false) badges.append(el("span", "badge out", "Sold out"));
    ph.append(badges);
    const cb = el("div", "cb");
    cb.append(el("div", "brand", x.brand), el("div", "title", x.title));
    const f = el("div", "foot");
    f.append(el("span", "price", priceRange(x)), el("span", "when", x.colors > 1 ? `${x.colors} colors` : ""));
    cb.append(f);
    c.append(ph, saveBtn(x), cb);
    c.onclick = () => openPiece(x);
    return c;
  }
  function storyCard(n) {
    const c = el("article", "card");
    const ph = el("div", "ph story"); ph.dataset.brand = n.brands.join(" · ");
    const src = (n.gallery && n.gallery[0]) || n.images[0];
    if (src) { const im = img(src, ""); im.onerror = () => { im.remove(); ph.classList.add("noimg"); }; ph.append(im); } else ph.classList.add("noimg");
    const cnt = (n.gallery || n.images).length;
    if (cnt > 1) { const b = el("div", "badges"); b.append(el("span", "badge story", `${cnt} photos`)); ph.append(b); }
    const cb = el("div", "cb");
    cb.append(el("div", "brand", n.brands.join(" · ")), el("div", "title", n.title), el("div", "foot"));
    cb.lastChild.append(el("span", "when", fmtWhen(n.released)));
    c.append(ph, cb);
    c.onclick = () => openStory(n);
    return c;
  }
  function row(n, kicker, meta, onTap) {
    const r = el("button", "row");
    const src = (n.gallery && n.gallery[0]) || (n.images && n.images[0]) || n.image;
    if (src) { const im = img(src); im.onerror = () => im.replaceWith(el("div", "noimg")); r.append(im); } else r.append(el("div", "noimg"));
    const b = el("div", "rb");
    b.append(el("div", "rk", kicker), el("div", "rt", n.title), el("div", "rm", meta));
    r.append(b);
    r.onclick = onTap;
    return r;
  }
  function makeSwitch(checked, onchange) {
    const l = el("label", "switch"); const i = el("input"); i.type = "checkbox"; i.checked = checked;
    i.onchange = () => onchange(i.checked); l.onclick = (e) => e.stopPropagation(); l.append(i, el("span")); return l;
  }
  function openUrl(u) { window.open(u, "_blank", "noopener"); }

  // ── piece / story sheet
  const sheet = $("#sheet"), sheetBody = $("#sheet-body");
  function showSheet(build) {
    sheetBody.innerHTML = ""; build(sheetBody); sheetBody.scrollTop = 0;
    sheet.hidden = false; document.body.classList.add("locked");
    requestAnimationFrame(() => sheet.classList.add("open"));
  }
  function closeSheet() { sheet.classList.remove("open"); document.body.classList.remove("locked"); setTimeout(() => (sheet.hidden = true), 220); }
  $("#sheet-x").onclick = closeSheet;
  sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });

  function gallery(images, alt, light = true) {
    const wrap = el("div", "gal" + (light ? "" : " dark"));
    const track = el("div", "gal-track");
    images.forEach((src, i) => {
      const f = el("button", "gal-f"); const im = img(src, alt); im.loading = i < 2 ? "eager" : "lazy";
      im.onerror = () => f.remove();
      f.append(im); f.onclick = () => openZoom(images, i, light); track.append(f);
    });
    wrap.append(track);
    if (images.length > 1) {
      const n = el("div", "gal-n", `1 / ${images.length}`);
      track.addEventListener("scroll", () => { n.textContent = `${Math.round(track.scrollLeft / track.clientWidth) + 1} / ${images.length}`; }, { passive: true });
      wrap.append(n);
      const thumbs = el("div", "gal-thumbs");
      images.forEach((src, i) => { const b = el("button", "gt"); b.append(img(small(src))); b.onclick = () => track.scrollTo({ left: i * track.clientWidth, behavior: "smooth" }); thumbs.append(b); });
      wrap.append(thumbs);
    }
    wrap.append(el("div", "gal-hint", "Tap a photo to zoom"));
    return wrap;
  }

  function openPiece(x, variant) {
    const v = variant || (x.variants ? x.variants[0] : x);
    showSheet((box) => {
      box.append(gallery(v.images || [], v.title));
      const info = el("div", "sh-info");
      const top = el("div", "sh-top");
      top.append(el("div", "sh-brand", x.brand), saveBtn(v));
      info.append(top, el("h2", "sh-title", v.title));
      const meta = el("div", "sh-meta");
      meta.append(el("span", "sh-price", priceRange(v)));
      if (v.available === false) meta.append(el("span", "badge out", "Sold out"));
      info.append(meta);
      if (x.variants && x.variants.length > 1) {
        info.append(el("div", "sh-label", `${x.variants.length} colors`));
        const cs = el("div", "colors");
        x.variants.forEach((c) => {
          const b = el("button", "color" + (c === v ? " on" : "")); b.append(img(small(c.images[0]), c.title));
          b.title = c.title; b.onclick = () => openPiece(x, c); cs.append(b);
        });
        info.append(cs);
      }
      if (v.sizes && v.sizes.length) {
        const sizeLike = v.sizes.some(([n]) => /^(xxs|xs|s|m|l|xl|xxl|xxxl|[0-9]+(\.5)?|os|o\/s|one size)\b/i.test(n));
        info.append(el("div", "sh-label", sizeLike ? "Sizes" : "Options"));
        const ss = el("div", "sizes");
        v.sizes.forEach(([n, ok]) => ss.append(el("span", "size" + (ok ? "" : " gone"), n)));
        info.append(ss);
      }
      const facts = el("div", "facts");
      const fact = (k, val) => { if (!val) return; const r = el("div", "fact"); r.append(el("span", "", k), el("b", "", val)); facts.append(r); };
      fact("Type", v.type);
      fact(v.week ? "Drop" : "Released", v.week || fmtWhen(v.released));
      if (v.votes) fact("Community votes", v.votes.toLocaleString());
      info.append(facts);
      if (v.desc) info.append(el("p", "sh-desc", v.desc));
      const more = el("div", "sh-actions");
      const cat = el("button", "ghost-btn", `All ${x.brand}`); cat.onclick = () => { closeSheet(); openCatalog(x.brand); };
      const out = el("button", "ghost-btn quiet", x.brand === "Supreme" ? "View on droplist ↗" : "Open in store ↗"); out.onclick = () => openUrl(v.link);
      more.append(cat, out);
      info.append(more);
      box.append(info);
    });
  }

  function openStory(n) {
    showSheet((box) => {
      const pics = (n.gallery && n.gallery.length ? n.gallery : n.images) || [];
      if (pics.length) box.append(gallery(pics, n.title, false));
      const info = el("div", "sh-info");
      info.append(el("div", "sh-brand", n.brands.join(" · ")), el("h2", "sh-title", n.title));
      if (n.drop) {
        const d = localDate(n.drop.date), k = daysUntil(d);
        const dd = el("div", "date-card" + (k >= 0 ? " ahead" : ""));
        dd.append(el("div", "dc-d", fmtDay(d) + (n.drop.time ? " · " + n.drop.time : "")), el("div", "dc-s", k >= 0 ? inDays(k) : "Released"));
        info.append(dd);
      }
      info.append(el("div", "sh-meta-s", `${n.source} · ${fmtWhen(n.released)}`));
      if (n.summary) info.append(el("p", "sh-desc", n.summary));
      if (n.more && n.more.length) {
        info.append(el("div", "sh-label", "More on this"));
        n.more.forEach((m) => { const b = el("button", "more-row", m.title); b.onclick = () => openStory({ ...m, more: [] }); info.append(b); });
      }
      const acts = el("div", "sh-actions");
      const b1 = el("button", "ghost-btn", `All ${n.brands[0]}`); b1.onclick = () => { closeSheet(); openCatalog(n.brands[0]); };
      const b2 = el("button", "ghost-btn quiet", "Full article ↗"); b2.onclick = () => openUrl(n.link);
      acts.append(b1, b2); info.append(acts);
      box.append(info);
    });
  }

  // ── fullscreen zoom (pinch, double-tap, drag)
  const zoom = $("#zoom"), ztrack = $("#zoom-track"), zn = $("#zoom-n");
  function openZoom(images, start, light) {
    ztrack.innerHTML = "";
    images.forEach((src) => { const f = el("div", "zf" + (light ? " light" : "")); const im = img(src); im.loading = "eager"; f.append(im); zoomable(f, im); ztrack.append(f); });
    zoom.hidden = false;
    const upd = () => (zn.textContent = images.length > 1 ? `${Math.round(ztrack.scrollLeft / ztrack.clientWidth) + 1} / ${images.length}` : "");
    ztrack.onscroll = upd;
    requestAnimationFrame(() => { ztrack.scrollLeft = start * ztrack.clientWidth; upd(); });
  }
  $("#zoom-x").onclick = () => { zoom.hidden = true; ztrack.innerHTML = ""; };
  function zoomable(frame, im) {
    let s = 1, x = 0, y = 0, g = null, lastTap = 0;
    const apply = () => { im.style.transform = `translate(${x}px,${y}px) scale(${s})`; ztrack.classList.toggle("zoomed", s > 1.01); };
    const clampXY = () => { const r = frame.getBoundingClientRect(); const mx = (r.width * (s - 1)) / 2, my = (r.height * (s - 1)) / 2; x = Math.max(-mx, Math.min(mx, x)); y = Math.max(-my, Math.min(my, y)); };
    const zoomAt = (cx, cy, ns) => { const r = frame.getBoundingClientRect(); const ox = cx - r.left - r.width / 2, oy = cy - r.top - r.height / 2; x = (x - ox) * (ns / s) + ox; y = (y - oy) * (ns / s) + oy; s = ns; if (s <= 1) { s = 1; x = y = 0; } clampXY(); apply(); };
    const dist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const mid = (e) => [(e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2];
    frame.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) { g = { d: dist(e), s, m: mid(e) }; e.preventDefault(); }
      else if (e.touches.length === 1) {
        const now = Date.now(), tc = e.touches[0];
        if (now - lastTap < 280) { zoomAt(tc.clientX, tc.clientY, s > 1.01 ? 1 : 2.6); lastTap = 0; e.preventDefault(); return; }
        lastTap = now;
        if (s > 1.01) { g = { px: tc.clientX, py: tc.clientY, x, y }; e.preventDefault(); }
      }
    }, { passive: false });
    frame.addEventListener("touchmove", (e) => {
      if (!g) return;
      if (e.touches.length === 2 && g.d) { const [cx, cy] = mid(e); zoomAt(cx, cy, Math.max(1, Math.min(5, (g.s * dist(e)) / g.d))); e.preventDefault(); }
      else if (e.touches.length === 1 && g.px != null) { x = g.x + e.touches[0].clientX - g.px; y = g.y + e.touches[0].clientY - g.py; clampXY(); apply(); e.preventDefault(); }
    }, { passive: false });
    frame.addEventListener("touchend", (e) => { if (!e.touches.length) g = null; });
    frame.addEventListener("click", (e) => { if (!("ontouchstart" in window)) zoomAt(e.clientX, e.clientY, s > 1.01 ? 1 : 2.6); });
    frame.addEventListener("mousemove", (e) => { if (s > 1.01 && !("ontouchstart" in window)) { const r = frame.getBoundingClientRect(); x = -((e.clientX - r.left) / r.width - 0.5) * r.width * (s - 1); y = -((e.clientY - r.top) / r.height - 0.5) * r.height * (s - 1); apply(); } });
  }

  // ── Drops tab
  function renderChips() {
    const wrap = $("#chips"); wrap.innerHTML = "";
    const src = S.view === "news" ? data.news.flatMap((n) => n.brands) : data.products.map((p) => p.brand).concat(data.news.flatMap((n) => n.brands));
    const present = new Set(src);
    const names = data.brands.map((b) => b.name).filter((n) => on(n) && present.has(n));
    const mk = (label, val) => {
      const b = el("button", S.brand === val ? "on" : "", label);
      b.onclick = () => { S.brand = val; S.drop = null; S.shown = 15; render(); window.scrollTo(0, 0); };
      wrap.append(b);
    };
    mk("All", null);
    names.forEach((n) => mk(n, n));
  }
  function renderUpcoming() {
    const box = $("#upcoming"); box.innerHTML = "";
    let list = upcoming();
    if (S.brand) list = list.filter((u) => u.brand === S.brand);
    if (!list.length) return;
    box.append(el("h3", "section-h tight", "Upcoming"));
    const strip = el("div", "up-strip");
    list.forEach((u) => {
      const c = el("button", "up" + (u.sure ? " sure" : ""));
      const k = daysUntil(u.date);
      const d = el("div", "up-date");
      if (u.noDate) d.append(el("span", "up-lock", "🔒"), el("span", "up-m", "LOCKED"));
      else d.append(el("span", "up-m", u.date.toLocaleDateString(undefined, { month: "short" }).toUpperCase()), el("span", "up-d", String(u.date.getDate())));
      const b = el("div", "up-b");
      b.append(el("div", "up-brand", u.brand));
      b.append(el("div", "up-when", u.sure ? `${fmtDay(u.date)}${u.time ? " · " + u.time : ""} · ${inDays(k)}` : u.noDate ? "Date not announced yet" : `Expected ${fmtDay(u.date)} ~${u.time}`));
      b.append(el("div", "up-s", u.said || ""));
      b.append(el("span", "up-tag", u.sure ? (u.src ? `Confirmed · ${u.src}` : "Confirmed") : u.noDate ? "Store locked" : "Expected from past drops"));
      c.append(d, b);
      c.onclick = () => u.story ? openStory(u.story) : openCatalog(u.brand, u.col);
      strip.append(c);
    });
    box.append(strip);
  }
  function renderStatus() {
    const box = $("#status"); box.innerHTML = "";
    data.brands.filter((b) => b.kind === "store" && on(b.name)).forEach((b) => {
      let cls = null, txt = null;
      if (b.opened_at && Date.now() - new Date(b.opened_at) < 2 * DAY && b.status === "open") { cls = "live"; txt = `${b.name} · live now`; }
      if (!cls) return;
      const p = el("button", "pill " + cls); p.onclick = () => openCatalog(b.name);
      p.append(el("span", "dot"), el("span", "", txt)); box.append(p);
    });
  }
  function dropCard(d) {
    const c = el("article", "drop");
    const head = el("button", "drop-head");
    const left = el("div", "dh-l");
    left.append(el("div", "dh-brand", d.brand));
    if (d.story) {
      const s = d.story, pics = (s.gallery && s.gallery.length ? s.gallery : s.images) || [];
      left.append(el("div", "dh-meta", `Release news · ${fmtWhen(d.end)}${pics.length > 1 ? ` · ${pics.length} photos` : ""}`));
      head.append(left);
      if (d.isNew) head.append(el("span", "badge new", "New"));
      head.append(el("span", "chev", "›"));
      head.onclick = () => openStory(s);
      c.append(head);
      const body = el("button", "story-body");
      if (pics.length) {
        const strip = el("div", "strip flush");
        pics.slice(0, 8).forEach((src, i) => { const th = el("span", "th wide"); const im = img(small(src)); im.onerror = () => th.remove(); th.append(im); strip.append(th); });
        body.append(strip);
      }
      if (s.drop) { const dd = localDate(s.drop.date), k = daysUntil(dd); body.append(el("div", "chip-date" + (k >= 0 ? " ahead" : ""), `${k >= 0 ? "Drops" : "Dropped"} ${fmtDay(dd)}${s.drop.time ? " · " + s.drop.time : ""}`)); }
      body.append(el("div", "story-t", s.title), el("div", "story-s", s.source));
      body.onclick = () => openStory(s);
      c.append(body);
      return c;
    }
    const n = d.models.length;
    left.append(el("div", "dh-meta", `${d.week ? d.week : fmtWhen(d.end)} · ${n} piece${n > 1 ? "s" : ""}${d.items.every((i) => i.available === false) ? " · sold out" : ""}`));
    head.append(left);
    if (d.isNew) head.append(el("span", "badge new", "New"));
    head.append(el("span", "chev", "›"));
    head.onclick = () => openDrop(d);
    c.append(head);
    const strip = el("div", "strip");
    d.models.slice(0, 12).forEach((m) => {
      const th = el("button", "th"); const im = img(small(m.images[0]), m.title); im.onerror = () => im.remove();
      th.append(im); th.onclick = () => openPiece(m); strip.append(th);
    });
    if (d.models.length > 12) { const more = el("button", "th more-th", `+${d.models.length - 12}`); more.onclick = () => openDrop(d); strip.append(more); }
    c.append(strip);
    return c;
  }
  function openDrop(d) { S.drop = d; render(); window.scrollTo(0, 0); }
  function renderDrops() {
    const grid = $("#grid"), list = $("#drop-list"), back = $("#drop-back");
    grid.innerHTML = ""; list.innerHTML = "";
    if (S.drop) {
      $("#status").innerHTML = ""; $("#upcoming").innerHTML = "";
      back.hidden = false;
      back.querySelector(".db-t").textContent = `${S.drop.brand} · ${S.drop.week || fmtWhen(S.drop.end)}`;
      S.drop.models.forEach((m) => grid.append(card(m)));
      setEmpty("");
      return;
    }
    back.hidden = true;
    renderUpcoming();
    renderStatus();
    const drops = allDrops();
    drops.slice(0, S.shown).forEach((d) => list.append(dropCard(d)));
    setEmpty(drops.length ? "" : S.off.size >= data.brands.length ? "All brands are switched off. Turn some on in Catalog." : "Nothing matches yet.");
    moreObserver.disconnect();
    if (drops.length > S.shown) moreObserver.observe($("#more"));
  }
  function renderNews() {
    const box = $("#news"); box.innerHTML = "";
    const list = newsList();
    list.slice(0, 150).forEach((n) => {
      const pics = (n.gallery || n.images || []).length;
      box.append(row(n, n.brands.join(" · "), `${n.source}${n.more.length ? ` +${n.more.length} more` : ""} · ${fmtWhen(n.released)}${pics > 1 ? ` · ${pics} photos` : ""}`, () => openStory(n)));
    });
    setEmpty(list.length ? "" : "No release news for your brands yet. New stories are added every refresh.");
  }
  function renderSaved() {
    const box = $("#saved"); box.innerHTML = "";
    const list = Object.values(S.saved).sort((a, b) => (b.released || "").localeCompare(a.released || ""));
    list.forEach((x) => box.append(card(x)));
    setEmpty(list.length ? "" : "Nothing saved yet. Tap ♡ on any piece.");
  }

  // ── Catalog tab: every brand, then each brand's collections
  function brandSub(b) {
    if (b.catalog) {
      const src = b.name === "Supreme" ? `${b.catalog.collections} weeks` : `${b.catalog.collections} collections`;
      return `${b.catalog.count.toLocaleString()} pieces · ${src}${b.status === "locked" ? " · locked, drop soon" : ""}`;
    }
    if (b.kind === "store") return b.status === "locked" ? "Locked, drop soon · catalog loads when it opens" : b.status === "error" ? "Store not reachable right now" : "Catalog loading over the next refreshes";
    const n = data.news.filter((x) => x.brands.includes(b.name)).length;
    return `Release stories with photos (${n}) · their site blocks apps`;
  }
  function renderCatalogList() {
    $("#cat-head").hidden = false;
    const box = $("#brand-list"); box.innerHTML = "";
    data.brands.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((b) => {
      const r = el("div", "toggle-row tap");
      const n = el("div", "tn"); n.append(el("b", "", b.name), el("span", "", brandSub(b)));
      r.append(n, makeSwitch(on(b.name), (v) => { v ? S.off.delete(b.name) : S.off.add(b.name); store.set("brandsOff", [...S.off]); updateCode(); }), el("span", "chev", "›"));
      r.onclick = () => openCatalog(b.name);
      box.append(r);
    });
    setEmpty("");
  }
  function openCatalog(name, col = null) {
    S.view = "catalog"; S.cat = name; S.drop = null;
    S.cf = { col, type: "", sort: "new", stock: false, q: "", shown: 40 };
    store.set("view", S.view); render(); window.scrollTo(0, 0);
  }
  async function renderBrandPage() {
    const name = S.cat, b = brandInfo(name);
    $("#cat-head").hidden = true; $("#brand-list").innerHTML = "";
    const page = $("#brand-page"); page.hidden = false; page.innerHTML = "";
    const back = el("button", "drop-back"); back.append(el("span", "chev-l", "‹"), el("span", "db-t", "All brands"));
    back.onclick = () => { S.cat = null; render(); window.scrollTo(0, 0); };
    const hero = el("div", "bp-hero");
    hero.append(el("h2", "bp-name", name));
    const p = pattern(name);
    const sub = [];
    if (b.status === "locked") sub.push("Store locked · drop coming");
    if (b.upcoming && localDate(b.upcoming.date) >= new Date(new Date().toDateString())) sub.push(`Next drop ${fmtDay(localDate(b.upcoming.date))}${b.upcoming.time ? " · " + b.upcoming.time : ""}`);
    if (name === "Supreme") sub.push("Drops Thursdays 11 AM ET · last drop " + (p ? fmtDay(p.last) : ""));
    else if (p) sub.push(patternText(p));
    if (sub.length) hero.append(el("div", "bp-sub", sub.join(" · ")));
    page.append(back, hero);
    const grid = el("div", "grid");

    if (!b.catalog) {
      const stories = clusterNews(data.news.filter((n) => n.brands.includes(name)));
      page.append(el("p", "muted small pad", b.kind === "news" ? `${name}'s own site blocks apps, so its full catalog can't be loaded. Each release below opens with every photo from the story.` : "This store's catalog is collected over the next few refreshes."));
      stories.forEach((n) => grid.append(storyCard(n)));
      page.append(grid);
      setEmpty(stories.length ? "" : "No releases found yet.");
      return;
    }
    const loading = el("p", "muted small pad", "Loading catalog…"); page.append(loading);
    let c;
    try { c = await loadCatalog(name); } catch { loading.textContent = "Couldn't load the catalog. Check your connection."; return; }
    if (S.cat !== name || S.view !== "catalog") return;
    loading.remove();

    const f = S.cf;
    const tools = el("div", "cat-tools");
    const search = el("input"); search.type = "search"; search.placeholder = `Search ${name}`; search.value = f.q;
    tools.append(search);
    const colChips = el("div", "chips");
    const mkChip = (label, val, count) => {
      const bt = el("button", f.col === val ? "on" : ""); bt.append(el("span", "", label)); if (count != null) bt.append(el("span", "cnt", String(count)));
      bt.onclick = () => { f.col = val; f.shown = 40; draw(); paintChips(); bt.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }); };
      colChips.append(bt);
    };
    const paintChips = () => { colChips.innerHTML = ""; mkChip("Everything", null, c.items.length); c.cols.forEach((col) => mkChip(col.t, col.h, col.items.length)); };
    paintChips();
    tools.append(colChips);
    const row2 = el("div", "cat-row");
    const types = [...new Set(c.items.map((x) => x.type).filter(Boolean))].sort();
    const typeSel = el("select");
    [["", "All types"], ...types.map((x) => [x, x])].forEach(([v, l]) => { const o = el("option", "", l); o.value = v; typeSel.append(o); });
    typeSel.value = f.type;
    const sortSel = el("select");
    [["new", "Newest"], ["low", "Price: low to high"], ["high", "Price: high to low"], ["az", "A–Z"], ...(name === "Supreme" ? [["votes", "Most wanted"]] : [])].forEach(([v, l]) => { const o = el("option", "", l); o.value = v; sortSel.append(o); });
    sortSel.value = f.sort;
    const stock = el("label", "stock"); const sc = el("input"); sc.type = "checkbox"; sc.checked = f.stock; stock.append(sc, el("span", "", "In stock"));
    row2.append(typeSel, sortSel, stock);
    tools.append(row2);
    const count = el("div", "cat-count muted small");
    page.append(tools, count, grid);
    const sentinel = el("div", "more"); page.append(sentinel);

    let list = [];
    function draw() {
      let items = f.col ? (c.cols.find((x) => x.h === f.col) || { items: [] }).items : c.items;
      if (f.type) items = items.filter((x) => x.type === f.type);
      if (f.stock) items = items.filter((x) => x.available);
      if (f.q) items = items.filter((x) => matchQ(x.title + " " + x.type, f.q));
      list = models(items);
      const sorters = { new: (a, b) => t(b.released) - t(a.released), low: (a, b) => (a.price ?? 1e9) - (b.price ?? 1e9), high: (a, b) => (b.price ?? -1) - (a.price ?? -1), az: (a, b) => a.title.localeCompare(b.title), votes: (a, b) => (b.votes || 0) - (a.votes || 0) };
      list.sort(sorters[f.sort]);
      const colName = f.col ? (c.cols.find((x) => x.h === f.col) || {}).t : "Everything";
      count.textContent = `${colName} · ${list.length.toLocaleString()} piece${list.length === 1 ? "" : "s"}${c.source ? " · from " + c.source : ""}`;
      grid.innerHTML = ""; f.shown = 40; more();
      setEmpty(list.length ? "" : "Nothing matches.");
    }
    function more() { list.slice(grid.children.length, f.shown).forEach((x) => grid.append(card(x))); }
    search.oninput = () => { f.q = search.value; draw(); };
    typeSel.onchange = () => { f.type = typeSel.value; draw(); };
    sortSel.onchange = () => { f.sort = sortSel.value; draw(); };
    sc.onchange = () => { f.stock = sc.checked; draw(); };
    catObserver.disconnect();
    catObserver.observe(sentinel);
    catMore = () => { if (grid.children.length < list.length) { f.shown += 40; more(); } };
    draw();
  }
  let catMore = () => {};
  const catObserver = new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting)) catMore(); }, { rootMargin: "800px" });

  function renderAlerts() {
    const help = $("#alert-help"), btn = $("#enable-alerts");
    const perm = "Notification" in window ? Notification.permission : "unsupported";
    if (!standalone && isIOS) { help.innerHTML = "First install Scene: tap <b>Share</b> → <b>Add to Home Screen</b>, then open it from your Home Screen and come back here."; btn.disabled = true; }
    else if (!("PushManager" in window) || !("serviceWorker" in navigator)) { help.textContent = "This browser can't receive web alerts. On iPhone, use the Home Screen app (iOS 16.4 or later)."; btn.disabled = true; }
    else if (perm === "denied") { help.textContent = "Alerts are blocked. Turn them on in iPhone Settings → Notifications → Scene."; btn.disabled = true; }
    else { help.textContent = "Get a ping when a drop date is announced, when your brands add pieces, and when a store locks or opens."; btn.disabled = false; }
    btn.textContent = store.get("pushSub", null) ? "Alerts on · refresh code" : "Turn on alerts";
    const kinds = $("#alert-kinds"); kinds.innerHTML = "";
    KINDS.forEach(([k, label, sub]) => {
      const r = el("div", "toggle-row"); const n = el("div", "tn"); n.append(el("b", "", label), el("span", "", sub));
      r.append(n, makeSwitch(S.kinds.has(k), (v) => { v ? S.kinds.add(k) : S.kinds.delete(k); store.set("alertKinds", [...S.kinds]); updateCode(); }));
      kinds.append(r);
    });
    updateCode();
    const ev = $("#events"); ev.innerHTML = "";
    const list = (data.events || []).filter((e) => (e.brands || [e.brand]).some(on) && S.kinds.has(e.kind));
    list.forEach((e) => ev.append(row(e, (e.brands || [e.brand]).join(" · "), `${e.body || ""} · ${fmtWhen(e.time)}`, () => openCatalog(e.brand))));
    setEmpty("");
    if (!list.length) ev.append(el("p", "muted small", "No alerts yet. They appear here as drops happen."));
  }

  function setEmpty(msg) { const e = $("#empty"); e.hidden = !msg; e.textContent = msg; }

  function render() {
    document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "view-" + S.view));
    document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.view === S.view));
    $("#filters").hidden = !["drops", "news"].includes(S.view) || !!S.drop;
    if (S.view === "drops" || S.view === "news") renderChips();
    if (S.view !== "catalog") catObserver.disconnect();
    if (S.view === "catalog") { if (S.cat) renderBrandPage(); else { $("#brand-page").hidden = true; renderCatalogList(); } return; }
    ({ drops: renderDrops, news: renderNews, saved: renderSaved, alerts: renderAlerts })[S.view]();
  }

  const moreObserver = new IntersectionObserver((ents) => {
    if (ents.some((e) => e.isIntersecting)) { S.shown += 15; renderDrops(); }
  }, { rootMargin: "600px" });

  // ── push alerts
  const b64ToBytes = (b64) => { const p = "=".repeat((4 - (b64.length % 4)) % 4); const s = atob((b64 + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
  const toB64Url = (str) => btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  function updateCode() {
    const sub = store.get("pushSub", null);
    $("#code-box").hidden = !sub;
    if (!sub) return;
    const brands = data.brands.map((b) => b.name).filter(on);
    const all = brands.length === data.brands.length;
    $("#alert-code").value = toB64Url(JSON.stringify({ s: sub, b: all ? null : brands, k: [...S.kinds] }));
  }
  async function enableAlerts() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { renderAlerts(); return; }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(window.SCENE_CONFIG.vapidPublicKey) });
      store.set("pushSub", sub.toJSON());
      reg.showNotification("Scene alerts are on", { body: "Copy your alert code so drops can reach this phone.", icon: "icon-192.png" });
      renderAlerts();
    } catch (e) {
      $("#alert-help").textContent = "Couldn't turn on alerts: " + (e && e.message ? e.message : e);
    }
  }

  // ── load
  async function load() {
    const btn = $("#refresh"); btn.classList.add("spin");
    try {
      const r = await fetch("data/items.json?t=" + Date.now(), { cache: "no-store" });
      data = await r.json();
      Object.keys(cats).forEach((k) => { if ((brandInfo(k).catalog || {}).updated !== cats[k].updated) delete cats[k]; });
      $("#updated").textContent = "updated " + fmtWhen(data.updated);
    } catch { $("#updated").textContent = "offline"; }
    btn.classList.remove("spin");
    if (!(S.view === "catalog" && S.cat)) render();
  }

  document.querySelectorAll(".tabbar button").forEach((b) => (b.onclick = () => {
    if (S.view === b.dataset.view && S.view === "catalog") S.cat = null;
    S.view = b.dataset.view; S.drop = null; S.shown = 15; store.set("view", S.view); render(); window.scrollTo(0, 0);
  }));
  $("#q").addEventListener("input", (e) => { S.q = e.target.value; S.drop = null; S.shown = 15; render(); });
  $("#refresh").onclick = load;
  $("#drop-back").onclick = () => { S.drop = null; render(); };
  $("#enable-alerts").onclick = enableAlerts;
  $("#copy-code").onclick = async () => {
    const tx = $("#alert-code"); tx.select();
    try { await navigator.clipboard.writeText(tx.value); } catch { document.execCommand("copy"); }
    $("#copy-code").textContent = "Copied ✓"; setTimeout(() => ($("#copy-code").textContent = "Copy code"), 1500);
  };
  $("#all-on").onclick = () => { S.off.clear(); store.set("brandsOff", []); updateCode(); render(); };
  $("#all-off").onclick = () => { data.brands.forEach((b) => S.off.add(b.name)); store.set("brandsOff", [...S.off]); updateCode(); render(); };
  if (isIOS && !standalone && !store.get("installHidden", false)) $("#install").hidden = false;
  $("#install-x").onclick = () => { $("#install").hidden = true; store.set("installHidden", true); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (!zoom.hidden) $("#zoom-x").click(); else if (!sheet.hidden) closeSheet(); } });
  const markVisit = () => store.set("lastVisit", new Date().toISOString());
  document.addEventListener("visibilitychange", () => { if (document.hidden) markVisit(); else load(); });
  window.addEventListener("pagehide", markVisit);

  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
  load();
})();
