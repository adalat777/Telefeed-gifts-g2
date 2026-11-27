"""TeleGift Glance backend — Telegram Gifts deals for Even Realities G2.

Small stdlib-only HTTP server (no dependencies):
  GET  /signals?limit=20&minutes=60   fresh underpriced gift listings (read-only, from the TeleFeed database)
  POST /pair                           start pairing: returns a 6-digit code to send to the Telegram bot
  GET  /pair/<code>                    poll: {"paired": true, "token": "..."} once the code was sent to the bot
  POST /send {"token", "item"}         the bot sends this deal to the paired Telegram chat (link + "Open gift" button)
  GET  /model?c=<collection>&m=<model>  PNG of the gift model without background (cdn.changes.tg, cached on disk)
  GET  /gift?slug=<slug>             the full gift picture (backdrop + pattern symbols + model) from Fragment, cached
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
            res = tg("getUpdates", {"offset": offset, "timeout": 30, "allowed_updates": ["message"]}, timeout=40)
            for u in res.get("result", []):
                offset = u["update_id"] + 1
                m = u.get("message") or {}
                chat = (m.get("chat") or {}).get("id")
                text = (m.get("text") or "").strip()
                if not chat or not text:
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
                    tg("sendMessage", {"chat_id": chat, "text": "✅ Paired with your G2 glasses.\nTap a deal on the glasses — it lands here with a link to buy."}, 15)
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
            price, cur, usd = d["ton"], "GRAM", (d["ton"] * usd_rate if usd_rate else None)
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
            "max": h.get("max_stars"), "sales": h.get("sales"), "market": d.get("market") or "telegram",
            "url": d.get("url") or (f"https://t.me/nft/{d['slug']}" if d.get("slug") else None),
            "seen_s": int(time.time() - last),
            "resell": resell(d, h, res, usd_rate),
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
                return self._send(200, signals(limit, minutes))
            except (ValueError, sqlite3.Error) as e:
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
        if u.path == "/send":
            tok, it = body.get("token"), body.get("item") or {}
            chat = _pairs.get(tok) if isinstance(tok, str) else None
            if not chat:
                return self._send(403, {"error": "not paired"})
            if time.time() - _last_send.get(tok, 0) < 1.5:
                return self._send(429, {"error": "slow down"})
            _last_send[tok] = time.time()
            url = it.get("url") if isinstance(it.get("url"), str) and SAFE_URL.match(it["url"]) else None
            params = {"chat_id": chat, "text": deal_text(it), "disable_web_page_preview": "false"}
            if url:
                params["reply_markup"] = {"inline_keyboard": [[{"text": "🎁 Open gift", "url": url}]]}
            try:
                r = tg("sendMessage", params, 15)
                return self._send(200, {"ok": bool(r.get("ok"))})
            except Exception as e:
                return self._send(502, {"error": type(e).__name__})
        self._send(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8090"))
    if BOT:
        threading.Thread(target=bot_loop, daemon=True).start()
    print(f"TeleGift Glance backend on http://127.0.0.1:{port} · bot: {'@' + bot_name() if BOT else 'not configured'}")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
