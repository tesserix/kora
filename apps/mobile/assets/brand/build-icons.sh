#!/usr/bin/env bash
# Regenerate every Kora icon PNG from the SVG sources in this directory.
#
#   ./assets/brand/build-icons.sh          (run from apps/mobile)
#
# Chrome renders the SVGs rather than ImageMagick: ImageMagick's built-in SVG
# delegate silently DROPPED a stroked path while these concepts were being
# reviewed, which is the worst possible failure for an asset pipeline — a
# plausible-looking PNG with a missing element. Chrome is the same engine that
# renders the contact sheet, so what is reviewed is what ships.
#
# ImageMagick is still used for resizing and flattening, which it does reliably.
set -euo pipefail

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BRAND="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$BRAND/../images"

[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME" >&2; exit 1; }
command -v magick >/dev/null || { echo "ImageMagick 'magick' not on PATH" >&2; exit 1; }

# render <source.svg> <dest.png> — always at 1024, transparent where the SVG is.
render() {
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --default-background-color=00000000 \
    --screenshot="$2" --window-size=1024,1024 "file://$1" 2>/dev/null
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

render "$BRAND/kora-icon.svg"       "$tmp/icon.png"
render "$BRAND/kora-foreground.svg" "$tmp/foreground.png"
render "$BRAND/kora-monochrome.svg" "$tmp/monochrome.png"

# iOS app icon: no alpha channel — the App Store rejects icons with one.
magick "$tmp/icon.png" -background "#0A0D0B" -alpha remove -alpha off \
  "$OUT/icon.png"

# Android adaptive layers. Foreground and monochrome keep their alpha.
magick "$tmp/foreground.png" "$OUT/android-icon-foreground.png"
magick "$tmp/monochrome.png" "$OUT/android-icon-monochrome.png"
magick -size 1024x1024 "xc:#0A0D0B" "$OUT/android-icon-background.png"

# Splash: the mark on transparency, composited by expo-splash-screen over the
# configured backgroundColor.
magick "$tmp/foreground.png" "$OUT/splash-icon.png"

# Web favicon.
magick "$tmp/icon.png" -resize 48x48 "$OUT/favicon.png"

# Small mark for the tesserix-home admin rail (kept beside the sources so it can
# be copied into that repo deliberately, not picked up by the mobile bundler).
magick "$tmp/icon.png" -resize 64x64 "$BRAND/kora-rail-64.png"

echo "Wrote:"
for f in icon android-icon-foreground android-icon-monochrome android-icon-background splash-icon favicon; do
  printf '  %s  ' "$OUT/$f.png"; magick identify -format '%wx%h %[channels]\n' "$OUT/$f.png"
done
printf '  %s  ' "$BRAND/kora-rail-64.png"; magick identify -format '%wx%h %[channels]\n' "$BRAND/kora-rail-64.png"
