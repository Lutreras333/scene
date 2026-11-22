# Scene

iPhone home-screen app for new drops, grouped **by drop, by company**, with photos, prices and release times. Each brand can be switched on or off, and drop alerts come as phone notifications.

## Where products come from
- **Shop brands** (Mutimer, Ktwo Studios, Berlinc, Corteiz, Hellstar, Sp5der, Eric Emanuel, Trapstar, Cole Buxton, Represent, Madhappy, Warren Lotas, Protect LDN, Stüssy, Kith, Aimé Leon Dore, Fear of God, Amiri, Gallery Dept., Denim Tears, BAPE, Rhude, Broken Planet): the brand's own store product list, so you get the exact pieces. Stores that lock between drops show as "locked, drop coming".
- **News brands** (Supreme, Balenciaga, Saint Laurent, Chrome Hearts, Tom Ford, Arc'teryx, Rick Owens, Bottega, Prada, LV, Dior, Margiela): their sites block apps, so you get product-release stories from Hypebeast, Highsnobiety and WWD. Celebrity and outfit stories are filtered out.

Add or remove brands in `brands.json`.

## Alerts
`fetch.py` records events (new pieces, store locked, store opened, release news). `notify.py` sends them to each phone in the `PUSH_SUBS` secret, only for that phone's chosen brands.

## Files
- `fetch.py`: collects products and news into `site/data/items.json`
- `notify.py`: sends phone notifications
- `site/`: the app
- `.github/workflows/update.yml`: runs every ~15 minutes on GitHub
- `secrets/`: the private alert key. Never uploaded (see `.gitignore`).

## Run on this PC
```
python fetch.py
python -m http.server 8765 --directory site
```
