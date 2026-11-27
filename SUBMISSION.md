# DoraHacks submission — TeleGift Glance

**Project name:** TeleGift Glance

**Tagline (one line):** Underpriced Telegram Gifts appear on your Even G2 — one tap sends the deal to your Telegram to buy.

**Track:** 01 · Messaging (Telegram). Also applying for **Best Telegram integration**.

**Repository:** https://github.com/adalat777/Telefeed-gifts-g2

**Demo video:** <link to the video, up to 3 min>

---

## Problem

Telegram Gifts are collectible NFT gifts that people buy and resell on Telegram Market, MRKT, Portals, Tonnel and
on-chain marketplaces. Telegram Market alone has about 16 000 sales a day. The rare good deals — a gift listed far below
what the same model and backdrop usually sells for — are bought within seconds or minutes. To catch them, a trader has
to keep a phone in hand and refresh marketplaces all day.

## Who it is for

Telegram Gift flippers who want to catch good listings without staring at their phone — at work,
walking, or during a meeting.

## How it works

1. Our existing data engine (TeleFeed) watches new listings on 7 marketplaces and compares every listing with the sales
   history of the same model + backdrop (4.4M past sales, fake and outlier sales removed).
2. When a listing is at least ×1.75 cheaper than the top clean sale, it becomes a signal.
3. **Read:** the freshest signal appears on the G2 lens — the animated gift model, `↗ N×`, the resell estimate
   (`sell ~N ★ → you +X%`), how far below market, price in Stars or GRAM with dollars, marketplace and how fresh it is.
   Swipe up / down to flip deals. **Tap** opens the full info: GIFT (rarity, floors, how many exist), SALES (all sales of
   this model + backdrop from every marketplace, this gift's own sales highlighted) and ON SALE (the competition right now).
4. **Write — one gesture:** **hold** — our Telegram bot @telefeedgifts_ai_bot sends this deal to your own Telegram chat
   with the gift picture and buttons **Open gift**, **Price chart**, **Watch**. You buy in Telegram — two taps.
   **Double tap** — watch the lot: the bot writes when it gets cheaper or is sold.
5. Pairing takes one step: the glasses show a 6-digit code, you send it to the bot. No logins and no passwords on the
   glasses.

## Telegram integration

- A Telegram bot (Bot API) handles pairing by code and delivers deals as photo messages with inline buttons
  (Open gift, Price chart, Watch); `/settings` and `/collections` decide what the glasses show.
- Watch alerts: the bot writes when a watched gift gets ≥3 % cheaper or is sold.
- Buttons open the gift directly in Telegram (`t.me/nft/<gift>`) or on the marketplace.
- The data comes from Telegram itself: new Telegram Market listings are read through the official MTProto API.

## Technology

- **Glasses app:** TypeScript + Vite + Even Hub SDK 0.0.14; the screen is drawn on canvas into grayscale image tiles
  (tuned to how the G2 brightens dark tones), the gift animation (Lottie) is pre-rendered frame by frame; gestures:
  swipe, tap, double tap, hold.
- **Backend:** one Python file, standard library only — read-only signal feed, pairing, sending through the Bot API.
- **Data:** TeleFeed (our project, built before the hackathon) — SQLite with live listings and sales history.

## Safety and privacy

- Market data is read-only: the backend opens the database in read-only mode and never buys, sells or touches wallets.
- The bot token never leaves the server; the glasses get only a random pairing token.
- The Open gift button accepts only Telegram and Market App links.
- One message per 1.5 s per device; every message says "Data, not financial advice".

## What existed before Nov 23

TeleFeed — the listing collectors, the sales database and the profitability estimate. Everything in this repository
(the G2 app, the backend with pairing and one-tap sending, the bot flow) was built during the hackathon.

## Business model

Free during the hackathon. Next: a TeleFeed subscription paid in Telegram Stars or GRAM gives the deal feed with no
delay; free users see deals a couple of minutes later.

## What's next

- A short sound or vibration for a very strong deal.
- Real G2 hardware testing (the demo uses the Even Hub simulator).
