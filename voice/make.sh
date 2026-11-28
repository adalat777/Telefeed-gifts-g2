#!/bin/bash
# Озвучка ролика голосом Mac: каждая сцена — свой файл (удобно ставить под свою сцену в iMovie).
# Запуск: bash ~/TeleFeed/g2/voice/make.sh "Ava (Premium)"
VOICE="${1:-Ava (Premium)}"
OUT="$HOME/Desktop/telegift-voice"
mkdir -p "$OUT"
cd "$(dirname "$0")"
grep -v '^#' scenes.txt | while read -r num text; do
  [ -z "$num" ] && continue
  say -v "$VOICE" -o "$OUT/scene$num.aiff" "$text" && echo "сцена $num — готово"
done
# всё подряд одним файлом (между сценами — 1 с тишины)
ALL=$(grep -v '^#' scenes.txt | cut -d' ' -f2- | sed 's/$/ [[slnc 1000]]/' | tr '\n' ' ')
say -v "$VOICE" -o "$OUT/all.aiff" "$ALL" && echo "всё подряд — $OUT/all.aiff"
open "$OUT"
