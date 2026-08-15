# Specialist Review — Ignition Redesign (sketches 001 + 002)

Reviewed 2026-08-16 by two agents: UX design specialist and mobile-app (React Native) design
specialist. Verdict from both: **direction approved, not fundamentally broken, but fix the
items below before implementation.** Full agent reports summarized; convergent findings first.

## Convergent (both reviewers) — must resolve before build

1. **Ignition plays too often.** As prototyped it fires on every screen entry; a nutrition app
   is opened 10–20×/day. Gate the full sweep + count-down to first launch of the day (persisted
   flag); all other visits use the plain critically-damped settle. (UX CRITICAL #2 / RN HIGH #6.)
2. **Diary's mega-cluster must be split.** One glass panel holding day-total + meal slots +
   ghost CTA + water is a scannability problem (UX HIGH #5) and an engineering problem — it
   can't virtualize an unbounded meal list and leaves no room for swipe-to-edit (RN MEDIUM #9).
   Decision: bezel cluster wraps only fixed-cardinality content (day-total + water well);
   meal rows break out into a plain hairline list below, like Home's "Logged today".
3. **Dynamic Type is unaddressed.** 8–10px engraved labels, the 44px gauge numeral inside a
   fixed 264px viewBox, and dock labels all need `maxFontSizeMultiplier` caps (~1.3–1.6) and
   overflow clearance. "Portion is a guess" is a trust disclosure, not decoration — promote it
   to ≥11–12px sentence case with an icon. (UX HIGH #3 / RN MEDIUM #10.)

## UX findings (design)

- **CRITICAL — accent budget fails under real data.** Diary shows 7–8 concurrent orange
  elements, Trends 16+. Pick ONE hero accent per screen: Diary = day-total track (demote
  goal pips to tickLit); Trends = weight endpoint+delta (desaturate streak cells); Home =
  hero needle only (render SubDial lit ticks in tickLit/ink, not accent — also fixes the
  four-gauges-compete problem, MEDIUM #8).
- **HIGH — icons-only dock hurts discoverability.** ☀︎/▤/↗/••• glyphs are not self-evident;
  replace with unambiguous icons (calendar for Diary, chart for Trends) and consider
  always-on labels as default with label-on-active as a compact preference. Set explicit
  `accessibilityLabel` per tab in RN regardless of visual label state (LOW #14).
- **HIGH — reduced-motion gaps.** Day-total track, microbars, and tile bars animate
  unconditionally; apply the same `reduced` branch the Trends charts already use.
- **MEDIUM — weight delta color grammar.** "▾ 1.2 kg" (good news) is hardcoded accent, but
  the system teaches orange = over/attention. Make delta color conditional on goal direction.
- **MEDIUM — emotional register.** Keep "redline/ignition" purely visual; never surface that
  language in user-facing copy or notifications (food-anxiety sensitivity).
- **MEDIUM — hit targets.** Week-rail day cells compute ≈44pt on 390pt; verify on iPhone SE
  (375pt) and extend tappable area into the gaps if under.
- **LOW** — replace emoji glyphs with a monochrome icon set; reconcile `--mut` light value
  (spec `#6D7580` vs sketch `#5A6069`); swap the real email for fake sample data; test ghost
  CTA copy wrapping at large numerals/Dynamic Type.

## RN feasibility findings (build)

- **CRITICAL — conic bezel isn't buildable as specified** (no conic gradient in RN without
  Skia). Decision: simplify to the two-stop linear rim (top-light → bottom-shade) and drop
  the conic layer. **Do not adopt @shopify/react-native-skia for this redesign** — new
  native dep vs fragile EAS builds, and it would split the instrument system across two
  renderers for one decorative ring.
- **HIGH — notched FAB ring trick breaks over blur.** `border: 5px solid bg` only works on a
  flat ground; over BlurView it reads as an opaque disc. Keep the current FloatingTabBar
  architecture (FAB as raised sibling); restyle only (slimmer capsule, bezel rim, wells).
- **HIGH — lume glow vs GlassPanel clipping.** `overflow: hidden` on GlassPanel clips large
  textShadowRadius; layer glowing numerals outside the clipped blur container or pad the
  panel interior. Needle glow: duplicate blurred SVG line underneath, not a filter.
- **HIGH — two needle springs.** Keep `NEEDLE_SPRING` (damping 30, stiffness 250, no
  overshoot) for all data updates; add a separate named underdamped spring for the once-a-day
  ignition only. Check instrument/gauge motion tests before changing anything.
- **MEDIUM — inset shadows don't exist in RN**; use the proven `inset` fill + top hairline
  recipe from FloatingTabBar for every recessed well.
- **MEDIUM — blur area.** One fused cluster is cheaper than six small blurs, but cap any
  single cluster below ~one screen height and profile scrolling on the iPhone 17 Pro Max sim.
- **MEDIUM — haptics opportunities** (not in mockups): impactLight on ignition settle and
  water pills, selection on week-rail day taps.
- **LOW — Trends charts need no Skia**; react-native-svg + Reanimated animated-props (the
  existing GaugeDial pattern) covers draw-in and bar growth. Check for an existing
  AnimatedNumber primitive before building the count-down.

## Component breakdown (RN reviewer's estimate)

| Component | Effort | Note |
|---|---|---|
| BezelCluster (shared rim + zones + zone-rules) | M | linear rim, not conic; base for Home/Diary/Trends heroes |
| Specular sweep | S | expo-linear-gradient + Reanimated, one-shot, reduced-motion aware |
| Lume treatment | S–M | M until the GlassPanel clipping question is resolved |
| Ignition sequence | M (→S) | S if an AnimatedNumber primitive already exists |
| Dock v2 restyle | M | keep current architecture, no notch mask |
| Diary day cluster | M | after splitting meal list out (was L–XL fused) |
| Trends charts | S–M | EnergyBars/SegmentedGlass/StreakCells likely 70–80% reusable |
| More screen | S | layout/restyle only |

Sequencing: BezelCluster + lume clipping fix first, ignition gating decision up front,
accent-budget rebalance is a token-level pass across all sketches before any RN work.
