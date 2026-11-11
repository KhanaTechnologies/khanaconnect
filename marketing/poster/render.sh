#!/bin/sh
# Render the carousel: 6 PNGs at 1080x1350 plus one PDF. Run from this folder.
CH="/c/Program Files/Google/Chrome/Application/chrome.exe"
URL="file:///$(pwd -W)/carousel.html"
names="01-what-we-offer 02-every-plan-includes 03-plans 04-add-ons 05-founding-partners 06-lets-talk"
i=1
for n in $names; do
  "$CH" --headless=new --hide-scrollbars --force-device-scale-factor=1 --window-size=1080,1350 \
    --virtual-time-budget=6000 --screenshot="$(pwd -W)/$n.png" "$URL?s=$i" 2>/dev/null
  i=$((i+1))
done
"$CH" --headless=new --no-pdf-header-footer --virtual-time-budget=6000 \
  --print-to-pdf="$(pwd -W)/khana-what-we-offer.pdf" "$URL" 2>/dev/null
ls -la *.png *.pdf
