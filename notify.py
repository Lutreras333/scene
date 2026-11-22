"""Send phone notifications for the events fetch.py just found.

Needs two secrets (set as GitHub Actions secrets, never committed):
  VAPID_PRIVATE  - contents of secrets/vapid_private.pem
  PUSH_SUBS      - one "alert code" per line, copied from the app's Alerts screen
An alert code holds the phone's push address plus the brands it wants.
"""
import base64
import json
import os
import sys
from pathlib import Path

from pywebpush import WebPushException, webpush

ROOT = Path(__file__).resolve().parent
MAX_PER_PHONE = 6


def decode(code):
    code = code.strip()
    code += "=" * (-len(code) % 4)
    return json.loads(base64.urlsafe_b64decode(code))


def main():
    events_file = ROOT / "new_events.json"
    events = json.loads(events_file.read_text(encoding="utf-8")) if events_file.exists() else []
    if "--test" in sys.argv:
        events = [{"brand": "Scene", "brands": [], "kind": "test", "title": "Scene alerts are on",
                   "body": "You'll get a ping when your brands drop.", "url": "./"}]
    key = os.environ.get("VAPID_PRIVATE", "").strip()
    if not key and (ROOT / "secrets" / "vapid_private.pem").exists():
        key = (ROOT / "secrets" / "vapid_private.pem").read_text()
    subs = [l for l in os.environ.get("PUSH_SUBS", "").splitlines() if l.strip()]
    if not events or not key or not subs:
        print(f"nothing to send (events={len(events)}, key={'yes' if key else 'no'}, phones={len(subs)})")
        return
    vapid = key.replace("\\n", "\n")
    sent = 0
    for code in subs:
        try:
            sub = decode(code)
        except Exception:
            print("skipping an alert code that couldn't be read")
            continue
        wanted = set(sub.get("b") or [])
        kinds = set(sub.get("k") or ["products", "live", "locked", "news", "test"])
        mine = [e for e in events if e["kind"] in kinds and (e["kind"] == "test" or not wanted or wanted & set(e.get("brands") or [e["brand"]]))]
        if len(mine) > MAX_PER_PHONE:
            extra = len(mine) - (MAX_PER_PHONE - 1)
            mine = mine[:MAX_PER_PHONE - 1] + [{"title": f"+{extra} more updates", "body": "Open Scene to see everything new.", "url": "./"}]
        for e in mine:
            payload = json.dumps({"title": e["title"], "body": e.get("body", ""), "url": e.get("url", "./"),
                                  "image": e.get("image"), "tag": e.get("kind", "x") + e.get("brand", "")})
            try:
                webpush(subscription_info=sub["s"], data=payload, vapid_private_key=vapid,
                        vapid_claims={"sub": os.environ.get("SITE_URL") or "https://github.com"}, ttl=6 * 3600)
                sent += 1
            except WebPushException as ex:
                code_ = getattr(ex.response, "status_code", "?")
                print(f"push failed ({code_}){' - this phone turned alerts off; remove its code' if code_ in (404, 410) else ''}")
    print(f"sent {sent} notifications to {len(subs)} phone(s)")


if __name__ == "__main__":
    main()
