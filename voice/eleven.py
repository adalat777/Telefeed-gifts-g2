#!/usr/bin/env python3
"""Living voice-over for the jury film (ElevenLabs), scene by scene, each phrase fitted to its scene.

Run on the Mac (the key is read from ~/TeleFeed/.env, ELEVENLABS_API_KEY — never printed):
    ~/TeleFeed/.venv/bin/python ~/TeleFeed/g2/voice/eleven.py Brian Roger Sarah
→ ~/Desktop/telegift-voice/<voice>/line01.mp3 … and plan.json (when each line starts in the film).
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

# (start in the film, ms; how long the scene lasts, ms; text) — matches the timeline of app/film.html
LINES = [
    (300, 3200, "TeleGift Glance."),
    (3800, 5000, "Fresh underpriced Telegram gifts — live, right on your glasses."),
    (9100, 3800, "Swipe up. The next deal."),
    (13100, 3800, "Each one: the price, and how far below its top sale."),
    (17100, 3800, "Tap. Rarity, floors, and how many exist."),
    (21100, 3800, "Tap again. Every sale, on every market."),
    (25100, 3800, "Once more. Who's selling it right now."),
    (29100, 2300, "Double tap. Back to the feed."),
    (31700, 7600, "On the street, a deal pops up in the corner of your eye. No phone in your hand."),
    (39700, 4200, "Hold — and it lands in your Telegram."),
    (44200, 4600, "Open in TeleFeed. The whole market, one tap away."),
    (49200, 3600, "TeleGift Glance. Underpriced gifts, at a glance."),
]
VOICES = {
    "Brian": "nPczCjzI2devNBz1zQrb", "Roger": "CwhRBWXzGAHq8TQ4Fs17", "Sarah": "EXAVITQu4vr4xnSDxMaL",
    "George": "JBFqnCBsd6RMkjVDRZzb", "Eric": "cjVigY5qzO86Huf0OWal", "Daniel": "onwK4e9ZLuTAKqWW03F9",
    "Matilda": "XrExE9yKIg1WjnnlVkGX", "Lily": "pFZP5JQG7iQjIQuC4Bku", "Will": "bIHbv24MWmeRgasZH58o",
}
MODEL = os.environ.get("ELEVEN_MODEL", "eleven_multilingual_v2")
OUT = os.path.expanduser("~/Desktop/telegift-voice")


def key():
    for line in open(os.path.expanduser("~/TeleFeed/.env"), encoding="utf-8"):
        if line.startswith("ELEVENLABS_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    sys.exit("нет ELEVENLABS_API_KEY в ~/TeleFeed/.env")


def tts(k, voice_id, text, speed, path):
    body = {"text": text, "model_id": MODEL,
            "voice_settings": {"stability": 0.45, "similarity_boost": 0.8, "style": 0.35, "use_speaker_boost": True,
                               "speed": speed}}
    req = urllib.request.Request(f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128",
                                 data=json.dumps(body).encode(), method="POST",
                                 headers={"xi-api-key": k, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r, open(path, "wb") as f:
        f.write(r.read())


def length(path):
    out = subprocess.run(["afinfo", path], capture_output=True, text=True).stdout
    m = re.search(r"estimated duration:\s*([\d.]+)", out)
    return float(m.group(1)) if m else 0.0


def main():
    k = key()
    for name in sys.argv[1:] or ["Brian"]:
        vid = VOICES.get(name, name)
        d = os.path.join(OUT, name)
        os.makedirs(d, exist_ok=True)
        plan = []
        for n, (start, slot, text) in enumerate(LINES, 1):
            path = os.path.join(d, f"line{n:02d}.mp3")
            speed = 1.0
            for _ in range(3):                    # too long for its scene → a little faster (up to 1.15)
                tts(k, vid, text, speed, path)
                sec = length(path)
                if sec * 1000 <= slot + 250 or speed >= 1.15:
                    break
                speed = min(1.15, round(speed * (sec * 1000) / slot, 2))
            plan.append({"start_ms": start, "file": path, "sec": round(sec, 2), "slot_s": slot / 1000, "speed": speed})
            print(f"{name} {n:02d}: {sec:.1f} с из {slot / 1000:.1f} (скорость {speed})")
        json.dump(plan, open(os.path.join(d, "plan.json"), "w"), indent=1)
        print("готово:", d)


if __name__ == "__main__":
    main()
