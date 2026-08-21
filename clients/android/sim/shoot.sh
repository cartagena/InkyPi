#!/usr/bin/env bash
# Contact sheet of the whole app from headless Chrome, at the tablet's CSS geometry.
#   sim/shoot.sh <outdir> [scene ...]
# Starts sim/server.py if nothing answers on :8788, shoots the dashboard and every panel
# for each scene (default: the real weather plus rain, snow, storm, fog, clear-night),
# and writes <outdir>/<scene>-<screen>.png. Needs Google Chrome.
set -euo pipefail
OUT="${1:?outdir}"; shift || true
SCENES=("$@"); [ ${#SCENES[@]} -eq 0 ] && SCENES=(real rain snow storm fog clear-night)
CH="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
URL="http://127.0.0.1:8788"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
if ! curl -sf -o /dev/null "$URL/"; then
  (python3 "$HERE/server.py" >/dev/null 2>&1 &) ; sleep 1.2
fi
SCREENS=(home clock weather hourly daily sensors timer system settings moon air year calendar paper gallery news)
for sc in "${SCENES[@]}"; do
  q=""; [ "$sc" != "real" ] && q="scene=$sc"
  for scr in "${SCREENS[@]}"; do
    if [ "$scr" = "home" ]; then p="$URL/?$q"; else p="$URL/?open=$scr&$q"; fi
    # panels other than weather ones look the same in every scene: shoot them once
    if [ "$sc" != "real" ] && [[ ! "$scr" =~ ^(home|weather|hourly|daily)$ ]]; then continue; fi
    "$CH" --headless=new --disable-gpu --hide-scrollbars --window-size=711,1138 \
      --virtual-time-budget=9000 --screenshot="$OUT/$sc-$scr.png" "$p" >/dev/null 2>&1 || echo "failed: $sc $scr"
  done
done
echo "shots in $OUT: $(ls "$OUT" | wc -l | tr -d ' ')"
