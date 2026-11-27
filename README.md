# TeleGift Glance — Telegram Gift deals on Even Realities G2

**Track 01 · Messaging (Telegram)** — Heads Up hackathon by Even Realities (Nov 23–29, 2026).

Telegram Gifts (collectible NFT gifts) trade on Telegram Market, MRKT, Portals, Tonnel and on-chain marketplaces —
about 16 000 sales a day on Telegram Market alone. Underpriced listings get bought within seconds or minutes, so a trader
has to stare at a phone all day. **TeleGift Glance puts the deal in front of your eyes instead:** the freshest listing
that sells far below the usual price of its model + backdrop appears on your G2 glasses. One tap sends it to your own
Telegram chat with an **Open gift** button, so you can buy it on your phone in two taps.

## How it works

```
TeleFeed (our data, read-only)            backend/server.py                 G2 glasses (app/)
 live listings of 7 marketplaces   ──►   GET /signals  ──────────────►   deal on the lens
 + 4.4M past sales, "×" estimate          POST /pair   ◄──  6-digit code ──  link Telegram once
                                          POST /send   ◄──  tap ──────────   send this deal
                                               │
                                               ▼
                                   Telegram bot @telefeedgifts_ai
                                   → message in YOUR chat with "🎁 Open gift"
```

- **Read** — `/signals` returns the latest listings that our existing TeleFeed engine marked as profitable
  (price ≥ ×1.75 below the top clean sale of the same model + backdrop; fake/outlier sales removed). Only public
  listing data: gift name, number, model, backdrop, price, marketplace, link.
- **Write (one tap)** — the glasses ask the backend to send the deal; our bot posts it to the Telegram chat that was
  paired with these glasses, with an inline **Open gift** button (`t.me/nft/<gift>` or the marketplace's link).
- **Pairing** — the glasses show a 6-digit code; you send it to [@telefeedgifts_ai](https://t.me/telefeedgifts_ai).
  The app then gets an opaque token. The bot token and your chat id never reach the glasses.

### On the lens

Made for a glance, not for reading. The lens stays **dark** until a deal that matches your settings arrives; then it wakes up
with the money first: the gift model **animated** large on the left (216 px, native speed, loops), and on the right
`↗ N×`, **`sell ~N ★ → you +X%`**, `N% below market`, gift name and number, price in Stars / GRAM with dollars, how many
seconds ago it was listed and on which marketplace. A very strong deal (×3+) jumps in with a **HOT DEAL** badge (but never
while you are reading the full info or touched the glasses in the last 8 s). If someone buys it first, the card gets a
**SOLD** stamp.

| Gesture | Feed (the deal) | Full info (GIFT → SALES → ON SALE) |
|---|---|---|
| swipe up | next deal | scroll forward through the pages |
| swipe down | previous deal | scroll back; above GIFT — back to the feed |
| tap | open the full info | next page; after ON SALE — back to the feed |
| double tap | **watch** this lot (the bot writes if it gets cheaper or sells) | back to the feed |
| hold | **send** the deal to your Telegram | send the deal to your Telegram |
| Menu (system) | exit | exit |

**Full info** — the gift window of the TeleFeed app rebuilt for the lens, three pages with tabs in the header:
- **GIFT** — the animated model, price, collection floor and issued / total, model and backdrop with rarity, how many
  exist and their floors, the symbol, summary `↗ N× · N% below market · N cheaper on sale`.
- **SALES** — MAXIMUM (and the top sale in Stars), number of sales and per week, this lot; then up to 40 sales of this
  model + backdrop from all marketplaces (date, price, $, marketplace, number). Sales of *this very gift* are inverted;
  sales ≥1.75× the model floor (for dark backdrops — the backdrop floor) are highlighted with `N×fl`.
- **ON SALE** — the same model + backdrop listed right now on all marketplaces, by price in dollars; this lot is a white
  row in its place, with how long each one is listed.

After hold: full-screen **✓ Sent to Telegram**. The lens goes dark after 10 min without touches and wakes on a tap or on a
matching deal.

### In Telegram (@telefeedgifts_ai)

- The deal arrives as the **gift picture** with buttons **🎁 Open gift** (buy in two taps), **📈 Price chart**, **👁 Watch**.
- **Watch** — the bot writes when the gift gets ≥3 % cheaper or is sold.
- **/settings** — what the glasses show: minimum resell profit ($2…$50), marketplaces, quiet hours, model animation
  (loop / once); **/collections** —
  only chosen collections. The glasses get only matching deals and stay dark in quiet hours.

## Run it

Ready package for the Even Hub app: [`release/telegift-glance.ehpk`](release/telegift-glance.ehpk)
(built with `cd app && npm run pack`, SDK 0.0.14, uses the public demo backend below).


Tests: `python3 -m unittest -v backend/test_server.py` (15 tests, no network).

Requirements: Node.js 22, Python 3.10+, the Even Hub simulator (`npm i -g @evenrealities/evenhub-simulator`).

```bash
# 1. backend (stdlib only, no pip install)
cd backend
BOT_TOKEN=<token from @BotFather> TELEFEED_DB=/path/to/feed.db python3 server.py   # http://127.0.0.1:8090

# 2. glasses app
cd app
npm install
npm run dev          # Vite on :5173
npm run simulate     # Even Hub simulator
```

Public demo backend (temporary Cloudflare quick tunnel, set in `app/.env.production` and the whitelist in
`app/app.json`): https://student-competent-cigarettes-answered.trycloudflare.com — `npm run build` / `npm run pack` use it.

One command for development: `./dev.sh` — backend + app + simulator, auto-updates from GitHub every 3 s.

Real glasses: `npx evenhub qr --url http://<your-ip>:5173` and scan it in the Even Hub app. To use a remote backend,
build with `VITE_API=https://<host>` and add the host to the `network` whitelist in `app/app.json`.

## Safety and privacy

- **Read-only market data.** The backend opens the database with `mode=ro` and never buys, sells or touches wallets.
- **No secrets in the repo or on the glasses.** The bot token stays in an env variable on the server; pairing tokens are
  random 128-bit values; `pairs.json` is gitignored.
- **Only safe links** — the "Open gift" button accepts `https://t.me/…` and `https://marketapp.org/…` only.
- **Rate limit** — one send per 1.5 s per paired device.
- Every message says: *Data, not financial advice.*

## What existed before the hackathon

The data source, **TeleFeed**, is our private project, built before Nov 23, 2026: collectors of new listings on
Telegram Market (MTProto), MRKT, Portals, Tonnel and on-chain marketplaces, a sales history database (4.4M Telegram
Market sales since April 2025) and the profitability estimate. It is not part of this repository.

**Built during the hackathon (Nov 27–29), everything in this repo:** the G2 app (`app/`), the backend with the
read-only signal feed, Telegram pairing and one-tap sending (`backend/server.py`), and the Telegram bot flow.

## Business

Free on the glasses for the hackathon. Later: a paid TeleFeed subscription (Telegram Stars or GRAM) unlocks the deal feed
with no delay; free users see deals a couple of minutes later.
