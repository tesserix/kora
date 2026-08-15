# Gauge, Lume & Motion — the Ignition wow, kept classy

## Design Decisions
- **The gauge itself is untouched**: geometry stays exactly as
  `src/components/instrument/gauge.ts` (264×178, 230° sweep, 41 ticks, redline > 0.9,
  needle accent, hub 4.5). The redesign only changes its housing and adds motion/light.
- **Ignition sequence** (the signature moment): needle sweeps to full redline
  (~0.65s ease-in), then settles back to the real value with a slight overshoot
  (~0.95s), while the reserve numeral counts down from the full budget (~1.65s
  cubic ease-out). **Production contract: plays ONCE PER DAY** (persisted flag, first
  cold launch); every other visit uses the existing critically-damped settle.
  This gating was the UX review's #1 finding — do not ship without it.
- **Two named springs, never one.** Keep `NEEDLE_SPRING {damping:30, stiffness:250}`
  (no overshoot) for ALL data-driven updates; add a separate underdamped ignition
  spring (~`{damping:12, stiffness:180}`) used only by the once-a-day sequence.
- **Lume glow** = watch-dial warmth, not neon: reserve numeral text glow
  (`--lume-text`), accent caption glow (`--lume-accent`), needle glow (duplicate
  blurred SVG line underneath in RN — no filter support). Lume text glow is
  disabled in light mode. RN caveat: GlassPanel's `overflow:hidden` clips large
  text-shadow radii — layer glowing numerals outside the clipped blur container
  or pad the interior.
- **One-time specular sweep** across the cluster glass on entry (diagonal highlight
  band, translateX −110%→110%, 1.6s). RN: expo-linear-gradient in an Animated.View,
  pointerEvents none.
- **Motion echoes per screen**: Diary day-total track fills on entry; Trends weight
  line draws in (stroke-dashoffset) with a lume endpoint; energy bars grow staggered
  from the baseline. All respect prefers-reduced-motion (instant apply).
- **Sub-dials light in lit-ink, NOT accent** (post-review): four gauge-shaped arcs
  on Home would otherwise compete; orange belongs to the hero needle alone.
- **Haptics** (review addition, not in mockups): impactLight on ignition settle and
  water pills; selection on week-rail day taps.

## Key values
```js
// ignition (mockup reference)
needle: 0->230deg .65s cubic-bezier(.5,0,.6,1), then ->target .95s cubic-bezier(.22,1.4,.36,1)
countdown: goal -> remaining over 1650ms, ease-out cubic
specular: translateX(-110%)->(110%), 1.6s cubic-bezier(.4,0,.2,1), delay .5s, once
entrance stagger: FadeInDown equivalent, .45s, delay i*60ms
```

## What to Avoid
- Replaying ignition on every tab focus (fatigue at 10–20 opens/day).
- Changing NEEDLE_SPRING or reintroducing overshoot into ordinary needle motion.
- "Redline"/"ignition" language in any user-facing copy or notifications — the
  metaphor stays purely visual (food-anxiety sensitivity).
- Skia for any of this — everything builds on Reanimated + react-native-svg +
  expo-linear-gradient (see sources/REVIEW-ignition.md).

## Origin
Sketch 001 variant D (winner); RN feasibility + UX reviews in sources/REVIEW-ignition.md.
