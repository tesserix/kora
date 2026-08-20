---
quick_id: 260820-idt
slug: instrument-dynamic-type
date: 2026-08-20
refs: kora#268, kora#284, kora#261, kora#270, kora#257
status: complete
---

# One Dynamic Type rule for instrument SVGs — done

Scale the **rendered** `width`/`height` of an instrument `<Svg>` by
`clamp(fontScale, 1, cap)` and leave the `viewBox` alone. Floored at 1, so
`medium` is unchanged; capped by available width, so it cannot overflow. No tick,
needle worklet or anchor moved — a pure vector scale, not a geometry rework.

## What shipped

| | |
|---|---|
| `27ee41a6` | `gauge.ts` — `instrumentScale`, `overlayBudget`, `overlayStack`, `captionFitsInFace` as exported pure functions |
| `8e69110b` | `PlanDelta` reserves its line |
| `67b12651` | `PlanDial` scales, bounded by an optional `maxHeight` |
| `20e8d964` | `GaugeDial` scales; caption ejects below the face when it stops fitting |
| `fa5bbaf1` | `AuthScaffold`/`onboarding` — header scrolls above fontScale 1.3 |

1882/1882 tests green. Zero `tsc` errors in source (all remaining are in the
generated `.expo/types/router.d.ts` — kora#157, pre-existing).

## Two arithmetic corrections made during the work

**The plan's "1.34 clawback on a 393pt device" was wrong.** `393/264 = 1.4886`,
where the caption *fits* by 0.15pt. 1.34 came from a padded content width
reported as a screen width.

**The follow-up correction was also incomplete.** It put Home's available width
at 361pt (`393 - 32`). The real chain is `paddingHorizontal: 16` (-32),
`BezelCluster`'s `RIM_INSET` (-3), `GlassPanel`'s hairline (-0.67), **and a
second `padding: 16` on the hero card's inner View** (-32) = **325.3pt**.

Consequence: break-even needs 392.5pt of *available* width, i.e. a ~460pt
screen. **No shipping iPhone has one.** The ejected branch is the only branch any
real device takes at accessibility sizes — margin 18.8pt, not a hairline. The
non-ejecting branch is live code but unreachable through Home's chrome.

## Verified on device

iPhone 17 Pro Max, iOS 26.2, dev client on Metro :8081, clock pinned to
2026-08-19T09:41:00.

- **`sign-in` maxD 0 at `medium`** - the floor-at-1 property, and proof
  `AuthScaffold`'s headerless path is untouched.
- **`onboarding` at `medium`**: the dial hub sits at golden y=207 and "1957" at
  y~262 in both old and new captures, so the dial does not scale at the default
  size. Everything below shifts down ~16pt — one caption line, the `PlanDelta`
  reserve, and nothing else. Golden re-captured
  (`shots-golden/medium/onboarding.png`); re-ran and both routes reproduce at
  maxD 0, so it is stable, not a lucky frame.
- **`onboarding` at `accessibility-extra-large`**: the dial is visibly larger
  than at `medium` — the hierarchy no longer inverts, which is kora#284's first
  half.
- **The header genuinely scrolls.** `idb ui describe-all` puts "1957" at y=330;
  after one swipe it is at **y=-650** and the Age/Height/Weight rulers are on
  screen. kora#284's second half works as designed.

## Open — first paint at AX is not what the decision's diagram implied

The option that was chosen was illustrated with the rulers **visible at scroll
offset 0**. They are not. The header renders at full size on first paint and only
*becomes reachable* by scrolling; the mechanism is right, the diagram oversold
the outcome.

Measured, this is not fixable by capping the dial. At AX the fold is at y=956 and
the first ruler's slider starts at y=943 with the header ending at ~y=510.
Capping the dial back to its design 178pt saves 86pt; reaching the ruler needs
~150pt. At this text size the screen cannot show both the instrument and a ruler
— dropping the dial entirely was offered and declined. What the fix does buy is
the full viewport for controls after one swipe, instead of the cramped fixed
window the sticky header left.

## Not verified — the auth wall

`tab-today` (the `GaugeDial` screen, which is what kora#268 is actually about)
**lands on the sign-in wall**; the harness does not script sign-up and refuses to
diff an unauthenticated capture. So the caption-ejection path has **not been seen
on a device** — it is verified only at the prop level.

Sign in by hand on the simulator and run:

```
EXPO_PUBLIC_SHOTS_CLOCK=2026-08-19T09:41:00 \
  node scripts/shots.mjs --routes tab-today --content-size accessibility-extra-large
```

Check on a **fresh launch** (Fast Refresh corrupts font-metric measurements on
this component) that the ejected caption sits below the face, the numeral is
still centred, and the hub dot is clear of the text.

Also still unverified: `CAPTION_LINE_RATIO = 1.7` is an estimate of RN's default
leading, and the entire fit predicate rests on it. And `PlanDelta`'s worst-case
string is chosen by character count, a proxy for width — if it is ever wrong the
failure is an overlap, not a shift.
