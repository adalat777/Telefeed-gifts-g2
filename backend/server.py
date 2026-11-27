"""TeleGift Glance backend — Telegram Gifts deals for Even Realities G2.

Small stdlib-only HTTP server (no dependencies):
  GET  /signals?limit=20&minutes=60[&token=]  fresh underpriced gift listings (read-only, from the TeleFeed database);
                                       with a pairing token — only deals that match the user's /settings in the bot
  POST /pair                           start pairing: returns a 6-digit code to send to the Telegram bot
  GET  /pair/<code>                    poll: {"paired": true, "token": "..."} once the code was sent to the bot
  POST /send {"token", "item"}         the bot sends this deal to the paired Telegram chat (link + "Open gift" button)
  GET  /full?c=&m=&b=&slug=&stars=&mr=&br=  the app's 'Full gift info': floors, supply, sales history, lots on sale
  GET  /model-anim?slug=<gift slug>      model animation (Fragment lottie, only the 'Gift' layer, cached on disk)
                                          &layer=pattern — only the symbols ('Pattern'), same canvas, for the backdrop
  GET  /model?c=<collection>&m=<model>  PNG of the gift model without background (cdn.changes.tg, cached on disk)
  GET  /gift?slug=<slug>             the full gift picture (backdrop + pattern symbols + model) from Fragment, cached
  GET  /detail?c=&m=&b=               last 30 days: daily median sale price (Telegram Market) + median per marketplace
  POST /watch {"token", "item"}        watch a deal: the bot writes if it gets cheaper or is sold
  GET  /health

Env:
  TELEFEED_DB   path to TeleFeed's feed.db (read-only)           default ../../data/feed.db
  BOT_TOKEN     Telegram bot token (or G2_BOT_TOKEN)             required for pairing/sending
  PORT          default 8090
Secrets never leave this process: the glasses app only gets an opaque pairing token.
"""
import hashlib
import json
import os
import random
import re
import secrets
import sqlite3
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get("TELEFEED_DB") or os.path.normpath(os.path.join(HERE, "..", "..", "data", "feed.db"))
PAIRS = os.path.join(HERE, "pairs.json")          # token -> chat_id (gitignored)
STAR_USD = 0.015                                  # what Telegram Stars cost to buy
CACHE_S = 5


def load_env_token():
    t = os.environ.get("BOT_TOKEN") or os.environ.get("G2_BOT_TOKEN")
    if t:
        return t.strip()
    env = os.path.normpath(os.path.join(HERE, "..", "..", ".env"))   # TeleFeed .env (local setup)
    try:
        for line in reversed(open(env, encoding="utf-8").read().splitlines()):
            if line.startswith("G2_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


BOT = load_env_token()


def _ssl_context():
    """System CAs + certifi (python.org Python on macOS has no system CAs by default)."""
    ctx = ssl.create_default_context()
    try:
        import certifi
        ctx.load_verify_locations(cafile=certifi.where())
    except Exception:
        pass
    return ctx


SSL = _ssl_context()
_lock = threading.Lock()
_pending = {}            # code -> {"at": ts, "token": None|str}
_pairs = {}              # token -> chat_id
_last_send = {}          # token -> ts
_cache = {}
_bot_name = None


def save_pairs():
    with open(PAIRS + ".tmp", "w") as f:
        json.dump(_pairs, f)
    os.replace(PAIRS + ".tmp", PAIRS)


SETTINGS = os.path.join(HERE, "settings.json")   # chat -> {"min": $, "markets": [...] | None, "cols": [...] | None, "quiet": [h1, h2] | None}
_settings = {}
try:
    _settings.update(json.load(open(SETTINGS)))
except (OSError, ValueError):
    pass
MIN_STEPS = [0, 2, 5, 10, 25, 50]
QUIET_STEPS = [None, [23, 8], [0, 8], [22, 9]]
ALL_MARKETS = ["telegram", "mrkt", "portals", "tonnel", "onchain"]


def save_settings():
    with open(SETTINGS + ".tmp", "w") as f:
        json.dump(_settings, f)
    os.replace(SETTINGS + ".tmp", SETTINGS)


def settings_of(chat):
    st = {"min": 0, "markets": None, "cols": None, "quiet": None, "anim": "loop"}
    st.update(_settings.get(str(chat)) or {})
    return st


def is_quiet(st, now=None):
    q = st.get("quiet")
    if not q:
        return False
    h = time.localtime(now or time.time()).tm_hour
    a, b = q
    return a <= h < b if a < b else (h >= a or h < b)


def matches(st, it):
    if st.get("markets") and (it.get("market") or "telegram") not in st["markets"]:
        return False
    if st.get("cols") and (it.get("title") or "").lower() not in [c.lower() for c in st["cols"]]:
        return False
    if st.get("min"):
        rs = it.get("resell") or {}
        if (rs.get("profit_usd") or 0) < st["min"]:
            return False
    return True


def settings_text(st):
    mk = "all" if not st.get("markets") else ", ".join(MARKET.get(m, m) for m in st["markets"])
    cols = "all" if not st.get("cols") else ", ".join(st["cols"])
    q = "off" if not st.get("quiet") else f"{st['quiet'][0]:02d}:00–{st['quiet'][1]:02d}:00"
    return ("⚙️ What your glasses show\n\n"
            f"• Minimum resell profit: {'any' if not st.get('min') else '$' + str(st['min'])}\n"
            f"• Marketplaces: {mk}\n"
            f"• Collections: {cols}\n"
            f"• Quiet hours (no pop-ups): {q}\n"
            f"• Gift animation: {'plays once' if st.get('anim') == 'once' else 'loops'}\n\n"
            "Collections: send /collections Plush Pepe, Mirage Lamp  (or /collections all)")


def settings_keyboard(st):
    rows = [[{"text": ("✓ " if (st.get("min") or 0) == v else "") + ("any $" if not v else f"${v}+"), "callback_data": f"set:min:{v}"}
             for v in MIN_STEPS]]
    mrow = []
    for m in ALL_MARKETS:
        on = not st.get("markets") or m in st["markets"]
        mrow.append({"text": ("✓ " if on else "· ") + MARKET.get(m, m).split(" ")[0], "callback_data": f"set:mk:{m}"})
    rows.append(mrow[:3]); rows.append(mrow[3:])
    qn = str(st.get("quiet"))
    rows.append([{"text": ("✓ " if str(q) == qn else "") + ("no quiet hours" if not q else f"quiet {q[0]}–{q[1]}"),
                  "callback_data": "set:quiet:" + ("off" if not q else f"{q[0]}-{q[1]}")} for q in QUIET_STEPS])
    once = st.get("anim") == "once"
    rows.append([{"text": ("· " if once else "✓ ") + "animation: loop", "callback_data": "set:anim:loop"},
                 {"text": ("✓ " if once else "· ") + "animation: once", "callback_data": "set:anim:once"}])
    return {"inline_keyboard": rows}


def change_setting(chat, what, value):
    st = settings_of(chat)
    if what == "min":
        st["min"] = int(value)
    elif what == "mk":
        cur = list(st.get("markets") or ALL_MARKETS)
        cur = [m for m in cur if m != value] if value in cur else cur + [value]
        st["markets"] = None if set(cur) >= set(ALL_MARKETS) or not cur else [m for m in ALL_MARKETS if m in cur]
    elif what == "quiet":
        st["quiet"] = None if value == "off" else [int(x) for x in value.split("-")]
    elif what == "cols":
        st["cols"] = value or None
    elif what == "anim":
        st["anim"] = "once" if value == "once" else "loop"
    with _lock:
        _settings[str(chat)] = st
        save_settings()
    return st


WATCHES = os.path.join(HERE, "watches.json")     # chat -> {gift id: {"stars", "ton", "title", "num", "at"}} (gitignored)
_watches = {}
_items = {}                                       # gift id -> last deal we sent (for the bot buttons)

try:
    _watches.update(json.load(open(WATCHES)))
except (OSError, ValueError):
    pass


def save_watches():
    with open(WATCHES + ".tmp", "w") as f:
        json.dump(_watches, f)
    os.replace(WATCHES + ".tmp", WATCHES)


try:
    _pairs.update(json.load(open(PAIRS)))
except (OSError, ValueError):
    pass


# ---------- Telegram Bot API ----------
def tg(method, params=None, timeout=35):
    data = urllib.parse.urlencode({k: (json.dumps(v) if isinstance(v, (dict, list)) else v)
                                   for k, v in (params or {}).items()}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{BOT}/{method}", data=data)
    with urllib.request.urlopen(req, timeout=timeout, context=SSL) as r:
        return json.loads(r.read().decode())


def bot_name():
    global _bot_name
    if _bot_name is None and BOT:
        try:
            _bot_name = tg("getMe", timeout=10)["result"]["username"]
        except Exception:
            _bot_name = ""
    return _bot_name or ""


def bot_loop():
    offset = 0
    while True:
        try:
            res = tg("getUpdates", {"offset": offset, "timeout": 30, "allowed_updates": ["message", "callback_query"]}, timeout=40)
            for u in res.get("result", []):
                offset = u["update_id"] + 1
                if u.get("callback_query"):
                    on_button(u["callback_query"])
                    continue
                m = u.get("message") or {}
                chat = (m.get("chat") or {}).get("id")
                text = (m.get("text") or "").strip()
                if not chat or not text:
                    continue
                if text.startswith("/settings"):
                    st = settings_of(chat)
                    tg("sendMessage", {"chat_id": chat, "text": settings_text(st), "reply_markup": settings_keyboard(st)}, 15)
                    continue
                if text.startswith("/collections"):
                    arg = text[len("/collections"):].strip()
                    cols = [] if not arg or arg.lower() == "all" else [c.strip() for c in arg.split(",") if c.strip()][:20]
                    st = change_setting(chat, "cols", cols)
                    tg("sendMessage", {"chat_id": chat, "text": settings_text(st), "reply_markup": settings_keyboard(st)}, 15)
                    continue
                code = re.sub(r"\D", "", text.replace("/start", ""))
                with _lock:
                    p = _pending.get(code) if len(code) == 6 else None
                    if p and time.time() - p["at"] < 600 and not p["token"]:
                        tok = secrets.token_hex(16)
                        p["token"] = tok
                        _pairs[tok] = chat
                        save_pairs()
                        ok = True
                    else:
                        ok = False
                if ok:
                    tg("sendMessage", {"chat_id": chat, "text": "✅ Paired with your G2 glasses.\nTap a deal on the glasses — it lands here with a link to buy.\n\n"
                                                             "Choose what the glasses show: /settings"}, 15)
                else:
                    tg("sendMessage", {"chat_id": chat, "text": "👓 TeleGift Glance\nOpen the app on your Even G2 and send me the 6-digit code it shows."}, 15)
        except Exception:
            time.sleep(3)


# ---------- model pictures (no background) ----------
MODEL_CDN = "https://cdn.changes.tg/gifts/models/{c}/png/{m}.png"
TELEFEED_IMG = os.path.normpath(os.path.join(HERE, "..", "..", "data", "models", "web"))   # TeleFeed's own cache
IMG_CACHE = os.path.join(HERE, "cache")
_img_lock = threading.Lock()


def model_png(col, model):
    q = urllib.parse.quote
    url = MODEL_CDN.format(c=q(col, safe=""), m=q(model, safe=""))
    key = hashlib.sha1(url.encode()).hexdigest()
    for folder in (TELEFEED_IMG, IMG_CACHE):
        path = os.path.join(folder, key + ".png")
        if os.path.exists(path):
            return open(path, "rb").read()
    miss = os.path.join(IMG_CACHE, key + ".none")
    if os.path.exists(miss) and time.time() - os.path.getmtime(miss) < 86400:
        return None
    with _img_lock:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "TeleGiftGlance/1.0"})
            with urllib.request.urlopen(req, timeout=15, context=SSL) as r:
                data = r.read(4_000_000)
        except urllib.error.HTTPError as e:
            data = None if e.code == 404 else b""
        except Exception:
            data = b""
        os.makedirs(IMG_CACHE, exist_ok=True)
        if data and data[:8] == b"\x89PNG\r\n\x1a\n":
            with open(os.path.join(IMG_CACHE, key + ".png"), "wb") as f:
                f.write(data)
            return data
        if data is None:
            open(miss, "w").close()
        return None


FRAGMENT_GIFT = "https://nft.fragment.com/gift/{}.webp"
FRAGMENT_LOTTIE = "https://nft.fragment.com/gift/{}.lottie.json"
_anim_lock = threading.Lock()


def model_anim(slug, layer="gift"):
    """The gift's animation from Fragment with only one layer — "Gift" (the model) or "Pattern" (the symbols around it,
    on the same 512×512 canvas, so they sit exactly as on the official card) — JSON bytes, cached on disk; None if absent."""
    if not re.fullmatch(r"[A-Za-z0-9]+-\d{1,9}", slug or "") or layer not in ("gift", "pattern"):
        return None
    path = os.path.join(IMG_CACHE, ("anim_" if layer == "gift" else "pat3_") + slug.lower() + ".json")
    miss = path[:-5] + ".none"
    if os.path.exists(path):
        return open(path, "rb").read()
    if os.path.exists(miss) and time.time() - os.path.getmtime(miss) < 7 * 86400:
        return None
    with _anim_lock:
        try:
            req = urllib.request.Request(FRAGMENT_LOTTIE.format(slug.lower()),
                                         headers={"User-Agent": "TeleGiftGlance/1.0", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=15, context=SSL) as r:
                raw = r.read(8_000_000)
        except urllib.error.HTTPError as e:
            raw = None if e.code in (403, 404, 410) else b""
        except Exception:
            raw = b""
        os.makedirs(IMG_CACHE, exist_ok=True)
        if raw is None:
            open(miss, "w").close()
            return None
        if not raw:
            return None
        try:
            d = json.loads(raw)
            keep = [x for x in d.get("layers") or [] if (x.get("nm") or "").strip().lower() == layer]
        except (ValueError, AttributeError):
            keep = []
        if not keep:
            open(miss, "w").close()
            return None
        for x in keep:            # the 'Pattern' layer is a matte for 'Color Icon' and is not drawn itself — draw it
            x.pop("td", None)
        if layer == "pattern":    # half as many symbols (owner 27.11): every other one, from both rings
            for a in d.get("assets") or []:
                if a.get("id") in {x.get("refId") for x in keep} and isinstance(a.get("layers"), list):
                    a["layers"] = a["layers"][::2]
        d["layers"] = keep
        data = json.dumps(d, separators=(",", ":")).encode()
        with open(path, "wb") as f:
            f.write(data)
        return data
TELEFEED_GIFTS = os.path.normpath(os.path.join(HERE, "..", "..", "data", "gifts"))      # TeleFeed's own cache
IMG_MAGIC = (b"\x89PNG", b"\xff\xd8\xff", b"RIFF", b"GIF8")


def gift_picture(slug):
    if not re.fullmatch(r"[A-Za-z0-9]+-\d{1,9}", slug or ""):
        return None
    own = os.path.join(TELEFEED_GIFTS, slug + ".img")
    if os.path.exists(own):
        data = open(own, "rb").read()
        if data.startswith(IMG_MAGIC):
            return data
    path = os.path.join(IMG_CACHE, "gift_" + slug.lower() + ".img")
    if os.path.exists(path):
        return open(path, "rb").read()
    miss = path + ".none"
    if os.path.exists(miss) and time.time() - os.path.getmtime(miss) < 21600:
        return None
    with _img_lock:
        try:
            req = urllib.request.Request(FRAGMENT_GIFT.format(slug.lower()), headers={"User-Agent": "TeleGiftGlance/1.0"})
            with urllib.request.urlopen(req, timeout=15, context=SSL) as r:
                data = r.read(4_000_000)
        except urllib.error.HTTPError as e:
            data = None if e.code == 404 else b""
        except Exception:
            data = b""
        os.makedirs(IMG_CACHE, exist_ok=True)
        if data and data.startswith(IMG_MAGIC):
            with open(path, "wb") as f:
                f.write(data)
            return data
        if data is None:
            open(miss, "w").close()
        return None


def image_type(data):
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"GIF8"):
        return "image/gif"
    return "image/webp"


def add_watch(chat, it):
    gid = str(it.get("id") or "")
    if not gid:
        return False
    with _lock:
        _watches.setdefault(str(chat), {})[gid] = {"stars": it.get("price") if it.get("cur") == "STARS" else None,
                                                   "ton": it.get("price") if it.get("cur") == "GRAM" else None,
                                                   "title": it.get("title"), "num": it.get("num"), "url": it.get("url"),
                                                   "at": time.time()}
        save_watches()
    return True


def on_button(cb):
    chat = ((cb.get("message") or {}).get("chat") or {}).get("id")
    kind, _, gid = (cb.get("data") or "").partition(":")
    if kind == "set" and chat:
        what, _, value = gid.partition(":")
        try:
            st = change_setting(chat, what, value)
            m = cb.get("message") or {}
            tg("editMessageText", {"chat_id": chat, "message_id": m.get("message_id"), "text": settings_text(st),
                                   "reply_markup": settings_keyboard(st)}, 15)
            tg("answerCallbackQuery", {"callback_query_id": cb["id"], "text": "Saved"}, 15)
        except Exception:
            pass
        return
    it = _items.get(gid)
    note = ""
    try:
        if not chat or not it:
            note = "This deal is no longer in memory — tap it on the glasses again."
        elif kind == "chart":
            det = detail(it.get("title"), it.get("model"), it.get("backdrop"))
            tg("sendMessage", {"chat_id": chat, "text": chart_text(it, det)}, 15)
        elif kind == "watch":
            add_watch(chat, it)
            note = "👁 Watching — I'll write if it gets cheaper or is sold."
        tg("answerCallbackQuery", {"callback_query_id": cb["id"], "text": note[:190]}, 15)
    except Exception:
        pass


def watch_loop():
    """Every minute: watched deals that were sold or got at least 3 % cheaper → a message to the chat that watches them."""
    while True:
        time.sleep(60)
        check_watches()


def check_watches():
    if True:
        try:
            with _lock:
                todo = [(chat, gid, dict(w)) for chat, ws in _watches.items() for gid, w in ws.items()]
            if not todo:
                return
            db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
            try:
                rows = {k: (st, data) for k, st, data in db.execute(
                    f"SELECT key, status, data FROM profitable WHERE key IN ({','.join('?' * len(todo))})", [g for _, g, _ in todo])}
            finally:
                db.close()
            for chat, gid, w in todo:
                st, data = rows.get(gid, (None, None))
                name = f"{w.get('title')} #{w.get('num')}"
                msg = None
                if st in ("sold", "gone", "off"):
                    msg = f"⚡ {name} is no longer on sale — someone bought it or it was taken off."
                    drop = True
                else:
                    drop = False
                    try:
                        d = json.loads(data) if data else {}
                    except ValueError:
                        d = {}
                    now_st, now_ton = d.get("stars"), d.get("ton")
                    if w.get("stars") and now_st and now_st <= w["stars"] * 0.97:
                        msg = f"📉 {name} got cheaper: {w['stars']} ⭐ → {now_st} ⭐"
                    elif w.get("ton") and now_ton and now_ton <= w["ton"] * 0.97:
                        msg = f"📉 {name} got cheaper: {round(w['ton'], 2)} GRAM → {round(now_ton, 2)} GRAM"
                if not msg:
                    continue
                params = {"chat_id": chat, "text": msg + "\n\nData, not financial advice."}
                if not drop and w.get("url") and SAFE_URL.match(w["url"]):
                    params["reply_markup"] = {"inline_keyboard": [[{"text": "🎁 Open gift", "url": w["url"]}]]}
                tg("sendMessage", params, 15)
                with _lock:
                    ws = _watches.get(chat, {})
                    if drop:
                        ws.pop(gid, None)
                    elif gid in ws:                       # next alert only after a further drop
                        if w.get("stars"):
                            ws[gid]["stars"] = now_st
                        if w.get("ton"):
                            ws[gid]["ton"] = now_ton
                    save_watches()
        except Exception:
            pass


# ---------- signals (read-only) ----------
def signals(limit=20, minutes=60):
    key = (limit, minutes)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_S:
        return hit[1]
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    try:
        r = db.execute("SELECT usd FROM ton_usd ORDER BY day DESC LIMIT 1").fetchone()
        usd_rate = float(r[0]) if r else None
        since = time.time() - minutes * 60
        rows = db.execute("SELECT data, best_upside, last_at, status FROM profitable WHERE status='sale' AND last_at >= ? "
                          "ORDER BY last_at DESC LIMIT ?", (since, limit)).fetchall()
        # deals that were sold / taken off in the last 10 minutes — so the glasses can stamp them SOLD
        gone = [r[0] for r in db.execute(
            "SELECT key FROM profitable WHERE status IN ('sold','gone','off') AND status_at >= ? AND last_at >= ? LIMIT 200",
            (time.time() - 600, since)).fetchall()]
    finally:
        db.close()
    items = []
    for raw, best, last, status in rows:
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        h = d.get("history") or {}
        res = h.get("resale") or {}
        ton_first = d.get("ton_only") or d.get("market") not in (None, "telegram")
        if ton_first and d.get("ton") is not None:
            price, cur, usd = round(d["ton"], 2), "GRAM", (d["ton"] * usd_rate if usd_rate else None)
        else:
            price, cur, usd = d.get("stars"), "STARS", (d["stars"] * STAR_USD if d.get("stars") else None)
        floor = res.get("floor")
        stars_now = d.get("stars")
        cheapest = bool(floor and stars_now and floor >= stars_now)   # every other same lot costs more
        if cheapest:
            floor = None
        items.append({
            "id": d.get("slug") or str(d.get("id")), "title": d.get("title"), "num": d.get("num"),
            "model": d.get("model"), "backdrop": d.get("backdrop"), "pattern": d.get("pattern"),
            "price": price, "cur": cur, "usd": round(usd, 2) if usd else None,
            "x": round(h.get("upside") or best or 0, 2), "floor": floor, "cheapest": cheapest, "typical": h.get("typical"),
            "max": h.get("max_stars"), "sales": h.get("sales"),
            # where the top sale (the "×" is measured to) happened: Telegram Market unless the estimate says on-chain
            "max_mk": h.get("max_venue") or ("On-chain" if h.get("max_market") == "onchain" else "Telegram"), "market": d.get("market") or "telegram",
            "url": d.get("url") or (f"https://t.me/nft/{d['slug']}" if d.get("slug") else None),
            "seen_s": int(time.time() - last),
            "resell": resell(d, h, res, usd_rate),
            # for the glance: the usual price (median of recent sales of this model + backdrop), price in Stars,
            # and how often resales of such gifts end in profit after the fee
            "fair": res.get("fair") or h.get("typical"), "stars": stars_now,
            "rs_pct": (d.get("rstat") or {}).get("kw") or (d.get("rstat") or {}).get("cw"),
            "rs_good": bool((d.get("rstat") or {}).get("good")),
            "mr": d.get("model_rarity"), "br": d.get("backdrop_rarity"), "pr": d.get("pattern_rarity"),
        })
    out = {"now": int(time.time()), "items": items, "gone": gone}
    _cache[key] = (time.time(), out)
    return out


STAR_OUT_USD = 0.013        # what a Star is worth when you withdraw
SELL_FEE = 0.2              # Telegram Market fee when you sell for Stars


def resell(d, h, res, usd_rate):
    """Estimate: resell in Telegram for Stars at the usual price → what you get after the fee, and the profit in $."""
    sell = res.get("sell") or (h.get("typical") and round(h["typical"] * 0.98))
    if not sell:
        return None
    net = res.get("net") or round(sell * (1 - SELL_FEE))
    costs = []
    if d.get("stars") and not d.get("ton_only") and d.get("market") in (None, "telegram"):
        costs.append(d["stars"] * STAR_USD)
    if d.get("ton") and usd_rate:
        costs.append(d["ton"] * usd_rate)
    if not costs:
        return None
    cost, get = min(costs), net * STAR_OUT_USD
    return {"sell": int(sell), "net": int(net), "cost_usd": round(cost, 2), "get_usd": round(get, 2),
            "profit_usd": round(get - cost, 2)}


VENUES = [("telegram", "Telegram"), ("mrkt", "MRKT"), ("portals", "Portals"), ("tonnel", "Tonnel"),
          ("getgems", "GetGems"), ("onchain", "On-chain")]
_detail_cache = {}


def _median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else None


def _iso_ts(t):
    try:
        return int(time.mktime(time.strptime(t[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone)
    except (TypeError, ValueError):
        return 0


def _num_of(slug):
    m = re.search(r"-(\d+)$", slug or "")
    return int(m.group(1)) if m else None


_hist_cache = {}


def sales_history(col, model, backdrop, slug="", n=7):
    """Read-only: the last sales of this model + backdrop on every marketplace we collect, newest first,
    plus a one-line summary (usual price, top sale, sales this week) — the glasses' "sales history" screen."""
    key = (col, model, backdrop, slug, n)
    hit = _hist_cache.get(key)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    since = time.time() - 3 * 365 * 86400   # all the history we have (Telegram Market since 04.2025)
    since_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(since))
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    rows = []          # (ts, market, cur, price, ton, slug, num, pattern)
    try:
        r = db.execute("SELECT usd FROM ton_usd ORDER BY day DESC LIMIT 1").fetchone()
        rate = float(r[0]) if r else None
        for t, cur, price, norm, sl, sym in db.execute(
                "SELECT sold_at, currency, price, normalized, slug, symbol FROM sales INDEXED BY sales_combo "
                "WHERE collection=? AND model=? AND backdrop=? AND sold_at >= ? ORDER BY sold_at DESC LIMIT 1000",
                (col, model, backdrop, since_iso)):
            if cur == "STARS" and price:
                rows.append((_iso_ts(t), "telegram", "STARS", price, norm, sl, _num_of(sl), sym))
            elif norm:
                rows.append((_iso_ts(t), "telegram", "GRAM", norm, norm, sl, _num_of(sl), sym))
        for m in ("mrkt", "portals", "tonnel", "getgems"):
            try:
                for t, ton, sl, sym in db.execute(
                        "SELECT sold_at, ton, slug, symbol FROM msales INDEXED BY msales_combo WHERE market=? AND collection=? "
                        "AND model=? AND backdrop=? AND sold_at >= ? ORDER BY sold_at DESC LIMIT 100", (m, col, model, backdrop, since_iso)):
                    if ton:
                        rows.append((_iso_ts(t), m, "GRAM", ton, ton, sl, _num_of(sl), sym))
            except sqlite3.Error:
                pass
        try:
            for t, ton, sl, num, sym in db.execute(
                    "SELECT sold_at, ton, slug, num, pattern FROM portals_sales WHERE title=? AND model=? AND backdrop=? AND sold_at >= ? "
                    "ORDER BY sold_at DESC LIMIT 100", (col, model, backdrop, since)):
                if ton:
                    rows.append((int(t), "portals", "GRAM", ton, ton, sl, num, sym))
        except sqlite3.Error:
            pass
        try:
            for t, ton, num in db.execute(
                    "SELECT ts, ton, num FROM onchain_sales WHERE collection=? AND model=? AND backdrop=? AND ts >= ? AND src != dst "
                    "AND market NOT IN ('Telegram', 'Getgems') ORDER BY ts DESC LIMIT 100", (col, model, backdrop, int(since))):
                if ton:
                    rows.append((int(t), "onchain", "GRAM", ton, ton, None, num, None))
        except sqlite3.Error:
            pass
    finally:
        db.close()
    # the same sale seen by two sources (Portals API and Gift Satellite): same gift, ±10 min → once
    rows.sort(key=lambda x: -x[0])
    uniq = []
    for x in rows:
        if any(u[6] and u[6] == x[6] and abs(u[0] - x[0]) < 600 for u in uniq[-6:]):
            continue
        uniq.append(x)
    usd_of = lambda cur, price, ton: (price * STAR_OUT_USD if cur == "STARS" else (ton * rate if rate else None))
    tons = _clean([x[4] for x in uniq if x[4]])
    ok = set(tons)
    week = sum(1 for x in uniq if x[0] >= time.time() - 7 * 86400)
    month = [x for x in uniq if x[0] >= time.time() - 30 * 86400 and x[4] in ok]
    usual = _median([usd_of(x[2], x[3], x[4]) for x in month if usd_of(x[2], x[3], x[4])])
    top = max((x for x in uniq if x[4] in ok), key=lambda x: x[4], default=None)
    own = _num_of(slug)
    items = [{"at": x[0], "market": x[1], "cur": x[2], "price": round(x[3], 2) if x[2] == "GRAM" else int(x[3]),
              "usd": round(usd_of(x[2], x[3], x[4]), 2) if usd_of(x[2], x[3], x[4]) else None, "num": x[6],
              "mine": bool(own and x[6] == own), "pattern": x[7]} for x in uniq[:n]]
    out = {"items": items, "week": week, "total": len(uniq), "usual_usd": round(usual, 2) if usual else None,
           "top": ({"usd": round(usd_of(top[2], top[3], top[4]), 2) if usd_of(top[2], top[3], top[4]) else None,
                    "cur": top[2], "price": round(top[3], 2) if top[2] == "GRAM" else int(top[3]), "at": top[0]} if top else None),
           "top_stars": _top_stars(uniq, ok)}
    _hist_cache[key] = (time.time(), out)
    if len(_hist_cache) > 200:
        _hist_cache.pop(next(iter(_hist_cache)))
    return out


def _top_stars(rows, ok):
    """The top sale for Stars (when the overall top was in GRAM), like the app's "Maximum" tile."""
    xs = [x for x in rows if x[2] == "STARS" and x[4] in ok]
    if not xs:
        return None
    t = max(xs, key=lambda x: x[3])
    return {"price": int(t[3]), "usd": round(t[3] * STAR_OUT_USD, 2), "at": t[0]}


TELEFEED_API = os.environ.get("TELEFEED_API", "http://127.0.0.1:8080")
_full_cache = {}


def _tf(path, timeout=9):
    """Read-only call to the TeleFeed app running next to us (floors, lots on sale, supply)."""
    try:
        with urllib.request.urlopen(TELEFEED_API + path, timeout=timeout) as r:
            return json.loads(r.read(2_000_000))
    except Exception:
        return None


def _pct(x):
    try:
        return float(str(x).rstrip("%")) / 100
    except (TypeError, ValueError):
        return None


def full_info(slug, col, model, backdrop, stars=None, pattern="", mr=None, br=None):
    """The app's "Full gift info" for the glasses: floors (collection / model) across marketplaces, supply,
    the sales history of this model + backdrop, and the same gifts on sale now on every marketplace."""
    key = (slug, col, model, backdrop, stars)
    hit = _full_cache.get(key)
    if hit and time.time() - hit[0] < 30:
        return hit[1]
    q = urllib.parse.urlencode({"title": col, "model": model, "backdrop": backdrop, "slug": slug, "stars": stars or ""})
    res = {}
    jobs = {"floor": f"/api/floor?{q}", "similar": f"/api/similar?{q}",
            "counts": "/api/gift-counts?" + urllib.parse.urlencode({"title": col})}
    threads = [threading.Thread(target=lambda k=k, u=u: res.__setitem__(k, _tf(u))) for k, u in jobs.items()]
    for t in threads:
        t.start()
    hist = sales_history(col, model, backdrop, slug, n=40)
    for t in threads:
        t.join(10)
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    try:
        r = db.execute("SELECT usd FROM ton_usd ORDER BY day DESC LIMIT 1").fetchone()
        rate = float(r[0]) if r else None
    finally:
        db.close()
    usd = lambda cur, price: (round(price * STAR_USD, 2) if cur == "STARS" else (round(price * rate, 2) if rate else None))

    def fl(x):
        # the floor and its $ value — as in the app: Stars × 0.013, GRAM × today's rate
        if not x:
            return None
        if x.get("ton_only") or x.get("market") not in (None, "telegram") or not x.get("stars"):
            ton = round(x.get("ton") or 0, 2)
            return {"market": x.get("market") or "telegram", "cur": "GRAM", "price": ton, "usd": round(ton * rate, 2) if rate else None}
        return {"market": "telegram", "cur": "STARS", "price": int(x["stars"]), "usd": round(x["stars"] * STAR_OUT_USD, 2)}

    f = res.get("floor") or {}
    sim = res.get("similar") or {}
    lots = []
    for it in ((sim.get("same") or {}).get("items") or []):
        if it.get("ton_only") or not it.get("stars"):
            lots.append({"market": "telegram", "num": it.get("num"), "pattern": it.get("pattern"), "cur": "GRAM",
                         "price": round(it.get("ton") or 0, 2)})
        else:
            lots.append({"market": "telegram", "num": it.get("num"), "pattern": it.get("pattern"), "cur": "STARS",
                         "price": int(it["stars"])})
    for it in sim.get("markets") or []:
        if it.get("ton"):
            lots.append({"market": it.get("market"), "num": it.get("num"), "pattern": it.get("pattern"), "cur": "GRAM",
                         "price": round(it["ton"], 2), "listed_at": it.get("listed_at")})
    for it in ((sim.get("onchain") or {}).get("items") or []):
        ton = it.get("ton") or it.get("price")
        if ton and (it.get("currency") in (None, "GRAM", "TON")):
            lots.append({"market": "onchain", "num": it.get("num"), "pattern": it.get("pattern"), "cur": "GRAM",
                         "price": round(float(ton), 2), "listed_at": it.get("listed_at")})
    own = _num_of(slug)
    seen, uniq = set(), []
    for x in lots:
        x["usd"] = usd(x["cur"], x["price"])
        if not x["usd"] or (own and x.get("num") == own):
            continue
        k = (x.get("num"), x["market"])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(x)
    uniq.sort(key=lambda x: x["usd"])
    cnt = res.get("counts") or {}
    issued = cnt.get("issued")
    pm, pb = _pct(mr), _pct(br)
    out = {
        "floor_col": fl(f.get("collection")), "floor_model": fl(f.get("model")),
        "floor_backdrop": fl(f.get("backdrop")),     # only for dark backdrops (Black, Onyx Black, Midnight Blue, Gunmetal)
        "issued": issued, "supply": cnt.get("supply"),
        "n_model": int(issued * pm) if issued and pm else None,
        "n_combo": int(issued * pm * pb) if issued and pm and pb else None,
        "history": hist, "on_sale": uniq[:20], "on_sale_wait": not sim,
    }
    _full_cache[key] = (time.time(), out)
    if len(_full_cache) > 100:
        _full_cache.pop(next(iter(_full_cache)))
    return out


def _clean(xs):
    """Drop sales 10× above the lower median (fake / outlier deals), as TeleFeed does."""
    xs = [x for x in xs if x and x > 0]
    if len(xs) < 3:
        return xs
    lo = sorted(xs)[(len(xs) - 1) // 2]
    return [x for x in xs if x <= lo * 10]


def detail(col, model, backdrop, days=30):
    """Read-only from the TeleFeed database: price chart (Telegram Market, daily median in $) and median price per venue."""
    key = (col, model, backdrop, days)
    hit = _detail_cache.get(key)
    if hit and time.time() - hit[0] < 120:
        return hit[1]
    since_ts = time.time() - days * 86400
    since = time.strftime("%Y-%m-%d", time.gmtime(since_ts))
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    try:
        r = db.execute("SELECT usd FROM ton_usd ORDER BY day DESC LIMIT 1").fetchone()
        rate = float(r[0]) if r else None
        tg = db.execute("SELECT substr(sold_at,1,10), normalized FROM sales INDEXED BY sales_combo "
                        "WHERE collection=? AND model=? AND backdrop=? AND sold_at >= ?", (col, model, backdrop, since)).fetchall()
        per = {"telegram": [t for _, t in tg]}
        for m in ("mrkt", "portals", "tonnel", "getgems"):
            try:
                per[m] = [t for (t,) in db.execute(
                    "SELECT ton FROM msales INDEXED BY msales_combo WHERE market=? AND collection=? AND model=? AND backdrop=? "
                    "AND sold_at >= ?", (m, col, model, backdrop, since))]
            except sqlite3.Error:
                per[m] = []
        try:
            per["portals"] += [t for (t,) in db.execute(
                "SELECT ton FROM portals_sales WHERE title=? AND model=? AND backdrop=? AND sold_at >= ?",
                (col, model, backdrop, since_ts))]
        except sqlite3.Error:
            pass
        try:
            per["onchain"] = [t for (t,) in db.execute(
                "SELECT ton FROM onchain_sales WHERE collection=? AND model=? AND backdrop=? AND ts >= ? AND src != dst "
                "AND market NOT IN ('Telegram', 'Getgems')", (col, model, backdrop, int(since_ts)))]
        except sqlite3.Error:
            per["onchain"] = []
    finally:
        db.close()
    usd = (lambda ton: round(ton * rate, 2)) if rate else (lambda ton: None)
    ok_tg = set(_clean([t for _, t in tg]))           # outliers judged over the whole month, not one day
    days_map = {}
    for day, t in tg:
        if t in ok_tg:
            days_map.setdefault(day, []).append(t)
    chart = []
    for i in range(days):
        day = time.strftime("%Y-%m-%d", time.gmtime(since_ts + (i + 1) * 86400))
        xs = days_map.get(day, [])
        m = _median(xs)
        chart.append({"day": day, "usd": usd(m) if m else None, "n": len(xs)})
    venues = []
    for k, name in VENUES:
        xs = _clean(per.get(k) or [])
        m = _median(xs)
        venues.append({"market": k, "name": name, "n": len(xs), "usd": usd(m) if m else None})
    out = {"chart": chart, "venues": venues, "days": days}
    _detail_cache[key] = (time.time(), out)
    return out


SPARK = "▁▂▃▄▅▆▇█"


def chart_text(it, det):
    pts = [c["usd"] for c in det["chart"] if c["usd"]]
    lines = [f"📈 {it.get('title')} · {it.get('model')} · {it.get('backdrop')} — last {det['days']} days"]
    if pts:
        lo, hi = min(pts), max(pts)
        line = "".join(SPARK[0] if c["usd"] is None else SPARK[int((c["usd"] - lo) / ((hi - lo) or 1) * 7)] for c in det["chart"])
        lines += [line, f"low ${lo} · high ${hi} · {sum(c['n'] for c in det['chart'])} sales on Telegram Market"]
    else:
        lines.append("No Telegram Market sales of this model + backdrop in the last 30 days.")
    vs = [v for v in det["venues"] if v["usd"]]
    if vs:
        lines += ["", "Median sale price by marketplace:"]
        lines += [f"• {v['name']}: ${v['usd']} ({v['n']} sales)" for v in vs]
    lines += ["", "Data, not financial advice."]
    return "\n".join(lines)


MARKET = {"telegram": "Telegram Market", "onchain": "on-chain (Market App)", "mrkt": "MRKT", "portals": "Portals",
          "tonnel": "Tonnel", "getgems": "GetGems"}
SAFE_URL = re.compile(r"^https://(t\.me|marketapp\.org)/")


def deal_text(it):
    price = f"{it.get('price')} {'⭐' if it.get('cur') == 'STARS' else 'GRAM'}"
    usd = f" (≈${it['usd']})" if it.get("usd") else ""
    lines = [f"🎁 {it.get('title')} #{it.get('num')}",
             f"{it.get('model')} · {it.get('backdrop')}" + (f" · {it['pattern']}" if it.get("pattern") else ""),
             f"💰 {price}{usd} on {MARKET.get(it.get('market'), it.get('market'))}",
             f"📈 ×{it.get('x')} vs. the top sale of this model + backdrop" + (f" · floor {it['floor']} ⭐" if it.get("floor") else (" · cheapest on sale" if it.get("cheapest") else "")),
             ]
    rs = it.get("resell") or {}
    if rs.get("profit_usd") and rs["profit_usd"] > 0.5:
        lines.append(f"💵 Resell estimate: sell ~{rs['sell']} ⭐ → you get ~${rs['get_usd']} (−20%) · +${rs['profit_usd']}")
    lines += ["", "Sent from your Even G2 · TeleGift Glance. Data, not financial advice."]
    return "\n".join(lines)


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = (obj if isinstance(obj, (bytes, str)) else json.dumps(obj, ensure_ascii=False))
        b = b.encode() if isinstance(b, str) else b
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/health":
            return self._send(200, {"ok": True, "bot": bool(BOT)})
        if u.path == "/signals":
            q = urllib.parse.parse_qs(u.query)
            try:
                limit = max(1, min(50, int(q.get("limit", ["20"])[0])))
                minutes = max(1, min(1440, int(q.get("minutes", ["60"])[0])))
                out = signals(50, minutes)
                chat = _pairs.get((q.get("token") or [""])[0])
                st = settings_of(chat) if chat else None
                items = [i for i in out["items"] if not st or matches(st, i)][:limit]
                return self._send(200, dict(out, items=items, quiet=bool(st and is_quiet(st)),
                                            anim=(st or {}).get("anim") or "loop",
                                            filtered=bool(st and (st.get("min") or st.get("markets") or st.get("cols")))))
            except (ValueError, sqlite3.Error) as e:
                return self._send(503, {"error": type(e).__name__})
        if u.path == "/detail":
            q = urllib.parse.parse_qs(u.query)
            c, m, b = ((q.get(k) or [""])[0][:64] for k in ("c", "m", "b"))
            if not (c and m and b):
                return self._send(400, {"error": "need c, m, b"})
            try:
                return self._send(200, detail(c, m, b))
            except sqlite3.Error as e:
                return self._send(503, {"error": type(e).__name__})
        if u.path == "/history":
            q = urllib.parse.parse_qs(u.query)
            c, m, b = ((q.get(k) or [""])[0][:64] for k in ("c", "m", "b"))
            if not (c and m and b):
                return self._send(400, {"error": "need c, m, b"})
            try:
                return self._send(200, sales_history(c, m, b, (q.get("slug") or [""])[0][:80]))
            except sqlite3.Error as e:
                return self._send(503, {"error": type(e).__name__})
        if u.path == "/full":
            q = urllib.parse.parse_qs(u.query)
            g = lambda k, n=80: (q.get(k) or [""])[0][:n]
            if not (g("c") and g("m") and g("b")):
                return self._send(400, {"error": "need c, m, b"})
            try:
                stars = int(float(g("stars"))) if g("stars") else None
            except ValueError:
                stars = None
            try:
                return self._send(200, full_info(g("slug"), g("c", 64), g("m", 64), g("b", 64), stars, g("p", 64), g("mr", 8), g("br", 8)))
            except sqlite3.Error as e:
                return self._send(503, {"error": type(e).__name__})
        if u.path == "/gift":
            slug = (urllib.parse.parse_qs(u.query).get("slug") or [""])[0][:80]
            data = gift_picture(slug)
            if not data:
                return self._send(404, {"error": "no picture"})
            self.send_response(200)
            self.send_header("Content-Type", image_type(data))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "max-age=86400")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path == "/model-anim":
            q = urllib.parse.parse_qs(u.query)
            data = model_anim((q.get("slug") or [""])[0][:80], (q.get("layer") or ["gift"])[0][:10])
            if not data:
                return self._send(404, {"error": "no animation"})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "max-age=86400")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path == "/model":
            q = urllib.parse.parse_qs(u.query)
            col, model = (q.get("c") or [""])[0][:64], (q.get("m") or [""])[0][:64]
            data = model_png(col, model) if col and model else None
            if not data:
                return self._send(404, {"error": "no picture"})
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "max-age=86400")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        m = re.fullmatch(r"/pair/(\d{6})", u.path)
        if m:
            with _lock:
                p = _pending.get(m.group(1))
            if not p or time.time() - p["at"] > 600:
                return self._send(404, {"error": "expired"})
            return self._send(200, {"paired": bool(p["token"]), "token": p["token"]})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        n = min(int(self.headers.get("Content-Length") or 0), 8192)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            body = {}
        if u.path == "/pair":
            if not BOT:
                return self._send(503, {"error": "bot not configured"})
            with _lock:
                for c in [c for c, p in _pending.items() if time.time() - p["at"] > 600]:
                    _pending.pop(c, None)
                code = f"{random.SystemRandom().randrange(10**6):06d}"
                _pending[code] = {"at": time.time(), "token": None}
            return self._send(200, {"code": code, "bot": bot_name()})
        if u.path == "/watch":
            tok, it = body.get("token"), body.get("item") or {}
            chat = _pairs.get(tok) if isinstance(tok, str) else None
            if not chat:
                return self._send(403, {"error": "not paired"})
            add_watch(chat, it)
            _items[str(it.get("id") or "")[:40]] = it
            try:
                tg("sendMessage", {"chat_id": chat, "text": f"👁 Watching {it.get('title')} #{it.get('num')} — "
                                   "I'll write if it gets cheaper or is sold."}, 15)
            except Exception:
                pass
            return self._send(200, {"ok": True})
        if u.path == "/send":
            tok, it = body.get("token"), body.get("item") or {}
            chat = _pairs.get(tok) if isinstance(tok, str) else None
            if not chat:
                return self._send(403, {"error": "not paired"})
            if time.time() - _last_send.get(tok, 0) < 1.5:
                return self._send(429, {"error": "slow down"})
            _last_send[tok] = time.time()
            url = it.get("url") if isinstance(it.get("url"), str) and SAFE_URL.match(it["url"]) else None
            gid = str(it.get("id") or "")[:40]
            _items[gid] = it
            if len(_items) > 500:
                _items.pop(next(iter(_items)))
            rows = [[{"text": "🎁 Open gift", "url": url}]] if url else []
            if gid:
                rows.append([{"text": "📈 Price chart", "callback_data": f"chart:{gid}"},
                             {"text": "👁 Watch", "callback_data": f"watch:{gid}"}])
            markup = {"inline_keyboard": rows} if rows else None
            ok = False
            slug = it.get("id") if isinstance(it.get("id"), str) and re.fullmatch(r"[A-Za-z0-9]+-\d{1,9}", it["id"]) else None
            try:
                if slug:                                  # the gift picture with the deal as caption
                    p = {"chat_id": chat, "photo": FRAGMENT_GIFT.format(slug.lower()), "caption": deal_text(it)[:1000]}
                    if markup:
                        p["reply_markup"] = markup
                    try:
                        ok = bool(tg("sendPhoto", p, 20).get("ok"))
                    except Exception:
                        ok = False
                if not ok:
                    params = {"chat_id": chat, "text": deal_text(it), "disable_web_page_preview": "false"}
                    if markup:
                        params["reply_markup"] = markup
                    ok = bool(tg("sendMessage", params, 15).get("ok"))
                return self._send(200, {"ok": ok})
            except Exception as e:
                return self._send(502, {"error": type(e).__name__})
        self._send(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8090"))
    if BOT:
        try:
            tg("setMyCommands", {"commands": [{"command": "settings", "description": "What the glasses show"},
                                              {"command": "collections", "description": "Only these collections"}]}, 15)
        except Exception:
            pass
        threading.Thread(target=bot_loop, daemon=True).start()
        threading.Thread(target=watch_loop, daemon=True).start()
    print(f"TeleGift Glance backend on http://127.0.0.1:{port} · bot: {'@' + bot_name() if BOT else 'not configured'}")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
