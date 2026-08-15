# Kora Ignition — panel architecture and motion uplift

**Date:** 2026-08-16
**Status:** Approved direction (sketch rounds 1–2 signed off; specialist-reviewed and revised)
**Amends:** `2026-08-11-kora-instrument-glass-design.md` — tokens, gauge geometry, and accent
philosophy carry forward unchanged; this spec replaces its panel structure, navigation
chrome, and adds a motion/light system and edge-state contracts.
**Prototypes:** claude.ai artifacts "Kora Home Panels" (sketch 001, four variants, winner D)
and "Kora Ignition Screens" (sketch 002, all four main screens). Sources preserved in
`.planning/sketches/` and `.claude/skills/sketch-findings-kora/sources/`.
**Reviews:** UX-design and RN-feasibility specialist reviews consolidated in
`.planning/sketches/REVIEW-ignition.md` — its findings are folded into this spec and binding.
**Findings skill:** `Skill("sketch-findings-kora")` — auto-load before touching mobile UI.

## Direction

Instrument Glass stays; **panel monotony goes**. The pre-Ignition screens stacked six
near-identical blur-glass cards at equal visual weight. Ignition restructures every
screen around **one bezel-grade fused instrument** with everything else subordinate,
and moves the "wow" into motion and light — a once-a-day ignition sweep, watch-dial
lume, odometer numerals — never into new colors or decoration. The emotional target
is a premium car cluster / chronograph: modern, clean, classy.

Explicitly rejected during sketching: an editorial card-free layout for data screens
(sketch 001 variant B — hierarchy did not hold), the everything-in-one-cluster Diary
(review: scannability + unbounded-list engineering failure), a conic brushed bezel and
a notched dock FAB (both unbuildable in RN without unacceptable cost — see Feasibility).

## New finish tokens

Added to the instrument token sets (port into `palette.ts`; sketch mirror in
`.planning/sketches/themes/default.css`):

| Token | Dark | Light | Role |
| --- | --- | --- | --- |
| `shade` | `rgba(0,0,0,0.28)` | `rgba(22,24,28,0.12)` | bezel bottom shading |
| `wellShadow` | `rgba(0,0,0,0.25)` | `rgba(22,24,28,0.08)` | top inner line of recessed wells |
| `lumeText` | `rgba(237,230,212,0.30)` | **transparent** | glow behind hero numerals |
| `lumeAccent` | `rgba(255,74,0,0.45)` | `rgba(210,56,0,0.22)` | glow behind accent captions |

Light mode is a distinct finish, not swapped colors: shading drops to graphite levels
and the warm text lume turns **off** (a halo behind near-black numerals reads as smudge;
daylight dials don't glow).

## Panel architecture

**Rule: one bezel-grade instrument per screen.** Everything else sits on standard
sheened glass or directly on the ground as hairline lists.

- **BezelCluster** (new shared primitive): a 1.5px rim wearing a two-stop linear
  gradient (`glassHighlight` top → `shade` bottom) around a fused glass body with a
  radial top sheen. Zones inside are divided by **zone rules** — an engraved 10px
  uppercase label flanked by hairlines — replacing inter-card gaps. Fixed-height
  recessed **wells** (`inset` fill + `wellShadow` top line + `glassBorder` ring, never
  a true inset shadow) anchor the cluster's base (vitals, water).
- **Clusters wrap fixed-cardinality content only.** An unbounded list (the meal log)
  never lives inside a cluster — it cannot virtualize and blocks swipe-to-edit. Meal
  rows are always a card-free hairline list: 60px mono time column / name + sub /
  mono kcal.
- Radius ladder: bezel 24–28 · standard glass 22 · strips/tiles 18–20 · wells 10–16 ·
  dock 31/29.5. Glass never stacks on glass.

## Navigation — dock v2

- 58px capsule (left/right 24, bottom 24) wearing the same bezel rim as the clusters;
  glass fill + blur, 1px `glassBorder`.
- Four tabs with **always-visible labels** (8px engraved, opacity .72/w500; active 1/w700,
  `maxFontSizeMultiplier` ≈1.6, explicit `accessibilityLabel` per tab). Glyphs must be
  self-evident: home / calendar / trend / menu. Never emoji.
- **Active state is a sliding pill well** (Instagram-style): a single 44px-tall pill
  (radius = height/2 — the dock's own capsule silhouette miniaturized) glides between
  tabs with a springy overshoot (~380ms, slight underdamp is intentional chrome motion),
  carrying the 4px glowing accent dot. The tapped icon pops (scale 1 → .82 → 1.12 → 1,
  ~400ms). `selection` haptic on switch.
- **Capture button: raised sibling, not notched.** 56px domed orange (radial top-lit
  gradient over `accent`), raised ~16px above the pill, accent glow shadow. The
  mockups' bg-ring "carved" trick is rejected — it breaks over live blur.
- **Screen changes ride the dock slide:** the incoming screen fades in drifting 16px
  from the direction of travel (~280ms ease-out), fired ~160ms after the well starts
  moving, so dock + content read as one gesture.

## Motion & light system

- **Ignition sequence** (the signature moment, Home only): needle sweeps to full
  redline (~0.65s ease-in), settles back to the true value with slight overshoot
  (~0.95s), while the reserve numeral counts down from the full budget (~1.65s
  ease-out) and a one-time specular band sweeps the cluster glass (1.6s).
  **Plays once per day** (persisted flag, first cold launch). Every other visit and
  every data update uses the existing critically-damped settle.
- **Two named needle springs.** `NEEDLE_SPRING {damping:30, stiffness:250}` is
  untouched for all data-driven motion; a separate underdamped ignition spring
  (~`{damping:12, stiffness:180}`) exists solely for the once-a-day sequence.
- **Lume**: reserve numeral glow (`lumeText`), accent caption glow (`lumeAccent`),
  needle glow (duplicate blurred SVG line beneath — no SVG filters). Off in light
  mode and in the over-budget state.
- **Odometer rolls**: logging a meal counts the reserve figure from old → new value
  (~550ms ease-out) and macro numerals rise-in (9px translate + fade, ~350ms).
- **Branded pull-to-refresh** (Home): the needle tick-sweeps to full (~450ms) and
  returns with slight overshoot (~750ms) as the refresh indicator — no spinner.
- **Capture shutter press**: scale dip to .86 and back (~350ms) with a brief iris
  blink before the camera opens; `impactMedium` haptic.
- **Entrances**: staggered FadeInDown (~450ms, 60ms steps), first mount only.
- **Reduce Motion**: every behavior above degrades to instant apply / crossfade —
  no ignition, no pops, no sweeps, no rolls. This is a gate, not a nice-to-have.
- Haptics: `impactLight` on ignition settle and water pills, `selection` on week-rail
  day taps and dock switches, `impactMedium` on capture.
- "Ignition"/"redline" vocabulary is **visual only** — never in user-facing copy,
  errors, or notifications (food-anxiety sensitivity).

## Accent budget (hardened)

The 2026-08-11 "one accent per view" rule collapsed under real data (first mockups:
Diary 7–8 concurrent oranges, Trends 16+). The enforced contract:
**one hero accent moment per screen**, plus persistent dock chrome (active dot +
capture button) only.

| Screen | The one accent | Demoted to lit-ink / neutral |
| --- | --- | --- |
| Home | Hero needle + redline + reserve caption | Sub-dial lit ticks, macro microbars |
| Diary | Day-total track fill | Week-rail goal pips (no glow); ghost-CTA plus stays (primary action) |
| Trends | Weight endpoint dot (+ over-budget bars — semantic) | Streak/sleep hit cells (lit-ink @ .55); weight delta is ink, accent/danger only when moving away from goal |
| More | Whisper of orange lume behind the avatar well | Everything else; teal strictly for status badges |

Semantic danger does not count against the budget but must stay calm.

## Edge states (Home)

- **Over budget**: needle rests pinned in the redline; center reads `+N` with caption
  "kcal over budget", both in muted `danger`, lume off, no ignition/odometer theatrics,
  no pulsing. Calm, never scolding.
- **Empty morning**: gauge full at rest; the log area shows a 64pt circular inset
  camera tile — "No meals logged yet / The gauge is full and waiting." Inviting,
  never guilt-framing.
- "≈ Portion is a guess" is a **trust disclosure**: ≥11px sentence case with the ≈
  mark — never 9px engraved styling.

## Per-screen contracts

- **Home**: header (greet + largeTitle + bell/avatar) → BezelCluster [gauge → zone-rule
  "Macros" → 3-cell sub-dial rail (lit-ink) with microbars + "Ng to go" → recessed
  vitals well] → "Logged today" hairline list → dashed ghost CTA.
- **Diary**: largeTitle → week rail (bezel capsule, 7 cells ≥44pt — verify on iPhone SE;
  selected sinks into a well; 4px lit-ink goal pips) → BezelCluster [day-total numeral +
  animated 6px track → water well with +250/+500 pills] → meal log **outside** the
  cluster as zone-ruled hairline slots with subtotals → ghost "Add dinner · N kcal in
  reserve" → "Copy yesterday's meals" link row.
- **Trends**: ScreenHeader (overline) → BezelCluster [weight 34px mono + directional
  delta + self-drawing line chart (draw-in ~1.1s, lume endpoint) + segmented 1W/1M/3M/1Y] →
  glass panel [energy bars growing staggered from baseline, dashed budget line, legend] →
  duo tiles [streak cells / avg sleep].
- **More**: ScreenHeader → bezel identity hero (avatar well with orange lume whisper) →
  engraved group labels over glass row panels [34px recessed icon wells + label +
  badge/chevron] → danger sign-out → engraved mono version line.
- **Typography**: numerals always Menlo/tabular; engraved labels 10px/ls1.5, ~4 per
  screen; Dynamic Type capped at 1.3–1.6 on micro-labels, never disabled; gauge overlay
  needs overflow clearance at large sizes.

## Feasibility decisions (binding, from RN review)

- **No `@shopify/react-native-skia`.** The only effect that wanted it (conic bezel)
  is replaced by the linear rim. Everything builds on Reanimated + react-native-svg +
  expo-blur + expo-linear-gradient.
- Lume text glow requires layering glowing numerals outside `GlassPanel`'s clipped
  blur container (or interior padding clearance) — resolve before rolling glow out.
- One fused BlurView beats six small ones for compositing, but cap any cluster below
  ~one screen height and profile scrolling on device (iPhone 17 Pro Max simulator).
- Keep `FloatingTabBar`'s architecture (raised sibling FAB, `pointerEvents="box-none"`)
  when reskinning; check gauge/instrument motion tests before touching springs.

## Component breakdown (build order)

| Component | Effort | Notes |
| --- | --- | --- |
| BezelCluster primitive + lume clipping fix | M | shared foundation — build first |
| Dock v2 restyle (sliding well, labels, FAB) | M | restyle of FloatingTabBar, same architecture |
| Ignition sequence + once-a-day gating | M (→S) | S if an AnimatedNumber primitive exists |
| Home recomposition + edge states | M | cluster, odometer, refresh sweep |
| Diary (rail + day cluster + split log) | M | list-cardinality decision already made |
| Trends restyle | S–M | EnergyBars / SegmentedGlass / StreakCells ~70–80% reusable |
| More restyle | S | layout only |
| Screen transitions + haptics pass | S | cross-cutting, last |
