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
        imgs = [sized(i.get("src"), 900) for i in (p.get("images") or [])[:8]]
        if not imgs:
            continue
        out.append({
            "sizes": sizes(variants),
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


def password_page_date(domain):
    """A locked store's public password page often says when the drop opens."""
    try:
        page = get(f"https://{domain}/password", timeout=20)[:600_000].decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        page = e.read()[:600_000].decode("utf-8", "ignore") if e.code in (401, 423) else ""
    except Exception:
        return None
    page = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", page)
    text = clean(re.sub(r"<(br|/p|/div|/h\d)[^>]*>", "\n", page, flags=re.I))
    found = find_drop_date(text.replace(" | ", "\n"), now(), numeric=True)
    if not found:  # a bare date on a locked page almost always means the drop date
        found = find_drop_date("drop " + text[:3000], now(), numeric=True)
    if found:
        found["source"] = "store page"
    return found


# ── full catalogs (every piece + the store's collections) ────
# A few stores per run, stalest first, so each run stays short and polite.

CAT_DIR = ROOT / "site" / "data" / "catalog"
CAT_PER_RUN = 4
CAT_TIME_BUDGET = 7 * 60   # seconds of catalog work per run, then the rest waits for the next run
CAT_MAX_AGE = timedelta(hours=6)
CAT_MAX_PAGES = 60         # 60 × 250 = the whole store for any brand here
CAT_MAX_COLLECTIONS = 250
SKIP_COLLECTIONS = {"all", "frontpage", "home", "homepage", "home-page", "all-products", "shop-all", "shop", "products"}


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower().replace("é", "e").replace("ü", "u")).strip("-")


def get_json(url):
    return json.loads(get(url))


def paged(url, max_pages):
    out = []
    for page in range(1, max_pages + 1):
        items = get_json(f"{url}{'&' if '?' in url else '?'}limit=250&page={page}").get("products", [])
        out += items
        if len(items) < 250:
            break
        time.sleep(0.4)
    return out


def sizes(variants):
    out = []
    for v in variants[:30]:
        name = clean(v.get("title"))
        if not name or name.lower() == "default title":
            continue
        out.append([name, 1 if v.get("available") else 0])
    return out


def build_catalog(brand, deadline=None):
    """Return the catalog dict, or None if the store can't be read right now."""
    domain = brand["store"]
    try:
        raw = paged(f"https://{domain}/products.json", CAT_MAX_PAGES)
    except Exception:
        return None
    products = []
    for p in raw:
        variants = p.get("variants") or []
        prices = [float(v["price"]) for v in variants if v.get("price")]
        imgs = [sized(i.get("src"), 900) for i in (p.get("images") or [])[:8]]
        if not imgs:
            continue
        products.append({
            "i": str(p["id"]), "t": clean(p.get("title")), "y": clean(p.get("product_type")),
            "p": min(prices) if prices else None, "q": max(prices) if prices else None,
            "a": any(v.get("available") for v in variants), "img": imgs, "h": p.get("handle"),
            "r": p.get("published_at") or p.get("created_at"), "s": sizes(variants),
            "d": clean(p.get("body_html"))[:400],
        })
    products.sort(key=lambda x: x["r"] or "", reverse=True)
    have = {p["i"] for p in products}

    collections = []
    try:
        cols = get_json(f"https://{domain}/collections.json?limit=250").get("collections", [])
    except Exception:
        cols = []
    cols = [c for c in cols if c.get("handle") not in SKIP_COLLECTIONS and c.get("products_count", 1) > 0
            and not re.search(r"\b(hidden|test|draft|do not use|wholesale)\b", (c.get("title") or "").lower())]
    cols.sort(key=lambda c: c.get("published_at") or c.get("updated_at") or "", reverse=True)
    for c in cols[:CAT_MAX_COLLECTIONS]:
        if deadline and time.time() > deadline:
            break
        time.sleep(0.35)
        try:
            items = paged(f"https://{domain}/collections/{c['handle']}/products.json", 20)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                break  # store asked us to slow down; keep what we have
            continue
        except Exception:
            continue
        ids = [str(p["id"]) for p in items if str(p["id"]) in have]
        if len(ids) >= 2 and len(ids) < len(products):  # skip empty and "everything" collections
            collections.append({"h": c["handle"], "t": clean(c.get("title")), "ids": ids,
                                "r": c.get("published_at") or c.get("updated_at")})
    return {"brand": brand["name"], "store": domain, "currency": brand.get("currency", "USD"),
            "updated": now().isoformat(), "collections": collections, "products": products}


def refresh_catalogs(brands, status, old_status, stamp):
    CAT_DIR.mkdir(parents=True, exist_ok=True)
    by_name = {b["name"]: b for b in brands}
    due = []
    for s in status:
        if s.get("kind") != "store":
            continue
        prev = (old_status.get(s["name"]) or {}).get("catalog")
        s["catalog"] = prev  # keep last catalog until a new one is built
        if s.get("status") != "open":
            continue
        age = now() - datetime.fromisoformat(prev["updated"]) if prev else None
        just_live = s.get("opened_at") == stamp
        if just_live or not prev or age > CAT_MAX_AGE or not (CAT_DIR / f"{prev['file']}.json").exists():
            due.append((0 if just_live else 1, prev["updated"] if prev else "", s))
    due.sort(key=lambda x: (x[0], x[1]))
    done = []
    start = time.time()
    for _, _, s in due[:CAT_PER_RUN]:
        if time.time() - start > CAT_TIME_BUDGET:
            break
        cat = build_catalog(by_name[s["name"]], deadline=start + CAT_TIME_BUDGET + 120)
        if not cat or not cat["products"]:
            continue
        f = slug(s["name"])
        (CAT_DIR / f"{f}.json").write_text(json.dumps(cat, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        s["catalog"] = {"file": f, "count": len(cat["products"]), "collections": len(cat["collections"]), "updated": cat["updated"]}
        done.append(f"{s['name']} ({len(cat['products'])} pieces, {len(cat['collections'])} collections)")
        time.sleep(0.7)
    return done


# ── Supreme weekly droplists (supremecommunity.com public pages) ──
# supremenewyork.com blocks apps; SupremeCommunity's public droplist pages
# allow it (robots.txt only closes /api/ and admin pages). Past weeks never
# change, so each is read once; only the newest two are re-read.

SC = "https://www.supremecommunity.com"
SC_FILE = "supreme"


def sc_week(path, date, season, num):
    page = get(SC + path).decode("utf-8", "ignore")
    items = []
    for blk in page.split('<div class="item-card"')[1:]:
        blk = blk[:4000]
        attr = lambda k: (re.search(k + r'="([^"]*)"', blk) or [None, ""])[1]
        img = re.search(r'(https://cdn\.supremecommunity\.com/[^" ]+?)_\d+px\.(jpe?g|png|webp)', blk)
        if not attr("data-item-id") or not img:
            continue
        price = attr("data-price")
        items.append({
            "i": "sc" + attr("data-item-id"), "t": html.unescape(attr("data-name")), "y": attr("data-category").replace("-", " ").title(),
            "p": float(price) if price else None, "q": float(price) if price else None, "a": True,
            "img": [f"{img.group(1)}_768px.{img.group(2)}"], "link": SC + attr("data-href"),
            "r": f"{date}T15:00:00+00:00", "v": int(attr("data-votes") or 0),
        })
    d = datetime.fromisoformat(date)
    return {"h": date, "t": f"{season} Week {num} · {d:%b} {d.day}", "r": f"{date}T15:00:00+00:00", "items": items}


def fetch_supreme(old_cat):
    """Return (catalog, upcoming) or (None, None) when the site can't be read."""
    try:
        idx = get(SC + "/season/latest/droplists/").decode("utf-8", "ignore")
    except Exception:
        return None, None
    weeks = sorted(set(re.findall(r'href="(/season/([a-z-]+?)(\d{4})/droplist/(\d{4}-\d\d-\d\d)/)"', idx)), key=lambda w: w[3])
    if not weeks:
        return None, None
    name, year = weeks[-1][1], weeks[-1][2]
    season = ("FW" if "fall" in name else "SS") + year[-2:]
    weeks = [w for w in weeks if w[1] == name and w[2] == year]
    cached = {c["h"]: c for c in (old_cat or {}).get("collections", [])}
    cols = []
    newest = {w[3] for w in weeks[-2:]}
    for n, (path, _, _, date) in enumerate(weeks, 1):
        if date in cached and date not in newest and cached[date].get("items"):
            cols.append(cached[date])
            continue
        try:
            cols.append(sc_week(path, date, season, n))
        except Exception:
            if date in cached:
                cols.append(cached[date])
        time.sleep(2)
    products, seen = [], set()
    for c in cols:
        c["ids"] = [it["i"] for it in c["items"]]
        for it in c["items"]:
            if it["i"] not in seen:
                seen.add(it["i"])
                products.append(it)
    products.sort(key=lambda x: (x["r"], x.get("v", 0)), reverse=True)
    cat = {"brand": "Supreme", "store": "supremenewyork.com", "source": "SupremeCommunity droplists", "currency": "USD",
           "updated": now().isoformat(), "collections": sorted(cols, key=lambda c: c["h"], reverse=True), "products": products}
    latest = cat["collections"][0] if cat["collections"] else None
    upcoming = None
    if latest and latest["h"] >= (now() - timedelta(hours=20)).date().isoformat():
        upcoming = {"date": latest["h"], "time": "11:00 AM ET", "said": f"Supreme {latest['t']} droplist: {len(latest['items'])} pieces",
                    "collection": latest["h"]}
    return cat, upcoming


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


IMG_RE = re.compile(r'https?://[^"\'\s<>()]+?\.(?:jpe?g|png|webp)(?:\?[^"\'\s<>()]*)?', re.I)
SLUG_STOP = {"the", "and", "with", "for", "release", "info", "date", "first", "look", "official", "images", "new", "drop", "collection"}


MONTHS = {m: i for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split(), 1)}
WEEKDAYS = "monday tuesday wednesday thursday friday saturday sunday".split()
DATE_RE = re.compile(
    r"\b(?P<mon>jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(?P<day>\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(?P<year>20\d\d))?"
    r"|\b(?P<rel>today|tomorrow|this\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)"
    r"|(?:on\s+)(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b"
    r"|\b(?P<m2>\d{1,2})[./](?P<d2>\d{1,2})(?![./]\d{3})", re.I)
TIME_RE = re.compile(r"\b(\d{1,2})(?::(\d\d))?\s*(a\.?m\.?|p\.?m\.?)\s*(e[sd]?t|p[sd]?t|c[sd]?t|bst|gmt|cet|aest|aedt|jst|kst)?", re.I)
DROP_CTX = re.compile(r"releas|drop|launch|available|arriv|hits|on sale|restock|via|online|in-store|stores", re.I)


def find_drop_date(text, ref, numeric=False):
    """The first date in text that sits in a release sentence and is from yesterday up to 4 months ahead."""
    ref = ref.astimezone(timezone.utc)
    for sent in re.split(r"(?<=[.!?])\s+|\n", text):
        if not DROP_CTX.search(sent):
            continue
        for m in DATE_RE.finditer(sent):
            d = None
            try:
                if m.group("mon"):
                    y = int(m.group("year") or ref.year)
                    d = datetime(y, MONTHS[m.group("mon").lower()[:3]], int(m.group("day")), tzinfo=timezone.utc)
                    if not m.group("year") and d < ref - timedelta(days=60):
                        d = d.replace(year=y + 1)
                elif m.group("rel"):
                    r = m.group("rel").lower()
                    if r == "today":
                        d = ref
                    elif r == "tomorrow":
                        d = ref + timedelta(days=1)
                    else:
                        wd = WEEKDAYS.index(r.split()[-1])
                        ahead = (wd - ref.weekday()) % 7 + (7 if r.startswith("next") else 0)
                        d = ref + timedelta(days=ahead)
                elif numeric and m.group("m2"):
                    d = datetime(ref.year, int(m.group("m2")), int(m.group("d2")), tzinfo=timezone.utc)
                    if d < ref - timedelta(days=60):
                        d = d.replace(year=ref.year + 1)
            except ValueError:
                continue
            if d and ref - timedelta(days=1) <= d <= ref + timedelta(days=120):
                tm = TIME_RE.search(sent[m.end():m.end() + 60]) or TIME_RE.search(sent)
                when = None
                if tm:
                    when = f"{int(tm.group(1))}:{tm.group(2) or '00'} {tm.group(3).replace('.', '').upper()}" + (f" {tm.group(4).upper()}" if tm.group(4) else "")
                return {"date": d.date().isoformat(), "time": when, "said": clean(sent)[:160]}
    return None


def article_page(url):
    try:
        return get(url, timeout=25)[:1_500_000].decode("utf-8", "ignore")
    except Exception:
        return ""


def article_text(page):
    body = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", page)
    paras = re.findall(r"(?is)<p[^>]*>(.*?)</p>", body)
    return "\n".join(clean(p) for p in paras[:60])


def article_images(url, limit=16, page=None):
    """Photos that belong to the article (their file names share words with the article's address)."""
    if page is None:
        page = article_page(url)
    if not page:
        return []
    from urllib.parse import quote, unquote
    slug_words = [w for w in re.split(r"[^a-z0-9]+", url.rstrip("/").split("/")[-1].lower()) if len(w) > 2 and w not in SLUG_STOP and not w.isdigit()]
    if not slug_words:
        return []
    out, seen = [], set()
    for raw in IMG_RE.findall(html.unescape(unquote(page))):
        if "image-cdn.hypb.st/" in raw:
            raw = raw.split("image-cdn.hypb.st/", 1)[1]
        base = raw.split("?")[0]
        name = base.rsplit("/", 1)[-1].lower()
        if base in seen or name.startswith(("logo", "avatar", "icon")):
            continue
        hits = sum(1 for w in slug_words[:6] if w in name)
        if hits < min(2, len(slug_words)):
            continue
        seen.add(base)
        if "hypebeast.com/image/" in base:
            out.append("https://image-cdn.hypb.st/" + quote(base, safe="") + "?w=1260&cbr=1&q=90&fit=max")
        elif "/wp-content/uploads/" in base:
            out.append(base + "?w=1200")
        else:
            out.append(base)
        if len(out) >= limit:
            break
    return out


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
                entry["upcoming"] = password_page_date(b["store"])
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

    catalogs = refresh_catalogs(brands, status, old_status, stamp)

    # Supreme: weekly droplists become its catalog (one collection per week) and its drops
    sup = next((s for s in status if s["name"] == "Supreme"), None)
    if sup:
        prev = old_status.get("Supreme", {})
        sup["catalog"], sup["upcoming"] = prev.get("catalog"), prev.get("upcoming")
        f = CAT_DIR / f"{SC_FILE}.json"
        old_cat = json.loads(f.read_text(encoding="utf-8")) if f.exists() else None
        stale = not old_cat or now() - datetime.fromisoformat(old_cat["updated"]) > timedelta(hours=2)
        cat = None
        if stale:
            cat, up = fetch_supreme(old_cat)
            if cat and cat["products"]:
                f.write_text(json.dumps(cat, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
                sup["catalog"] = {"file": SC_FILE, "count": len(cat["products"]), "collections": len(cat["collections"]),
                                  "updated": cat["updated"], "source": cat["source"]}
                sup["upcoming"] = up
                catalogs.append(f"Supreme ({len(cat['products'])} pieces, {len(cat['collections'])} weeks)")
        cat = cat or old_cat
        if cat and not sup.get("catalog"):
            sup["catalog"] = {"file": SC_FILE, "count": len(cat["products"]), "collections": len(cat["collections"]),
                              "updated": cat["updated"], "source": cat.get("source")}
        if cat:  # the last 4 weeks also show in the Drops feed
            baseline = first_run or not any(p["brand"] == "Supreme" for p in old_products.values())
            for c in cat["collections"][:4]:
                for it in c["items"]:
                    pid = "supreme:" + it["i"]
                    was = old_products.get(pid)
                    products.append({"id": pid, "brand": "Supreme", "title": it["t"], "type": it["y"], "price": it["p"],
                                     "currency": "USD", "available": True, "images": it["img"], "link": it["link"],
                                     "released": it["r"], "week": c["t"],
                                     "first_seen": was["first_seen"] if was else (it["r"] if baseline else stamp)})
        if sup.get("upcoming") and sup["upcoming"]["date"] < (now() - timedelta(days=1)).date().isoformat():
            sup["upcoming"] = None

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
        prev_n = old_news.get(it["id"], {})
        pub = datetime.fromisoformat(it["released"])
        it["drop"] = find_drop_date(it["title"] + ". " + it.get("summary", ""), pub)
        if prev_n.get("gallery_checked"):
            it["gallery"], it["gallery_checked"] = prev_n.get("gallery", []), True
            it["drop"] = it["drop"] or prev_n.get("drop")
        elif lookups < MAX_IMAGE_LOOKUPS:
            page = article_page(it["link"])
            it["gallery"] = article_images(it["link"], page=page)
            it["drop"] = it["drop"] or find_drop_date(article_text(page), pub)
            it["gallery_checked"] = True
            if not it["images"] and it["gallery"]:
                it["images"] = it["gallery"][:1]
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
            up, was = s.get("upcoming"), prev.get("upcoming") or {}
            if up and up.get("date") != was.get("date"):
                d = datetime.fromisoformat(up["date"])
                events.append({"brand": s["name"], "kind": "upcoming",
                               "title": f"{s['name']} drops {d:%a %b} {d.day}{' · ' + up['time'] if up.get('time') else ''}",
                               "body": up.get("said") or "Drop date announced.",
                               "url": f"https://{s['store']}" if s.get("store") else "./"})
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
    print("catalogs refreshed:", ", ".join(catalogs) or "none due")
    for e in errors:
        print("note:", e, file=sys.stderr)


if __name__ == "__main__":
    main()
