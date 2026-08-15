# Sketch Wrap-Up Summary

**Date:** 2026-08-16
**Sketches processed:** 2 (both included)
**Design areas:** Material & Panels · Gauge & Motion · Dock Navigation · Screens & Accent
**Skill output:** `./.claude/skills/sketch-findings-kora/`

## Included Sketches
| # | Name | Winner | Design Area |
|---|------|--------|-------------|
| 001 | home-instrument-panels | D: Ignition | Material, Gauge & Motion, Dock |
| 002 | ignition-screens | post-review contract | Screens & Accent |

## Excluded Sketches
None. (Sketch 001 variants A–C preserved in the source file as rejected references;
variant B "Editorial hairline" was explicitly rejected by the user.)

## Design Direction
Ignition: the Instrument Glass tokens and the meter gauge stay untouched; panel
monotony is replaced by one bezel-grade fused instrument per screen, engraved zone
rules, recessed wells, and wow delivered through motion and light (once-a-day
ignition sweep, lume, specular pass). Specialist-reviewed (UX + RN feasibility);
binding contract in REVIEW-ignition.md.

## Key Decisions
- Linear (not conic) bezel rim; no Skia dependency
- One hero accent per screen; sub-dials/pips/streak cells in lit-ink
- Ignition gated to once per day; NEEDLE_SPRING untouched; second ignition spring
- Dock v2: 58px bezel capsule, always-on labels, raised capture button (no notch ring)
- Clusters wrap fixed-cardinality content only; meal logs stay hairline lists
- New finish tokens (shade / well-shadow / lume-text / lume-accent) with light-mode values
- Dynamic Type caps on micro-labels; "≈ Portion is a guess" promoted to 11px disclosure
