"""Collect new products for the Scene app and save site/data/items.json.

1. Brand stores that publish a public product list (/products.json): exact
   products with photos, prices, stock and the time each one went live.
   Stores locked between drops (401) are recorded as "locked".
2. Brands whose sites block automated access (Supreme, Balenciaga, YSL,
   Chrome Hearts, Tom Ford, Arc'teryx...): product-release stories from
   fashion news feeds, with celebrity/outfit/business stories filtered out.
Run:  python fetch.py
"""
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "site" / "data" / "items.json"
UA = "Mozilla/5.0 (Scene personal drop tracker)"
PER_STORE = 80            # newest products kept per store
NEWS_KEEP_DAYS = 180
MAX_IMAGE_LOOKUPS = 60    # per run, to stay polite

NEWS_FEEDS = [
    ("Hypebeast", "https://hypebeast.com/feed"),
    ("Hypebeast", "https://hypebeast.com/fashion/feed"),
    ("Hypebeast", "https://hypebeast.com/footwear/feed"),
    ("Highsnobiety", "https://www.highsnobiety.com/feed/"),
    ("WWD", "https://wwd.com/fashion-news/feed/"),
]
NS = {"media": "http://search.yahoo.com/mrss/", "content": "http://purl.org/rss/1.0/modules/content/"}


def now():
    return datetime.now(timezone.utc)


def get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json, */*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def clean(text):
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def sized(src, w=700):
    if not src:
        return None
    if src.startswith("//"):
        src = "https:" + src
    return src + ("&" if "?" in src else "?") + f"width={w}"


# ── stores ───────────────────────────────────────────────────

def fetch_store(brand):
    domain = brand["store"]
    try:
        raw = get(f"https://{domain}/products.json?limit=250")
    except urllib.error.HTTPError as e:
        return ("locked" if e.code in (401, 423) else "error"), []
    except Exception:
        return "error", []
    try:
        products = json.loads(raw).get("products", [])
    except Exception:
        return "error", []
    out = []
    for p in products:
        variants = p.get("variants") or []
        prices = [float(v["price"]) for v in variants if v.get("price")]
        imgs = [sized(i.get("src")) for i in (p.get("images") or [])[:2]]
        if not imgs:
            continue
        out.append({
            "id": f"{domain}:{p['id']}",
            "brand": brand["name"],
            "title": clean(p.get("title")),
            "type": clean(p.get("product_type")),
            "price": min(prices) if prices else None,
            "currency": brand.get("currency", "USD"),
            "available": any(v.get("available") for v in variants),
            "images": imgs,
            "link": f"https://{domain}/products/{p.get('handle')}",
            "released": p.get("published_at") or p.get("created_at"),
        })
    out.sort(key=lambda x: x["released"] or "", reverse=True)
    return "open", out[:PER_STORE]


# ── news (brands without a readable store) ───────────────────

def parse_date(s):
    try:
        d = parsedate_to_datetime(s)
        return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    except Exception:
        return now()


def parse_feed(source, raw):
    for it in ET.fromstring(raw).iter("item"):
        title, link = clean(it.findtext("title")), (it.findtext("link") or "").strip()
        if not title or not link:
            continue
        desc = it.findtext("description") or ""
        body = it.findtext("content:encoded", namespaces=NS) or ""
        image = None
        for tag in ("media:thumbnail", "media:content"):
            el = it.find(tag, NS)
            if el is not None and el.get("url"):
                image = el.get("url")
                break
        if not image:
            m = re.search(r'<img[^>]+src="([^"]+)"', desc + body)
            image = html.unescape(m.group(1)) if m else None
        yield {
            "id": link.split("?")[0],
            "title": title,
            "link": link.split("?utm")[0],
            "source": source,
            "released": parse_date(it.findtext("pubDate") or "").isoformat(),
            "images": [image] if image else [],
            "summary": re.sub(r"^Summary\s*", "", clean(desc))[:240],
            "tags": [clean(c.text) for c in it.findall("category") if c.text],
        }


def brand_hits(item, brands):
    text_all = " ".join([item["title"], " ".join(item["tags"])])
    hits = []
    for b in brands:
        text = text_all
        for bad in b.get("exclude", []):
            text = re.sub(re.escape(bad), " ", text, flags=re.I)
        for w in b["match"]:
            if b.get("case_sensitive"):
                ok = re.search(r"(?<![A-Za-z])" + re.escape(w) + r"(?![a-z])", text)
            else:
                ok = re.search(r"(?<![a-z])" + re.escape(w.lower()) + r"(?![a-z])", text.lower())
            if ok:
                hits.append(b["name"])
                break
    return hits


def is_product_story(item, cfg):
    t = item["title"].lower()
    if any(w in t for w in cfg["not_product_words"]):
        return False
    return any(re.search(r"(?<![a-z])" + re.escape(w), t) for w in cfg["release_words"])


def og_image(url):
    try:
        page = get(url, timeout=20)[:400_000].decode("utf-8", "ignore")
    except Exception:
        return None
    m = re.search(r'<meta[^>]+property="og:image"[^>]+content="([^"]+)"', page)
    return html.unescape(m.group(1)) if m else None


# ── main ─────────────────────────────────────────────────────

def main():
    cfg = json.loads((ROOT / "brands.json").read_text(encoding="utf-8"))
    brands = cfg["brands"]
    old = {}
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            old = {}
    old_products = {p["id"]: p for p in old.get("products", [])}
    old_news = {n["id"]: n for n in old.get("news", [])}
    old_status = {b["name"]: b for b in old.get("brands", [])}
    first_run = not old_products
    stamp = now().isoformat()

    products, status, errors = [], [], []
    for b in brands:
        prev = old_status.get(b["name"], {})
        entry = {"name": b["name"], "kind": "store" if b.get("store") else "news"}
        if b.get("store"):
            st, items = fetch_store(b)
            entry["status"] = st
            entry["store"] = b["store"]
            if st == "locked":
                entry["locked_since"] = prev.get("locked_since") or stamp
                items = [p for p in old_products.values() if p["brand"] == b["name"]]
            elif st == "open":
                if prev.get("status") == "locked":
                    entry["opened_at"] = stamp  # store just unlocked: drop live
                elif prev.get("opened_at"):
                    entry["opened_at"] = prev["opened_at"]
            else:
                errors.append(f"{b['store']}: unreachable")
                items = [p for p in old_products.values() if p["brand"] == b["name"]]
            baseline = first_run or b["name"] not in old_status  # newly added brand: don't flood alerts
            for p in items:
                was = old_products.get(p["id"])
                p["first_seen"] = was["first_seen"] if was else (p["released"] if baseline else stamp)
            products += items
            time.sleep(0.7)
        status.append(entry)

    news_brands = brands  # release news for every tracked brand
    feeds = list(NEWS_FEEDS) + [("WWD", f"https://wwd.com/tag/{b['wwd_tag']}/feed/") for b in brands if b.get("wwd_tag")]
    fresh = {}
    for src, url in feeds:
        try:
            for it in parse_feed(src, get(url)):
                fresh.setdefault(it["id"], it)
        except Exception as e:
            errors.append(f"{url}: {e}")
        time.sleep(0.5)
    merged = dict(old_news)
    merged.update({k: v for k, v in fresh.items() if k not in merged or not merged[k].get("images") or v.get("images")})
    news, lookups = [], 0
    cutoff = now() - timedelta(days=NEWS_KEEP_DAYS)
    for it in merged.values():
        hits = brand_hits(it, news_brands)
        if not hits or not is_product_story(it, cfg) or datetime.fromisoformat(it["released"]) < cutoff:
            continue
        it["brands"] = hits
        it["first_seen"] = old_news.get(it["id"], {}).get("first_seen") or it["released"]
        if not it["images"] and not it.get("image_checked") and lookups < MAX_IMAGE_LOOKUPS:
            img = og_image(it["link"])
            it["images"] = [img] if img else []
            it["image_checked"] = True
            lookups += 1
            time.sleep(1)
        news.append(it)
    news.sort(key=lambda n: n["released"], reverse=True)

    # ── alert events (used for phone notifications and the in-app Alerts list)
    events = []
    if not first_run:
        for s in status:
            prev = old_status.get(s["name"], {})
            if s.get("status") == "locked" and prev.get("status") == "open":
                events.append({"brand": s["name"], "kind": "locked", "title": f"{s['name']} store just locked",
                               "body": "Stores usually lock right before a drop. Get ready.",
                               "url": f"https://{s['store']}"})
            if s.get("status") == "open" and prev.get("status") == "locked":
                events.append({"brand": s["name"], "kind": "live", "title": f"{s['name']} store is OPEN — drop live",
                               "body": "The store just unlocked. Tap to shop.", "url": f"https://{s['store']}"})
        by_brand = {}
        for p in products:
            if p["first_seen"] == stamp:
                by_brand.setdefault(p["brand"], []).append(p)
        for brand, items in by_brand.items():
            names = ", ".join(i["title"] for i in items[:3]) + ("…" if len(items) > 3 else "")
            events.append({"brand": brand, "kind": "products",
                           "title": f"{brand}: {len(items)} new piece{'s' if len(items) > 1 else ''}",
                           "body": names, "url": items[0]["link"], "image": items[0]["images"][0]})
        for n in news:
            if n["id"] not in old_news:
                events.append({"brand": n["brands"][0], "brands": n["brands"], "kind": "news",
                               "title": n["title"], "body": f"{', '.join(n['brands'])} · {n['source']}",
                               "url": n["link"], "image": (n["images"] or [None])[0]})
    for e in events:
        e["time"] = stamp
        e.setdefault("brands", [e["brand"]])
    all_events = (events + old.get("events", []))[:100]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    (ROOT / "new_events.json").write_text(json.dumps(events, ensure_ascii=False), encoding="utf-8")
    OUT.write_text(json.dumps({"updated": stamp, "brands": status, "products": products, "news": news, "events": all_events},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    opened = sum(1 for s in status if s.get("status") == "open")
    locked = [s["name"] for s in status if s.get("status") == "locked"]
    print(f"{len(products)} products from {opened} open stores, {len(news)} release stories. Locked: {', '.join(locked) or 'none'}")
    for e in errors:
        print("note:", e, file=sys.stderr)


if __name__ == "__main__":
    main()
