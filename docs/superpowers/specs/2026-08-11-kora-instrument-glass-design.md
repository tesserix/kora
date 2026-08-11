# Kora Instrument Glass — design language and screen uplift

**Date:** 2026-08-11
**Status:** Approved direction (prototype rounds 1–2 signed off)
**Prototypes:** claude.ai artifacts "Kora — Instrument Glass, five screens" (five-screen prototype with light/dark toggle) and "Kora — brand mark" (dial-K brand board)
**Brand:** dial-K mark shipped on `feat/brand-dial-k` (`assets/brand/`, `BrandMark.tsx`)

## Direction

Kora's visual language is **Instrument Glass**: chronograph-grade precision (tick
gauges, needles, tabular mono numerals, engraved labels) rendered in Liquid
Glass material (translucent blurred panels floating over faint ambient light
pools). Your body is a machine you monitor; the app is its instrument panel.

Explicitly rejected: the old iris/OKLCH design system (deleted), the dot-grid
brand (replaced), editorial/serif directions, and any purple.

## Tokens

One token set, two themes. The app today ships dark-only
(`userInterfaceStyle: "dark"`); this uplift adds the light theme and switches
to `"automatic"`.

### Color

| Token | Dark | Light | Role |
| --- | --- | --- | --- |
| `bg` | `#0B0D10` | `#ECEDEF` | screen ground under the pools |
| `ink` | `#EDE6D4` (lume) | `#16181C` | primary text and lit gauge elements |
| `mut` | `#89929D` | `#6D7580` | secondary text, unlit labels |
| `glass` | `rgba(24,28,35,0.55)` | `rgba(255,255,255,0.60)` | panel fill over blur |
| `glassBorder` | `rgba(237,230,212,0.10)` | `rgba(255,255,255,0.85)` | 1px panel border |
| `glassHighlight` | `rgba(237,230,212,0.07)` | `rgba(255,255,255,0.95)` | inset top edge ("light catching the material") |
| `inset` | `rgba(11,13,16,0.50)` | `rgba(255,255,255,0.40)` | recessed wells (track backgrounds, steppers, glyph tiles) |
| `hairline` | `rgba(237,230,212,0.08)` | `rgba(22,24,28,0.09)` | row separators |
| `tick` | `rgba(237,230,212,0.15)` | `rgba(22,24,28,0.14)` | unlit gauge ticks |
| `tickLit` | `#EDE6D4` | `#16181C` | lit gauge ticks |
| `accent` | `#FF4A00` | `#FF4A00` | THE accent (see rules) |
| `accentOn` | `#0B0D10` | `#FFFFFF` | text/icon on accent |
| `danger` | `#E23B2E` | `#D32F23` | destructive only |
| `teal` | `#48A89E` | `#48A89E` | ambient pool + rare secondary data series only |

Ambient pools (behind everything, never behind long text):
- Dark: orange `rgba(255,74,0,0.08–0.10)` upper-left, teal `rgba(72,168,158,0.07–0.09)` mid-right, warm `rgba(255,148,80,0.06)` bottom.
- Light: same hues at `0.12–0.16`.
- Static — no animation, no parallax. Implemented as SVG radial gradients in `AppBackground`.

**Accent rules (hard):** orange appears only as: gauge needle + hub, over-budget
/ redline state, primary CTA, active-tab dot, streak-hit cells, "to go" emphasis.
Never decorative, never on more than one competing element per view. No purple
anywhere. No green as brand (functional success states may keep the palette's
existing green until redesigned, but no new green).

### Type

- **UI face:** system (SF Pro). Large titles 26–34 bold, tight tracking; body 14–15; labels 13.
- **Data face:** the platform monospaced face (SF Mono via `Platform.select`), `fontVariant: ["tabular-nums"]` for every numeral that can change — kcal, grams, steps, times, deltas. Numerals are the brand's voice.
- **Engraved labels:** 9–11px, uppercase, letter-spacing 0.14–0.26em, `mut` color. Used ONLY where an instrument would engrave a label (gauge captions, slot names, stat units). Everything else is sentence case — max ~4 engraved labels visible per screen.

### Shape and material

- Panel radius 20–24; hero dial 24; pills/chips 14–18; tab bar 32.
- Glass panel recipe: `expo-blur` BlurView (intensity ~25 dark / ~40 light, tint matching theme) + `glass` fill + 1px `glassBorder` + inset top highlight + soft shadow. One elevation level — no stacked glass on glass.
- Reduced transparency (`AccessibilityInfo.isReduceTransparencyEnabled`): swap BlurView for opaque `bg`-derived card color.
- Dark capture screen is exempt from theming: camera surfaces are always dark.

### Motion

- Springs only, `react-native-reanimated`: damping ratio 1.0 default, response ~0.35; bounce (~0.8) reserved for flick/momentum gestures.
- Gauge needle and lit-tick fill animate on data change from the *current* value (interruptible; no re-stagger on refetch — keep the existing first-mount-only entrance pattern).
- Haptics (`expo-haptics`): selection on tab/segment, light impact on log confirm, success notification on goal hit. Nothing else.
- `prefers-reduced-motion`: entrance staggers and needle sweeps become cross-fades.

## Signature components

New or rebuilt in `src/components/` (kebab of existing names kept where the file already exists):

1. **`GaugeDial`** (replaces `GaugeRing` usage on Home) — the hero. 230° arc (−205°→+25°), 41 ticks (major every 5th), lit up to `value/target`, dimmed past; redline ticks in last 10% tinted accent; orange needle + hub; scale numerals 0 / half / target; center numeral + engraved unit; footer row (Eaten / Burned / Budget). SVG, same geometry constants as `BrandMark`.
2. **`SubDial`** — 270° micro-gauge (24 segments) used for macros and capture confidence. Props: `fraction`, `size`.
3. **`GlassPanel`** — the material wrapper (blur + fill + border + highlight + shadow, reduced-transparency fallback). Every card below uses it.
4. **`TeleStrip`** — single divided strip for steps + sleep (replaces two symmetric cards).
5. **`MacroWide`** — protein's full-width card: SubDial + value + progress bar + "Ng to go". Carbs/fat stay compact `SubDial` cards (deliberate asymmetry).
6. **`GlassTabBar`** (evolves `FloatingTabBar`) — glass pill, engraved tab labels with accent active dot, center orange capture button. Tabs renamed: Today / Diary / (+) / Trends / More.
7. **`StreakCells`** — 7-cell streak row (accent = hit), used on Trends.
8. **`EnergyBars`** — 7 bars vs dashed target line; in-budget bars `tickLit` at 72%, over-budget accent.

## Screens (scope of the uplift)

Per the approved prototype. All five keep their existing data hooks and routes —
this is a presentation-layer rebuild.

1. **Home (`(tabs)/index.tsx`):** header (date/greeting, sentence case) → `GaugeDial` hero → `MacroWide` protein → carbs/fat `SubDial` pair → `TeleStrip` → "Logged today" section label (14px semibold + hairline) with meal rows (mono time, name, slot, mono kcal). Saved/pinned/usual strips restyle onto `GlassPanel`s.
2. **Diary (`(tabs)/diary.tsx`):** week strip with goal-hit pips (selected day = glass cell), day-total readout with track bar, meals grouped by slot in `GlassPanel`s, dashed "Add dinner · N kcal in reserve" ghost slot.
3. **Capture (`capture.tsx`):** always dark. Lume reticle corners + accent scan line over the viewfinder, glass mode chips (Scan/Barcode/Describe), detection card = `GlassPanel` with confidence `SubDial` + "Log it" accent button, existing capture flow untouched.
4. **Trends (`(tabs)/progress.tsx`):** rename tab to Trends; segmented Week/Month/6M in glass; Weight panel (mono headline, accent delta, accent sparkline with end dot); `EnergyBars` panel with legend; protein-goal + avg-sleep `StreakCells` duo.
5. **Meal detail (`meal.tsx`):** provenance chips first (source + grams), kcal hero numeral panel ("N% of today's budget"), macro bars (engraved label / inset track / mono value), portion stepper panel, one accent primary ("Looks right — keep it"), Edit/Duplicate/Delete glass actions (Delete in danger).

Out of scope for this uplift (follow-up passes): onboarding/sign-in, social
(groups/friends/challenge), settings/profile/reminders/notifications screens,
widgets (already specced separately), generated Higgsfield illustration
integration (empty states/onboarding art).

## Theme plumbing

- `palette.ts` gains the token table above (keep existing semantic keys working during migration; add `instrument` namespace rather than break 40+ call sites at once).
- `app.json` `userInterfaceStyle` → `"automatic"` in the final task, after every in-scope screen passes light-mode review. Capture opts out via a fixed dark token set.
- The old green `primary` stays only as a deprecated alias until the last in-scope screen migrates; new code uses `accent`.

## Error handling / a11y (unchanged behaviors, restated as gates)

- Every numeral that updates uses tabular nums (no layout shift).
- Contrast: `ink` on `glass`-over-pools ≥ 4.5:1 in both themes (checked at the reduced-transparency fallback too).
- Reduce Motion and Reduce Transparency honored as specified above.
- Touch targets ≥ 44pt including tab bar and stepper.

## Testing

- Component tests per signature component (geometry pins like BrandMark's: tick counts, lit boundary, redline classing, accent-only-on-needle).
- Existing screen tests keep passing with updated testIDs/queries; no data-flow tests change.
- Manual gate per screen: iPhone 17 Pro simulator screenshot review, both themes, Reduce Transparency on/off.
