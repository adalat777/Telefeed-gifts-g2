"""Tests for the TeleGift Glance backend (stdlib only): python3 -m unittest -v backend/test_server.py"""
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp()
os.environ["TELEFEED_DB"] = os.path.join(TMP, "feed.db")
os.environ["BOT_TOKEN"] = "test-token"
sys.path.insert(0, HERE)
import server  # noqa: E402

server.PAIRS = os.path.join(TMP, "pairs.json")
server.WATCHES = os.path.join(TMP, "watches.json")
server.SETTINGS = os.path.join(TMP, "settings.json")
server.IMG_CACHE = os.path.join(TMP, "cache")
server.TELEFEED_IMG = os.path.join(TMP, "models")
server.TELEFEED_GIFTS = os.path.join(TMP, "gifts")
server._bot_name = "telefeedgifts_ai"

DAY = lambda d: time.strftime("%Y-%m-%dT12:00:00Z", time.gmtime(time.time() - d * 86400))  # noqa: E731


def make_db(path):
    if os.path.exists(path):
        os.remove(path)
    db = sqlite3.connect(path)
    db.executescript("""
    CREATE TABLE ton_usd(day, usd);
    CREATE TABLE profitable(key, data, best_upside, last_at, status, status_at);
    CREATE TABLE sales(id TEXT PRIMARY KEY, collection TEXT, model TEXT, backdrop TEXT, currency TEXT, price REAL,
                       normalized REAL, sold_at TEXT, slug TEXT, symbol TEXT);
    CREATE INDEX sales_combo ON sales(collection, model, backdrop);
    CREATE TABLE msales(id TEXT PRIMARY KEY, market TEXT, collection TEXT, model TEXT, backdrop TEXT, ton REAL,
                        sold_at TEXT, slug TEXT, symbol TEXT);
    CREATE INDEX msales_combo ON msales(market, collection, model, backdrop);
    CREATE TABLE onchain_sales(address TEXT, ts INTEGER, collection TEXT, num INTEGER, model TEXT, backdrop TEXT,
                               ton REAL, market TEXT, src TEXT, dst TEXT);
    CREATE TABLE portals_sales(nft_id TEXT, slug TEXT, collection_id INTEGER, title TEXT, num INTEGER, model TEXT,
                               backdrop TEXT, pattern TEXT, ton REAL, sold_at REAL);
    """)
    db.execute("INSERT INTO ton_usd VALUES ('2026-11-27', 1.0)")
    now = time.time()
    deal = {"slug": "MirageLamp-35247", "title": "Mirage Lamp", "num": 35247, "model": "Fiery Leaf", "backdrop": "Seal Brown",
            "pattern": "Bunny", "stars": 500, "ton": 6.9, "market": "telegram",
            "history": {"upside": 2.0, "sales": 10, "typical": 589, "resale": {"sell": 1180, "net": 944}}}
    sold = dict(deal, slug="MirageLamp-1", num=1)
    pricey = dict(deal, slug="MirageLamp-2", num=2, history={"upside": 2.1, "resale": {"floor": 9999}})
    db.execute("INSERT INTO profitable VALUES (?,?,?,?, 'sale', NULL)", ("MirageLamp-35247", json.dumps(deal), 2, now - 5))
    db.execute("INSERT INTO profitable VALUES (?,?,?,?, 'sold', ?)", ("MirageLamp-1", json.dumps(sold), 2, now - 30, now - 10))
    db.execute("INSERT INTO profitable VALUES (?,?,?,?, 'sale', NULL)", ("MirageLamp-2", json.dumps(pricey), 2, now - 8))
    for i in range(12):                                  # Telegram Market: 10 TON a day + one fake 500 TON sale
        db.execute("INSERT INTO sales VALUES (?,?,?,?,?,?,?,?,?,?)",
                   (f"s{i}", "Mirage Lamp", "Fiery Leaf", "Seal Brown", "STARS", 700, 10 + i % 3, DAY(i), None, None))
    db.execute("INSERT INTO sales VALUES ('fake','Mirage Lamp','Fiery Leaf','Seal Brown','TON',500,500,?,NULL,NULL)", (DAY(1),))
    for i in range(4):
        db.execute("INSERT INTO msales VALUES (?,?,?,?,?,?,?,?,?)",
                   (f"m{i}", "mrkt", "Mirage Lamp", "Fiery Leaf", "Seal Brown", 8 + i, DAY(i), None, None))
    db.execute("INSERT INTO onchain_sales VALUES ('a', ?, 'Mirage Lamp', 5, 'Fiery Leaf', 'Seal Brown', 9, 'Fragment', 'x', 'y')",
               (int(now - 86400),))
    db.execute("INSERT INTO onchain_sales VALUES ('b', ?, 'Mirage Lamp', 6, 'Fiery Leaf', 'Seal Brown', 1, 'Fragment', 'x', 'x')",
               (int(now - 86400),))                      # sold to themselves — not counted
    db.commit()
    db.close()


class FakeTelegram:
    def __init__(self):
        self.calls = []
        self.photo_ok = True

    def __call__(self, method, params=None, timeout=35):
        self.calls.append((method, params or {}))
        if method == "sendPhoto" and not self.photo_ok:
            raise OSError("wrong file type")
        return {"ok": True, "result": []}


class Base(unittest.TestCase):
    def setUp(self):
        make_db(os.environ["TELEFEED_DB"])
        server.DB = os.environ["TELEFEED_DB"]
        server._cache.clear()
        server._detail_cache.clear()
        server._pairs.clear()
        server._watches.clear()
        server._settings.clear()
        server._last_send.clear()
        self.tg = FakeTelegram()
        server.tg = self.tg


class SignalsTest(Base):
    def test_deals_resell_estimate_and_sold_list(self):
        out = server.signals(20, 60)
        ids = [i["id"] for i in out["items"]]
        self.assertEqual(ids, ["MirageLamp-35247", "MirageLamp-2"])       # newest first, sold one not in the list
        self.assertEqual(out["gone"], ["MirageLamp-1"])                    # …but reported as just sold
        rs = out["items"][0]["resell"]
        self.assertEqual(rs["sell"], 1180)
        self.assertEqual(rs["get_usd"], round(944 * 0.013, 2))             # after the 20 % fee, Stars → $
        self.assertEqual(rs["cost_usd"], 6.9)                              # cheaper of 500 ⭐ × $0.015 and 6.9 GRAM × $1
        self.assertGreater(rs["profit_usd"], 5)

    def test_floor_above_the_price_means_cheapest_on_sale(self):
        it = [i for i in server.signals(20, 60)["items"] if i["id"] == "MirageLamp-2"][0]
        self.assertIsNone(it["floor"])
        self.assertTrue(it["cheapest"])


class DetailTest(Base):
    def test_chart_and_venues_without_fakes(self):
        det = server.detail("Mirage Lamp", "Fiery Leaf", "Seal Brown")
        self.assertEqual(len(det["chart"]), 30)
        prices = [c["usd"] for c in det["chart"] if c["usd"]]
        self.assertTrue(prices and max(prices) <= 12)                      # the 500 TON outlier is dropped
        v = {x["market"]: x for x in det["venues"]}
        self.assertEqual(v["telegram"]["n"], 12)
        self.assertEqual(v["mrkt"]["n"], 4)
        self.assertEqual(v["onchain"]["n"], 1)                             # self-sale not counted
        self.assertIsNone(v["tonnel"]["usd"])
        text = server.chart_text({"title": "Mirage Lamp", "model": "Fiery Leaf", "backdrop": "Seal Brown"}, det)
        self.assertIn("MRKT: $", text)
        self.assertIn("not financial advice", text)


class HttpTest(Base):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), server.H)
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def post(self, path, body):
        req = urllib.request.Request(self.url + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def get(self, path):
        try:
            with urllib.request.urlopen(self.url + path) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_send_needs_pairing_then_photo_with_buttons(self):
        item = server.signals(20, 60)["items"][0]
        self.assertEqual(self.post("/send", {"token": "nope", "item": item})[0], 403)
        server._pairs["tok"] = 42
        code, out = self.post("/send", {"token": "tok", "item": item})
        self.assertEqual((code, out["ok"]), (200, True))
        method, p = self.tg.calls[-1]
        self.assertEqual(method, "sendPhoto")
        self.assertEqual(p["photo"], "https://nft.fragment.com/gift/miragelamp-35247.webp")
        btn = [b for row in p["reply_markup"]["inline_keyboard"] for b in row]
        self.assertEqual(btn[0], {"text": "🎁 Open gift", "url": "https://t.me/nft/MirageLamp-35247"})
        self.assertEqual({b.get("callback_data") for b in btn[1:]}, {"chart:MirageLamp-35247", "watch:MirageLamp-35247"})
        self.assertIn("Resell estimate", p["caption"])

    def test_photo_refused_falls_back_to_text(self):
        server._pairs["tok"] = 42
        self.tg.photo_ok = False
        self.post("/send", {"token": "tok", "item": server.signals(20, 60)["items"][0]})
        self.assertEqual([m for m, _ in self.tg.calls], ["sendPhoto", "sendMessage"])

    def test_unsafe_link_is_not_a_button(self):
        server._pairs["tok"] = 42
        item = dict(server.signals(20, 60)["items"][0], url="https://evil.example/x")
        self.post("/send", {"token": "tok", "item": item})
        btn = [b for row in self.tg.calls[-1][1]["reply_markup"]["inline_keyboard"] for b in row]
        self.assertFalse(any("url" in b for b in btn))

    def test_rate_limit(self):
        server._pairs["tok"] = 42
        item = server.signals(20, 60)["items"][0]
        self.assertEqual(self.post("/send", {"token": "tok", "item": item})[0], 200)
        self.assertEqual(self.post("/send", {"token": "tok", "item": item})[0], 429)

    def test_pairing_by_code(self):
        code, out = self.post("/pair", {})
        self.assertEqual(code, 200)
        self.assertEqual(self.get(f"/pair/{out['code']}")[1], {"paired": False, "token": None})
        with server._lock:
            server._pending[out["code"]]["token"] = "t1"
        self.assertEqual(self.get(f"/pair/{out['code']}")[1], {"paired": True, "token": "t1"})

    def test_detail_endpoint(self):
        code, det = self.get("/detail?c=Mirage%20Lamp&m=Fiery%20Leaf&b=Seal%20Brown")
        self.assertEqual(code, 200)
        self.assertEqual(len(det["venues"]), 6)
        self.assertEqual(self.get("/detail?c=x")[0], 400)

    def test_gift_picture_rejects_strange_names(self):
        self.assertIsNone(server.gift_picture("../../etc/passwd"))
        self.assertIsNone(server.gift_picture("a b-1"))


class WatchTest(Base):
    def test_watch_button_then_alert_on_sale_and_price_drop(self):
        item = server.signals(20, 60)["items"][0]
        server._items[item["id"]] = item
        server.on_button({"id": "cb", "data": f"watch:{item['id']}", "message": {"chat": {"id": 7}}})
        self.assertIn(item["id"], server._watches["7"])
        server.check_watches()
        self.assertEqual([m for m, _ in self.tg.calls if m == "sendMessage"], [])   # nothing changed yet
        db = sqlite3.connect(server.DB)                                           # it got 10 % cheaper
        d = json.loads(db.execute("SELECT data FROM profitable WHERE key=?", (item["id"],)).fetchone()[0])
        d["stars"] = 450
        db.execute("UPDATE profitable SET data=? WHERE key=?", (json.dumps(d), item["id"]))
        db.commit()
        server.check_watches()
        self.assertIn("got cheaper: 500 ⭐ → 450 ⭐", self.tg.calls[-1][1]["text"])
        db.execute("UPDATE profitable SET status='sold' WHERE key=?", (item["id"],))   # …and then it is sold
        db.commit()
        db.close()
        server.check_watches()
        self.assertIn("no longer on sale", self.tg.calls[-1][1]["text"])
        self.assertNotIn(item["id"], server._watches["7"])                        # stop watching a sold gift

    def test_chart_button_sends_the_chart(self):
        item = server.signals(20, 60)["items"][0]
        server._items[item["id"]] = item
        server.on_button({"id": "cb", "data": f"chart:{item['id']}", "message": {"chat": {"id": 7}}})
        sent = [p for m, p in self.tg.calls if m == "sendMessage"][0]
        self.assertIn("last 30 days", sent["text"])


class SettingsTest(Base):
    def test_glasses_show_only_what_matches_the_settings(self):
        server._pairs["tok"] = 9
        everything = server.signals(50, 60)["items"]
        self.assertEqual(len(everything), 2)
        server.change_setting(9, "min", "5")                       # only deals with resell profit ≥ $5
        st = server.settings_of(9)
        self.assertEqual([i["id"] for i in everything if server.matches(st, i)], ["MirageLamp-35247"])
        server.change_setting(9, "mk", "telegram")                 # untick Telegram → nothing from Telegram
        self.assertFalse(server.matches(server.settings_of(9), everything[0]))
        server.change_setting(9, "mk", "telegram")                 # tick it back → all markets again
        self.assertIsNone(server.settings_of(9)["markets"])
        server.change_setting(9, "cols", ["Plush Pepe"])
        self.assertFalse(server.matches(server.settings_of(9), everything[0]))

    def test_quiet_hours_across_midnight(self):
        st = {"quiet": [23, 8]}
        at = lambda h: time.mktime((2026, 11, 27, h, 30, 0, 0, 0, -1))  # noqa: E731
        self.assertTrue(server.is_quiet(st, at(2)))
        self.assertTrue(server.is_quiet(st, at(23)))
        self.assertFalse(server.is_quiet(st, at(12)))
        self.assertFalse(server.is_quiet({"quiet": None}, at(2)))

    def test_settings_buttons_and_command(self):
        server.on_button({"id": "c", "data": "set:min:10", "message": {"chat": {"id": 5}, "message_id": 1}})
        self.assertEqual(server.settings_of(5)["min"], 10)
        method, p = [c for c in self.tg.calls if c[0] == "editMessageText"][-1]
        self.assertIn("$10", p["text"])
        kb = [b["text"] for row in p["reply_markup"]["inline_keyboard"] for b in row]
        self.assertIn("✓ $10+", kb)


if __name__ == "__main__":
    unittest.main()
