# Screen Layouts & Accent Budget

## The accent rule (hardened post-review)
The spec's "one accent per view" collapsed under real data in the first mockups
(Diary hit 7–8 concurrent oranges, Trends 16+). The enforced contract is now:
**one hero accent moment per screen**; persistent chrome (dock dot, capture button)
is the only other orange allowed.

| Screen | The one accent | Explicitly demoted to lit-ink/neutral |
|--------|----------------|----------------------------------------|
| Home | Hero gauge needle + redline + reserve caption | Sub-dial lit ticks, macro microbars |
| Diary | Day-total track fill | Week-rail goal pips (no glow), ghost-CTA plus stays (primary action) |
| Trends | Weight endpoint dot (+ over-budget energy bars — semantic warning) | Streak/sleep hit cells (lit-ink @ .55), weight delta (ink; accent/danger only when moving AWAY from goal) |
| More | Whisper of orange lume behind the avatar well | Everything else; teal strictly for status badges |

## Edge states (Home)
- **Over budget**: needle pinned in redline, `+N` reserve numeral + "kcal over budget"
  caption both in muted danger (lume off) — the only place danger appears on Home.
  Semantic danger does not count against the accent budget but must stay calm.
- **Empty morning**: gauge full at rest; log area shows the circular inset camera
  tile empty state — inviting, never guilt-framing.

## Tab-switch transition
Screen changes ride the dock slide: incoming screen fades in drifting 16px from the
direction of travel (~280ms ease-out), fired just after the dock well starts moving
(~160ms stagger) so dock + content read as one gesture. Reduce Motion: instant swap.

## Per-screen layout contracts
- **Home**: header (greet + largeTitle "Today" + bell/avatar) → BezelCluster
  [engraved "Energy reserve" + gauge → zone-rule "Macros" → 3-cell sub-dial rail with
  microbars + "Ng to go" → recessed vitals well (steps/sleep)] → "Logged today"
  hairline list (60px mono time / name+slot / kcal) → dashed ghost CTA "Log a meal".
- **Diary**: largeTitle → week rail (bezel capsule, 7 cells, selected sinks into well,
  4px goal pips; cells ≥44pt — verify on iPhone SE) → BezelCluster [day-total
  numeral + animated 6px track → recessed water well with live +250/+500 pills] →
  meal log OUTSIDE the cluster as zone-ruled hairline list per slot with subtotals →
  ghost "Add dinner · N kcal in reserve" → "Copy yesterday's meals" link row.
- **Trends**: ScreenHeader (overline "Last 30 days") → BezelCluster [Weight: 34px mono
  figure + delta + self-drawing line chart + faint grid + segmented 1W/1M/3M/1Y
  (ink pill selected)] → glass panel [Energy vs budget bars + dashed budget line +
  3-item legend] → duo tiles [Logging streak cells / Avg sleep].
- **More**: ScreenHeader (overline "Your account") → bezel identity hero (56px avatar
  well + name + mono email) → engraved group labels ("Tracking", "Data & support") over
  glass panels of rows [34px recessed icon well + 15px label + badge/chevron] →
  danger sign-out panel → engraved mono version line.

## Typography & scaling contract
- Numerals always Menlo/tabular. Engraved labels 10px/ls1.5 uppercase, budget ~4 per screen.
- Dynamic Type: cap micro-labels with maxFontSizeMultiplier 1.3–1.6, never disable
  scaling; give the gauge overlay overflow clearance at large sizes.
- "≈ Portion is a guess" is a TRUST DISCLOSURE: ≥11px sentence case with the ≈ mark —
  never 9px engraved styling.
  **OPEN DEBT (final review 2026-08-16):** still rendered 9px/uppercase/engraved at
  index.tsx meal rows, MealRow.tsx, meal.tsx, DetectedCard.tsx, RecipeParseSheet.tsx —
  pre-existing, deliberately left out of the Ignition branch's scope. First UI pass that
  touches any of these files must apply this contract.

## What to Avoid
- Everything-in-one-cluster Diary (rejected); equal-thirds macro cards; orange goal
  pips/streak cells; accent-colored positive weight deltas; real personal data in
  fixtures; emoji as production icons.

## Origin
Sketch 002 (post-review contract) + sketch 001 variant D; review in sources/REVIEW-ignition.md.
