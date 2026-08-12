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

# The light-mode splash mark reuses kora-mark-light.svg — the ink-on-light
# artwork is defined once, there, and nowhere else. But that file is a 240x240
# review-sheet asset: rendered straight through `render` it would land as a tiny
# 240px mark in the corner of the 1024x1024 window. So wrap its body in the same
# 1024 canvas and 0.52 inset transform kora-foreground.svg uses, and render THAT.
# Wrapping beats duplicating the artwork: the two splash variants can never drift
# in geometry, only in color, which is the whole point of having two of them.
{
  printf '%s\n' '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="1024" height="1024">'
  printf '%s\n' '  <g transform="translate(120 120) scale(0.52) translate(-120 -120)">'
  sed -e '1d' -e '$d' "$BRAND/kora-mark-light.svg"
  printf '%s\n' '  </g>' '</svg>'
} > "$tmp/foreground-light.svg"

render "$BRAND/kora-icon.svg"       "$tmp/icon.png"
render "$BRAND/kora-foreground.svg" "$tmp/foreground.png"
render "$BRAND/kora-monochrome.svg" "$tmp/monochrome.png"
render "$tmp/foreground-light.svg"  "$tmp/foreground-light.png"

# iOS app icon: no alpha channel — the App Store rejects icons with one.
magick "$tmp/icon.png" -background "#0B0D10" -alpha remove -alpha off \
  "$OUT/icon.png"

# Android adaptive layers. Foreground and monochrome keep their alpha.
magick "$tmp/foreground.png" "$OUT/android-icon-foreground.png"
magick "$tmp/monochrome.png" "$OUT/android-icon-monochrome.png"
magick -size 1024x1024 "xc:#0B0D10" "$OUT/android-icon-background.png"

# Splash: the mark on transparency, composited by expo-splash-screen over the
# configured backgroundColor. Two variants, because one cannot serve both
# themes — the cream mark over a light background is very nearly invisible.
magick "$tmp/foreground.png"       "$OUT/splash-icon.png"
magick "$tmp/foreground-light.png" "$OUT/splash-icon-light.png"

# Web favicon.
magick "$tmp/icon.png" -resize 48x48 "$OUT/favicon.png"

# Small mark for the tesserix-home admin rail (kept beside the sources so it can
# be copied into that repo deliberately, not picked up by the mobile bundler).
#
# Derived from the MONOCHROME layer, not icon.png. The rail renders this with
# Tailwind's `brightness-0 invert`, which flattens every visible pixel to white
# and preserves only ALPHA — so a source with an opaque background renders as a
# flat white square, not a mark. icon.png has exactly that opaque background,
# and shipping it produced precisely that blank square. PNG32: forces RGBA out;
# an indexed PNG with no tRNS chunk is fully opaque and reintroduces the bug.
magick "$tmp/monochrome.png" -resize 64x64 PNG32:"$BRAND/kora-rail-64.png"

echo "Wrote:"
for f in icon android-icon-foreground android-icon-monochrome android-icon-background splash-icon splash-icon-light favicon; do
  printf '  %s  ' "$OUT/$f.png"; magick identify -format '%wx%h %[channels]\n' "$OUT/$f.png"
done
printf '  %s  ' "$BRAND/kora-rail-64.png"; magick identify -format '%wx%h %[channels]\n' "$BRAND/kora-rail-64.png"
