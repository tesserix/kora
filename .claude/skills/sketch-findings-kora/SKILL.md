---
name: sketch-findings-kora
description: Validated design decisions, CSS patterns, and visual direction from the Ignition redesign sketches. Auto-loaded during UI implementation on Kora mobile.
---

<context>
## Project: kora (apps/mobile — React Native/Expo, iOS-first)

"Ignition" — an evolution of the existing Instrument Glass language that fixes panel
monotony. Everything token-level stays: dark-first, ground #0B0D10, warm-lume ink
#EDE6D4, orange accent #FF4A00 (dark) / #D23800 (light), Menlo tabular numerals,
engraved micro-labels, and the 230° meter gauge untouched. What changed: panels fuse
into ONE bezel-grade instrument per screen with engraved zone rules and recessed
wells; the wow lives in motion and light (once-a-day ignition sweep, watch-dial lume,
specular sweep), never decoration. Reference cues: automotive/aviation instrument
clusters, watch dials. Reviewed by UX + RN-feasibility specialist agents; the
combined contract is in sources/REVIEW-ignition.md and is binding.

Sketch sessions wrapped: 2026-08-16
</context>

<design_direction>
## Overall Direction

- Hierarchy: one bezel cluster per screen; secondary content on lighter sheened glass;
  lists are card-free hairline rows. Clusters wrap only fixed-cardinality content.
- Material: two-stop linear bezel rim (NO conic — RN constraint), radial top sheen on
  glass, inset+hairline recessed wells (never true inset shadows), radius ladder
  28→22→18→10.
- Motion: ignition sequence once per day then calm critically-damped settles; per-screen
  entry echoes (track fill, chart draw-in, bar growth); full reduced-motion coverage;
  two named needle springs (never change NEEDLE_SPRING).
- Accent: one hero orange moment per screen + dock chrome; sub-dials, pips, streak
  cells all demoted to lit-ink. Teal = status only. New finish tokens: shade,
  well-shadow, lume-text, lume-accent (distinct light-mode values; lume-text off in light).
- No new dependencies: build on Reanimated + react-native-svg + expo-blur +
  expo-linear-gradient. Skia was evaluated and rejected.
</design_direction>

<findings_index>
## Design Areas

| Area | Reference | Key Decision |
|------|-----------|--------------|
| Material & Panels | references/material-and-panels.md | One bezel cluster per screen; linear rim; inset+hairline wells; light-mode finish values |
| Gauge & Motion | references/gauge-and-motion.md | Once-a-day ignition; two needle springs; lume rules; specular sweep; haptics |
| Dock Navigation | references/dock-navigation.md | 58px bezel capsule; always-on labels; raised (not notched) capture button |
| Screens & Accent | references/screens-and-accent.md | Per-screen layout contracts + hardened one-accent-per-screen budget |

## Theme

The winning theme tokens are at `sources/themes/default.css` (mirrors palette.ts plus
the four new Ignition finish tokens to port).

## Source Files

Interactive mockups preserved in `sources/` — 001 (Home variants; D ★ winner) and
002 (Home/Diary/Trends/More post-review). Specialist review: `sources/REVIEW-ignition.md`.
Published: 001 https://claude.ai/code/artifact/28bd3a5a-3a43-4aed-b819-6961414d9607 ·
002 https://claude.ai/code/artifact/be0b7577-fe7a-4371-b33e-58f54fcb51af
</findings_index>

<metadata>
## Processed Sketches

- 001-home-instrument-panels (winner: variant D "Ignition")
- 002-ignition-screens (post-review contract, all four main screens)
</metadata>
