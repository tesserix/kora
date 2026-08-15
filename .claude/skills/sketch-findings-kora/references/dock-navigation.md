# Dock v2 — navigation chrome

## Design Decisions
- **Slimmer 58px capsule** (was 64) with the same two-stop bezel rim as the clusters,
  so chrome and instruments read as machined from one material. Radius 31 outer /
  29.5 inner, glass fill + blur, 1px glassBorder, positioned left/right 24, bottom 24.
- **Labels always visible** (post-review — discoverability beat the icons-only look):
  8px engraved uppercase under each icon at opacity .72 / weight 500; active tab gets
  opacity 1 / weight 700. In RN keep `maxFontSizeMultiplier` ≈1.6 and set explicit
  `accessibilityLabel` per tab regardless of visual label state.
- **Glyphs must be self-evident**: home / calendar-grid / trend-arrow / menu
  (mockup placeholders ⌂ ▦ ↗ ≡ — production uses the app's monochrome icon set,
  never emoji). The original ☀︎/▤/•••set failed the review.
- **Active state is a sliding well (Instagram-style switching).** The well is a
  full pill (radius = height/2, 44px → 22px) — the dock's own capsule silhouette
  miniaturized, not a rounded rectangle. It is a single element that glides between tabs with a springy overshoot ease
  (`cubic-bezier(.3,1.3,.4,1)`, ~380ms), carrying the 4px glowing accent dot with it;
  the tapped icon simultaneously does a quick pop (scale 1 → .82 → 1.12 → 1, ~400ms).
  RN mapping: animate the well's `translateX`/width with a Reanimated spring
  (lively-adjacent, slight underdamp is intended here), icon pop via the existing
  PressableScale/scale spring, `selection` haptic on switch. Under Reduce Motion the
  well jumps instantly and the pop is skipped. The well + dot remain the dock's
  single accent element.
- **Capture button: raised sibling, NOT notched.** The mockup's bg-colored ring
  "carved" look breaks over live blur in RN. Keep FloatingTabBar's architecture
  (absolute sibling raised ~16px above the pill); restyle only: 56px domed orange
  (radial top-lit gradient over accent), accent glow shadow, accentOn icon.
- Preserve `pointerEvents="box-none"` on the positioning wrapper so the center gap
  doesn't eat touches.

## CSS Pattern (mockup reference)
```css
.dock2-bezel { border-radius: 31px; padding: 1.5px;
  background: linear-gradient(180deg, var(--glass-highlight), transparent 30%, var(--shade) 92%); }
.dock2 { height: 58px; border-radius: 29.5px; background: var(--glass);
  backdrop-filter: blur(20px); border: 1px solid var(--glass-border); }
.tb2.active { background: var(--inset); box-shadow: inset 0 1px 0 var(--well-shadow); }
.capture-fab2 { width: 56px; height: 56px; top: -16px;
  background: radial-gradient(120% 120% at 50% 0%,
    color-mix(in srgb, #fff 28%, var(--accent)) 0%, var(--accent) 46%,
    color-mix(in srgb, #000 22%, var(--accent)) 100%); }
```

## What to Avoid
- The bg-ring notch trick over blur; label-on-active-only; ambiguous glyphs;
  floating flat-orange FAB (the pre-redesign look the user called ordinary).

## Origin
Sketch 001 variant D dock, revised per UX finding #6 and RN finding #4.
