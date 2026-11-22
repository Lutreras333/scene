(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const KINDS = [
    ["products", "New pieces", "When a store adds new products"],
    ["live", "Store opens", "When a locked store unlocks (drop is live)"],
    ["locked", "Store locks", "Stores lock right before a drop"],
    ["news", "Release news", "Upcoming drops and collabs reported in the news"],
  ];
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  let data = { brands: [], products: [], news: [], events: [] };
  const S = {
    view: store.get("view", "drops"),
    brand: null,
    q: "",
    off: new Set(store.get("brandsOff", [])),
    kinds: new Set(store.get("alertKinds", KINDS.map((k) => k[0]))),
    saved: store.get("saved", {}),
    lastVisit: store.get("lastVisit", null),
    shown: 15,
    drop: null,
  };
  const on = (name) => !S.off.has(name);

  const fmtWhen = (iso) => {
    if (!iso) return "";
    const d = new Date(iso), s = (Date.now() - d) / 1000;
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }) +
      " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };
  const fmtPrice = (p) => p.price == null ? "" : new Intl.NumberFormat(undefined, { style: "currency", currency: p.currency || "USD", maximumFractionDigits: p.price % 1 ? 2 : 0 }).format(p.price);
  const isNew = (x) => S.lastVisit && x.first_seen && x.first_seen > S.lastVisit;
  const matchQ = (txt) => !S.q || txt.toLowerCase().includes(S.q.toLowerCase());

  // ── data views
  const DROP_GAP = 12 * 3600 * 1000; // pieces released within 12h of each other = one drop
  const t = (iso) => new Date(iso || 0).getTime();

  // "Chargers Hoodie - Black" and "Chargers Hoodie - White" → one model, 2 colors
  const baseName = (title) => title.replace(/\s+[-–—|/]\s+[^-–—|/]+$/, "").replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
  function models(items) {
    const m = new Map();
    items.forEach((p) => {
      const k = baseName(p.title);
      const g = m.get(k);
      if (!g) m.set(k, { ...p, title: p.title.replace(/\s+[-–—|/]\s+[^-–—|/]+$/, ""), variants: [p], colors: 1, priceMax: p.price });
      else {
        g.variants.push(p); g.colors++;
        if (p.price != null) { g.price = Math.min(g.price ?? p.price, p.price); g.priceMax = Math.max(g.priceMax ?? p.price, p.price); }
        g.available = g.available || p.available;
        if (p.first_seen > (g.first_seen || "")) g.first_seen = p.first_seen;
      }
    });
    return [...m.values()];
  }

  // Release stories about the same thing (3 articles on Supreme × Timberland) → one entry
  const STOP = new Set("the and with for from this that their your have will into over just more new its are was has been after first".split(" "));
  const words = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
  function clusterNews(list) {
    const out = [];
    list.slice().sort((a, b) => b.released.localeCompare(a.released)).forEach((n) => {
      const w = words(n.title);
      const hit = out.find((c) => c.brands.some((b) => n.brands.includes(b)) && Math.abs(t(c.released) - t(n.released)) < 7 * 86400000 &&
        [...w].filter((x) => c.w.has(x)).length / Math.max(1, Math.min(w.size, c.w.size)) >= 0.34);
      if (hit) { hit.more.push(n); w.forEach((x) => hit.w.add(x)); if (!hit.images.length && n.images.length) hit.images = n.images; }
      else out.push({ ...n, w, more: [] });
    });
    return out;
  }

  function allDrops() {
    const drops = [];
    const byBrand = {};
    data.products.filter((p) => on(p.brand)).forEach((p) => (byBrand[p.brand] = byBrand[p.brand] || []).push(p));
    Object.entries(byBrand).forEach(([brand, items]) => {
      items.sort((a, b) => t(b.released) - t(a.released));
      let cur = null;
      items.forEach((p) => {
        if (!cur || t(cur.start) - t(p.released) > DROP_GAP) { cur = { brand, end: p.released, start: p.released, items: [] }; drops.push(cur); }
        cur.items.push(p); cur.start = p.released;
      });
    });
    drops.forEach((d) => { d.models = models(d.items); d.key = d.brand + "|" + d.end; d.isNew = d.items.some(isNew); });
    // brands that block apps: their release stories appear as drop entries
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

  // ── rendering helpers
  function card(x) {
    const c = el("article", "card");
    const a = el("a", "ph" + (x.story ? " story" : ""));
    a.href = x.link; a.target = "_blank"; a.rel = "noopener noreferrer"; a.dataset.brand = x.brand;
    const imgs = x.images || [];
    if (imgs.length) {
      imgs.slice(0, 2).forEach((src, i) => {
        const im = el("img", i ? "alt" : ""); im.loading = "lazy"; im.referrerPolicy = "no-referrer"; im.alt = i ? "" : x.title; im.src = src;
        im.onerror = () => { im.remove(); if (!a.querySelector("img")) a.classList.add("noimg"); };
        a.append(im);
      });
    } else a.classList.add("noimg");
    const badges = el("div", "badges");
    if (isNew(x)) badges.append(el("span", "badge new", "New"));
    if (x.story) badges.append(el("span", "badge story", "Release news"));
    if (x.available === false) badges.append(el("span", "badge out", "Sold out"));
    a.append(badges);
    const sv = el("button", "save"); sv.setAttribute("aria-label", "Save");
    const paint = () => { const s = !!S.saved[x.id]; sv.classList.toggle("on", s); sv.textContent = s ? "♥" : "♡"; };
    sv.onclick = (e) => { e.preventDefault(); if (S.saved[x.id]) delete S.saved[x.id]; else S.saved[x.id] = x; store.set("saved", S.saved); paint(); if (S.view === "saved") render(); };
    paint();
    const cb = el("div", "cb");
    cb.append(el("div", "brand", x.brand));
    const t = el("a", "title", x.title); t.href = x.link; t.target = "_blank"; t.rel = "noopener noreferrer";
    cb.append(t);
    const f = el("div", "foot");
    const price = x.priceMax != null && x.priceMax !== x.price ? `${fmtPrice(x)}–${fmtPrice({ ...x, price: x.priceMax })}` : fmtPrice(x);
    f.append(el("span", "price", price), el("span", "when", x.colors > 1 ? `${x.colors} colors` : ""));
    cb.append(f);
    c.append(a, sv, cb);
    return c;
  }
  function row(n, kicker, meta) {
    const r = el("a", "row"); r.href = n.url || n.link; r.target = "_blank"; r.rel = "noopener noreferrer";
    const img = (n.images && n.images[0]) || n.image;
    if (img) { const im = el("img"); im.loading = "lazy"; im.referrerPolicy = "no-referrer"; im.src = img; im.alt = ""; im.onerror = () => im.replaceWith(el("div", "noimg")); r.append(im); }
    else r.append(el("div", "noimg"));
    const b = el("div", "rb");
    b.append(el("div", "rk", kicker), el("div", "rt", n.title), el("div", "rm", meta));
    r.append(b);
    return r;
  }
  function makeSwitch(checked, onchange) {
    const l = el("label", "switch"); const i = el("input"); i.type = "checkbox"; i.checked = checked;
    i.onchange = () => onchange(i.checked); l.append(i, el("span")); return l;
  }

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
  function renderStatus() {
    const box = $("#status"); box.innerHTML = "";
    const day = 86400000;
    data.brands.filter((b) => b.kind === "store" && on(b.name)).forEach((b) => {
      let cls = null, txt = null;
      if (b.status === "locked") { cls = "locked"; txt = `${b.name} · locked, drop coming`; }
      else if (b.opened_at && Date.now() - new Date(b.opened_at) < 2 * day) { cls = "live"; txt = `${b.name} · live now`; }
      if (!cls) return;
      const p = el("a", "pill " + cls); p.href = "https://" + b.store; p.target = "_blank"; p.rel = "noopener noreferrer";
      p.append(el("span", "dot"), el("span", "", txt)); box.append(p);
    });
  }
  function dropCard(d) {
    const c = el("article", "drop");
    const head = el("button", "drop-head");
    const left = el("div", "dh-l");
    left.append(el("div", "dh-brand", d.brand));
    if (d.story) {
      left.append(el("div", "dh-meta", `Release news · ${fmtWhen(d.end)}${d.story.more.length ? ` · ${d.story.more.length + 1} stories` : ""}`));
    } else {
      const n = d.models.length;
      left.append(el("div", "dh-meta", `${fmtWhen(d.end)} · ${n} piece${n > 1 ? "s" : ""}${d.items.every((i) => i.available === false) ? " · sold out" : ""}`));
    }
    head.append(left);
    if (d.isNew) head.append(el("span", "badge new", "New"));
    head.append(el("span", "chev", "›"));
    c.append(head);
    if (d.story) {
      const s = d.story;
      const a = el("a", "story-body"); a.href = s.link; a.target = "_blank"; a.rel = "noopener noreferrer";
      if (s.images[0]) { const im = el("img"); im.loading = "lazy"; im.referrerPolicy = "no-referrer"; im.src = s.images[0]; im.alt = ""; im.onerror = () => im.remove(); a.append(im); }
      a.append(el("div", "story-t", s.title), el("div", "story-s", s.source));
      head.onclick = () => window.open(s.link, "_blank", "noopener");
      c.append(a);
    } else {
      const strip = el("div", "strip");
      d.models.slice(0, 12).forEach((m) => {
        const th = el("button", "th");
        const im = el("img"); im.loading = "lazy"; im.referrerPolicy = "no-referrer"; im.src = m.images[0]; im.alt = m.title; im.onerror = () => im.remove();
        th.append(im); th.onclick = () => openDrop(d); strip.append(th);
      });
      if (d.models.length > 12) { const more = el("button", "th more-th", `+${d.models.length - 12}`); more.onclick = () => openDrop(d); strip.append(more); }
      head.onclick = () => openDrop(d);
      c.append(strip);
    }
    return c;
  }
  function openDrop(d) { S.drop = d; render(); window.scrollTo(0, 0); }
  function renderDrops() {
    const grid = $("#grid"), list = $("#drop-list"), back = $("#drop-back");
    grid.innerHTML = ""; list.innerHTML = "";
    if (S.drop) {
      $("#status").innerHTML = "";
      back.hidden = false;
      back.querySelector(".db-t").textContent = `${S.drop.brand} · ${fmtWhen(S.drop.end)}`;
      S.drop.models.forEach((m) => grid.append(card(m)));
      setEmpty("");
      return;
    }
    back.hidden = true;
    renderStatus();
    const drops = allDrops();
    drops.slice(0, S.shown).forEach((d) => list.append(dropCard(d)));
    setEmpty(drops.length ? "" : S.off.size >= data.brands.length ? "All brands are switched off. Turn some on in Brands." : "Nothing matches yet.");
    moreObserver.disconnect();
    if (drops.length > S.shown) moreObserver.observe($("#more"));
  }
  function renderNews() {
    const box = $("#news"); box.innerHTML = "";
    const list = newsList();
    list.slice(0, 150).forEach((n) => box.append(row(n, n.brands.join(" · "), `${n.source}${n.more.length ? ` +${n.more.length} more` : ""} · ${fmtWhen(n.released)}`)));
    setEmpty(list.length ? "" : "No release news for your brands yet. New stories are added every refresh.");
  }
  function renderSaved() {
    const box = $("#saved"); box.innerHTML = "";
    const list = Object.values(S.saved).sort((a, b) => (b.released || "").localeCompare(a.released || ""));
    list.forEach((x) => box.append(card(x)));
    setEmpty(list.length ? "" : "Nothing saved yet. Tap ♡ on any piece.");
  }
  function renderBrands() {
    const box = $("#brand-list"); box.innerHTML = "";
    const order = { store: 0, news: 1 };
    data.brands.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((b) => {
      const r = el("div", "toggle-row");
      const n = el("div", "tn"); n.append(el("b", "", b.name));
      const count = b.kind === "store" ? data.products.filter((p) => p.brand === b.name).length : data.news.filter((x) => x.brands.includes(b.name)).length;
      const st = b.kind === "store" ? (b.status === "locked" ? "Shop · locked (drop soon)" : b.status === "error" ? "Shop · not reachable right now" : `Shop · ${count} pieces`) : `News · ${count} release stories`;
      n.append(el("span", "", st));
      r.append(n, makeSwitch(on(b.name), (v) => { v ? S.off.delete(b.name) : S.off.add(b.name); store.set("brandsOff", [...S.off]); updateCode(); }));
      box.append(r);
    });
    setEmpty("");
  }
  function renderAlerts() {
    const help = $("#alert-help"), btn = $("#enable-alerts");
    const perm = "Notification" in window ? Notification.permission : "unsupported";
    if (!standalone && isIOS) { help.innerHTML = "First install Scene: tap <b>Share</b> → <b>Add to Home Screen</b>, then open it from your Home Screen and come back here."; btn.disabled = true; }
    else if (!("PushManager" in window) || !("serviceWorker" in navigator)) { help.textContent = "This browser can't receive web alerts. On iPhone, use the Home Screen app (iOS 16.4 or later)."; btn.disabled = true; }
    else if (perm === "denied") { help.textContent = "Alerts are blocked. Turn them on in iPhone Settings → Notifications → Scene."; btn.disabled = true; }
    else { help.textContent = "Get a ping when your brands add pieces, when a store locks or opens for a drop, and when a release is announced."; btn.disabled = false; }
    btn.textContent = store.get("pushSub", null) ? "Alerts on · send test code again" : "Turn on alerts";
    const kinds = $("#alert-kinds"); kinds.innerHTML = "";
    KINDS.forEach(([k, label, sub]) => {
      const r = el("div", "toggle-row"); const n = el("div", "tn"); n.append(el("b", "", label), el("span", "", sub));
      r.append(n, makeSwitch(S.kinds.has(k), (v) => { v ? S.kinds.add(k) : S.kinds.delete(k); store.set("alertKinds", [...S.kinds]); updateCode(); }));
      kinds.append(r);
    });
    updateCode();
    const ev = $("#events"); ev.innerHTML = "";
    const list = (data.events || []).filter((e) => (e.brands || [e.brand]).some(on) && S.kinds.has(e.kind));
    list.forEach((e) => ev.append(row(e, (e.brands || [e.brand]).join(" · "), `${e.body || ""} · ${fmtWhen(e.time)}`)));
    setEmpty("");
    if (!list.length) ev.append(el("p", "muted small", "No alerts yet. They appear here as drops happen."));
  }

  function setEmpty(msg) { const e = $("#empty"); e.hidden = !msg; e.textContent = msg; }

  function render() {
    document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "view-" + S.view));
    document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.view === S.view));
    $("#filters").hidden = !["drops", "news"].includes(S.view) || !!S.drop;
    if (S.view === "drops" || S.view === "news") renderChips();
    ({ drops: renderDrops, news: renderNews, saved: renderSaved, brands: renderBrands, alerts: renderAlerts })[S.view]();
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
      $("#updated").textContent = "updated " + fmtWhen(data.updated);
    } catch { $("#updated").textContent = "offline"; }
    btn.classList.remove("spin");
    render();
  }

  document.querySelectorAll(".tabbar button").forEach((b) => (b.onclick = () => { S.view = b.dataset.view; S.drop = null; S.shown = 15; store.set("view", S.view); render(); window.scrollTo(0, 0); }));
  $("#q").addEventListener("input", (e) => { S.q = e.target.value; S.drop = null; S.shown = 15; render(); });
  $("#refresh").onclick = load;
  $("#drop-back").onclick = () => { S.drop = null; render(); };
  $("#enable-alerts").onclick = enableAlerts;
  $("#copy-code").onclick = async () => {
    const t = $("#alert-code"); t.select();
    try { await navigator.clipboard.writeText(t.value); } catch { document.execCommand("copy"); }
    $("#copy-code").textContent = "Copied ✓"; setTimeout(() => ($("#copy-code").textContent = "Copy code"), 1500);
  };
  $("#all-on").onclick = () => { S.off.clear(); store.set("brandsOff", []); updateCode(); render(); };
  $("#all-off").onclick = () => { data.brands.forEach((b) => S.off.add(b.name)); store.set("brandsOff", [...S.off]); updateCode(); render(); };
  if (isIOS && !standalone && !store.get("installHidden", false)) $("#install").hidden = false;
  $("#install-x").onclick = () => { $("#install").hidden = true; store.set("installHidden", true); };
  const markVisit = () => store.set("lastVisit", new Date().toISOString());
  document.addEventListener("visibilitychange", () => { if (document.hidden) markVisit(); else load(); });
  window.addEventListener("pagehide", markVisit);

  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
  load();
})();
