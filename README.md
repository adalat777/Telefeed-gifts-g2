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
with the money first: **`+$5.51` resell estimate · Mirage Lamp #35247 · 500 ★ ≈ $7.50 · 2s ago · Telegram`** and the
gift model drawn in grayscale. A very strong deal (×3+) jumps in with a **HOT DEAL** badge. If someone buys it first,
the card gets a **SOLD** stamp and the next deal takes its place.

| Gesture | Glance | Card (hold) | Chart (hold again) |
|---|---|---|---|
| tap | send the deal to Telegram | send to Telegram | watch it (bot alerts on price drop / sale) |
| hold | open the card | open the chart | back to glance |
| swipe | next / previous deal | next / previous deal | back |
| double tap | exit | back to glance | back to glance |

- **Card** — TeleGift app look: gift card with backdrop + pattern symbols, market plaque, `↗ N×`, price; on the right the
  resell estimate (usual price − 20 % Telegram fee vs. what you pay), floor / usual price, a live "listed Ns ago" timer.
- **Chart** — Telegram Market sales of this model + backdrop for 30 days (daily median, the deal's price dashed) and the
  median sale price on Telegram, MRKT, Portals, Tonnel, GetGems and on-chain as bars.
- After a tap: full-screen **✓ Sent to Telegram**, then the next deal.

### In Telegram (@telefeedgifts_ai)

- The deal arrives as the **gift picture** with buttons **🎁 Open gift** (buy in two taps), **📈 Price chart**, **👁 Watch**.
- **Watch** — the bot writes when the gift gets ≥3 % cheaper or is sold.
- **/settings** — what the glasses show: minimum resell profit ($2…$50), marketplaces, quiet hours; **/collections** —
  only chosen collections. The glasses get only matching deals and stay dark in quiet hours.

## Run it

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
