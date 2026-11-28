#!/usr/bin/env python3
"""Автопилот для видео жюри: сам нажимает в эмуляторе очков в такт озвучке и сам пишет экран.

Запуск на Маке (эмулятор уже открыт через ./dev.sh, в нём лента лотов):
    ~/TeleFeed/.venv/bin/python ~/TeleFeed/g2/voice/autopilot.py "Ava (Premium)"

Что делает:
  1. Озвучивает сцены 1–6 (voice/scenes.txt) и узнаёт длину каждой фразы.
  2. Под каждую сцену отводит своё время; делает ОДИН звуковой файл с паузами
     ровно под эти отрезки — ~/Desktop/telegift-voice/autopilot-voice.aiff.
  3. Считает 5 секунд (переключитесь на окно эмулятора), включает запись экрана
     (~/Desktop/telegift-autopilot.mov), играет озвучку и в нужные моменты нажимает:
     свайпы, касания, двойное касание, удержание (удержание шлёт лот в Telegram — так и задумано).
  4. В iMovie видео и autopilot-voice.aiff кладутся с самого начала — совпадут сами.
Сцены 7–11 (Telegram) записываются руками, озвучка к ним — scene07…scene11.aiff (voice/make.sh).

  --no-record   не включать запись экрана (записывайте сами Cmd+Shift+5)
  --region=x,y,w,h  записывать только этот кусок экрана (по умолчанию — сам экран очков, без кнопок эмулятора)
  --full-screen     записывать весь экран
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request

API = "http://127.0.0.1:9898/api/input"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.expanduser("~/Desktop/telegift-voice")
# a new name every run: screencapture cannot overwrite an existing file
VIDEO = os.path.expanduser(time.strftime("~/Desktop/telegift-autopilot-%H%M.mov"))
GAP = 0.8          # тишина после каждой сцены, с
TAIL = 1.5         # после последнего нажатия сцены — ещё столько, чтобы глаз успел увидеть

# Нажатия: (доля длины фразы сцены, действие). Доля 0.0 — начало фразы, 1.0 — конец.
TIMELINE = {
    "01": [],
    "02": [],
    "03": [(0.04, "up"), (0.55, "up"), (0.82, "up")],                 # Swipe up. Next deal. …
    "04": [(0.02, "click"),                                           # Tap. → GIFT
           (0.45, "click"), (0.56, "down"), (0.64, "down"),           # Tap again. → SALES, листаем
           (0.79, "click")],                                          # And once more. → ON SALE
    "05": [(0.03, "double_click")],                                   # Double tap → лента
    "06": [(0.30, "long_press")],                                     # Just hold → лот в Telegram
}


FIND_WINDOW = r"""
import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list where (w["kCGWindowName"] as? String) == "Glasses Display" {
  let b = w["kCGWindowBounds"] as! [String: Double]
  print(Int(b["X"]!), Int(b["Y"]!), Int(b["Width"]!), Int(b["Height"]!)); break
}
"""
TITLE_H, BUTTONS_H = 31, 41   # the simulator window: its title bar on top, the Up / Down / Click… buttons below


def raise_glasses():
    """Bring the simulator window to the front, so nothing covers it in the recording."""
    subprocess.run(["osascript", "-e", 'tell application "System Events" to set frontmost of '
                    '(first process whose name is "evenhub-simulator") to true'], capture_output=True)


def glasses_region():
    """Only the lens of the glasses: the "Glasses Display" window without its title bar and buttons."""
    path = "/tmp/tf_find_window.swift"
    with open(path, "w") as f:
        f.write(FIND_WINDOW)
    out = subprocess.run(["swift", path], capture_output=True, text=True).stdout.split()
    if len(out) != 4:
        return None
    x, y, w, h = map(int, out)
    return f"{x},{y + TITLE_H},{w},{h - TITLE_H - BUTTONS_H}"


def say(voice, text, path):
    subprocess.run(["say", "-v", voice, "-o", path, text], check=True)


def duration(path):
    out = subprocess.run(["afinfo", path], capture_output=True, text=True).stdout
    m = re.search(r"estimated duration:\s*([\d.]+)", out)
    return float(m.group(1)) if m else 0.0


def press(action):
    req = urllib.request.Request(API, data=json.dumps({"action": action}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=3).read()
        print(f"   · {action}")
    except Exception as e:
        print(f"   ! эмулятор не ответил на «{action}»: {e}")


def scenes():
    rows = {}
    for line in open(os.path.join(HERE, "scenes.txt"), encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        num, text = line.split(" ", 1)
        if num in TIMELINE:
            rows[num] = text
    return rows


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    voice = args[0] if args else "Ava (Premium)"
    record = "--no-record" not in sys.argv
    os.makedirs(OUT, exist_ok=True)

    print("Озвучиваю сцены 1–6…")
    plan, start = [], 0.0
    for num, text in scenes().items():
        f = os.path.join(OUT, f"scene{num}.aiff")
        say(voice, text, f)
        d = duration(f)
        acts = [(start + frac * d, a) for frac, a in TIMELINE[num]]
        last = max([t - start for t, _ in acts], default=0)
        slot = max(d, last + TAIL) + GAP
        plan.append((num, text, start, d, slot, acts))
        print(f"  сцена {num}: фраза {d:.1f} с, отрезок {slot:.1f} с")
        start += slot
    total = start

    # Один файл озвучки: каждая фраза + тишина до конца своего отрезка.
    full = " ".join(f"{text} [[slnc {int((slot - d) * 1000)}]]" for _, text, _, d, slot, _ in plan)
    voice_file = os.path.join(OUT, "autopilot-voice.aiff")
    say(voice, full, voice_file)
    print(f"Озвучка целиком: {voice_file} ({duration(voice_file):.1f} с, план {total:.1f} с)")

    print("\nЛента в эмуляторе должна быть открыта (не «полная информация»).")
    print("Начинаю через 5 секунд — не трогайте Мак, пока идёт запись…")
    for i in range(5, 0, -1):
        print(f"  {i}…")
        time.sleep(1)
    raise_glasses()
    time.sleep(0.5)

    rec = None
    if record:
        try:
            cmd = ["screencapture", "-v", "-V" + str(int(total + 3))]
            region = [a.split("=", 1)[1] for a in sys.argv if a.startswith("--region=")]
            if not region and "--full-screen" not in sys.argv:
                found = glasses_region()
                region = [found] if found else []
                print("Пишу только экран очков:" if found else "Окно очков не нашёл — пишу весь экран", found or "")
            if region:  # только окно очков: --region=x,y,ширина,высота (в точках экрана)
                cmd.append("-R" + region[0])
            rec = subprocess.Popen(cmd + [VIDEO])
            time.sleep(1.0)  # запись успевает начаться
        except Exception as e:
            print(f"! запись экрана не включилась ({e}) — запишите сами Cmd+Shift+5")
            rec = None

    t0 = time.monotonic()
    threading.Thread(target=lambda: subprocess.run(["afplay", voice_file]), daemon=True).start()
    for num, _, s, _, _, acts in plan:
        print(f"сцена {num}")
        for t, action in acts:
            wait = t0 + t - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            press(action)
    rest = t0 + total - time.monotonic()
    if rest > 0:
        time.sleep(rest)

    if rec:
        print("Жду, пока запись экрана закончится…")
        rec.wait()
        lead = 1.0
        print(f"\nВидео: {VIDEO}")
        print(f"Озвучка начинается на {lead:.0f} с позже начала видео — в iMovie сдвиньте её на 1 с вправо.")
    print(f"Озвучка: {voice_file}")
    print("Дальше руками: сцены 7–11 в Telegram, к ним scene07…scene11.aiff (bash voice/make.sh).")


if __name__ == "__main__":
    main()
