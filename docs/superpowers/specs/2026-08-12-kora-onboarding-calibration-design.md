# Kora onboarding — Calibration

**Date:** 2026-08-12
**Status:** Approved direction
**Prototype:** claude.ai artifact "Kora Onboarding Calibration" — the screen built live, drag-to-set
**Supersedes for onboarding:** the deferral in `2026-08-11-kora-instrument-glass-design.md` ("Out of scope for this uplift: onboarding/sign-in")

## Problem

Onboarding is the last surface still running the legacy iOS palette — `primary
#34C759` on an `#F2F2F7` ground with stock cards — while every other in-scope
screen has moved to Instrument Glass. That is the whole of the "looks like every
other app" complaint.

The structural problem is larger. `onSubmit` mutates and calls
`router.replace("/")`. The targets are computed server-side, returned in the
`Profile` response, and thrown away. The user answers six questions and lands on
Home governed by four numbers they were never shown and never agreed to.

There is also no destination. `goalAdjustments` hardcodes `−500` kcal for every
user pursuing fat loss regardless of body size or ambition, and there is no goal
weight and no pace. A plan without a date is a preference.

## Direction

**Calibration.** One continuous screen with a live target readout pinned above
it. Every answer visibly moves the number. Trust is demonstrated rather than
asserted: the target is credibly yours because you watched it respond to you.

Two rejected alternatives, both prototyped:

- **Wizard then reveal** — discrete steps ending in a full-screen plan reveal.
  Cheaper and lower-risk, but trades continuous proof for a single withheld
  moment. Kept as the documented fallback if the pinned readout proves
  unworkable at 375pt.
- **Conversational intake** — Otto asks, plan arrives as a chat card. On-message
  for the product but fights the design language, and free-text intake means
  parsing "84 now, 78 would be great" reliably enough to build a plan on. Its
  good half survives as milestone 2 below.

## Milestone 1 — the calibration flow

### Screen structure

`app/onboarding.tsx` becomes a single scrolling screen. The `step` state and the
`BackHandler` interception are both deleted — there is nothing to step back to.

**Pinned panel** (~200pt, collapsing to ~92pt on scroll): `PlanDial`, the kcal
numeral in the mono data face, and the delta line. The collapsed state keeps the
numeral and drops the dial.

**Every ordinal input is the same instrument.** The screen is a control panel,
not a questionnaire: `TickRuler` in continuous mode carries the numbers, and in
detented mode carries the labelled choices. Stacked icon-plus-subtitle cards —
the pattern every competing tracker ships — leave this screen entirely. That is
what lets all seven inputs share a viewport with the number they move, and that
adjacency is the whole argument for the direction.

**Scroll contents, in order:**

1. **Goal** — detented ruler, three stops ordered Lose → Maintain → Build so
   Maintain sits at the centre detent. The ordering is load-bearing: the scale
   runs deficit through zero to surplus, which is exactly what the adjustment
   row computes.
2. **You** — sex chips, then continuous rulers for age, height and weight. The
   Apple Health offer stays where it is. Age replaces birth year, since a ruler
   of years-old is legible where a ruler of calendar years is not.
3. **Activity** — detented ruler, five stops. `ActivityFromHealth` logic
   untouched.
4. **Destination** — continuous ruler for goal weight, detented ruler for pace
   (0.25 / 0.5 / 0.75 / 1.0 kg per week), arrival date computed live. Hidden
   entirely when goal is `maintenance`, where neither input has meaning.
5. **Derivation** — resting burn → ×activity → pace adjustment → target. Always
   visible, always current.
6. **Accept** — "Start with this plan" (primary) and "Ask Otto about this plan"
   (ghost; until milestone 2 lands it reads "Adjust the numbers myself" and
   reveals inline kcal and protein steppers floored at resting burn).

Each detented ruler is followed by one caption line describing the *selected*
stop — "Desk job, little walking" for Sedentary. The per-option subtitles the
old cards carried are real explanatory value and cannot simply be dropped, but
showing only the line that applies reads better than five competing.

**Sex is deliberately not a ruler.** A meter implies positions between its ends,
and Mifflin-St Jeor's sex term is a binary coefficient — `+5` against `−161`,
with nothing in between. It stays a chip pair, which gives the panel a rule
worth more than uniformity: **meters for things on a scale, chips for things
that are a set**, so the control type itself tells the user something true about
the choice. The two existing options are unchanged, and no third is added — the
formula has no neutral coefficient to compute one with.

Nothing submits until accept is tapped.

### Data and API

`goal_weight_kg` and `pace_kg_per_week` join `OnboardingInput` (TS), the Go
`Input` struct, and `user.OnboardingFields`. Both are optional and ignored when
goal is `maintenance` — the server must not require fields the UI never showed.

`goalAdjustments`' `−500 / 0 / +300` map is replaced:

```
adjustment = ±(pace_kg_per_week × 7700) / 7      // kcal/day
kcal       = max(bmr, tdee + adjustment)          // floor: never below resting burn
```

The floor is safety-critical: a 52 kg user choosing 1 kg/week would otherwise be
handed roughly 1,050 kcal. Pace is additionally capped at 1% of bodyweight per
week at the validator, so the floor is a backstop rather than the primary
defence.

Persisted and returned on `Profile`: `goal_weight_kg`, `pace_kg_per_week`, and a
derived `target_date`.

**Formula duplication.** The live readout cannot round-trip per keystroke, so
Mifflin-St Jeor moves into `apps/mobile/src/lib/plan.ts` — the same formula in
two languages. It is kept honest by a shared golden-vector fixture (~20
input→target cases) asserted by both `calc_test.go` and `plan.test.ts`: either
implementation changing alone turns the other red. The server remains
authoritative — its response on accept overwrites the displayed plan, and a
mismatch beyond ±1 kcal is logged as drift.

**Age, not birth year.** The UI collects age in years because a ruler of
years-old is legible where a ruler of calendar years is not. The wire format is
unchanged — `birth_year` is derived at submit as `currentYear − age`, keeping
`Input`, the stored column and `Calculate`'s existing age arithmetic untouched.

**Validation.** `validateOnboarding.ts` gains goal-weight range and direction
checks (a fat-loss goal weight above current weight is a contradiction). Server
validation mirrors it; the client copy exists for message quality, not trust.

### Components

**New — `TickRuler`** (`components/instrument/TickRuler.tsx`). The panel's
entire interaction language, in two modes.

*Continuous mode* — a vernier scale drawn to a fixed centre index, dragged under
a stationary mono numeral at roughly 0.1 kg per pixel with momentum. Tapping the
numeral opens number-pad entry for an exact value, so the drag is for exploring
and the field is for knowing. Sliders were rejected: a 35–180 kg range across
260pt is about half a kilo per pixel, which cannot set 84.

*Detented mode* — labelled stops with snap-to-settle and one haptic per detent
crossed. This also retires a known bug rather than working around it: the
comment in `onboarding.tsx` records that activity became cards *because* a
five-way `Segmented` divided its width equally and clipped "Sedentary" to
"Sedentar/y". A detented scale does not divide the available width — it extends
past both edges and moves — so label length stops being a layout constraint and
five stops cost no more than eight.

Both modes take `accessibilityRole="adjustable"` with `onAccessibilityAction`
increment/decrement, so VoiceOver sets a value without a drag gesture, and both
honour reduce-motion by snapping instead of settling. Seven instances on the
screen; this is the largest single piece of new build in milestone 1.

**New — `PlanDial`** (`components/instrument/PlanDial.tsx`). `GaugeDial` is a
*progress* instrument: value eaten against budget, with an Eaten/Burned/Budget
footer. Onboarding shows no progress — it shows a setting on a scale. `PlanDial`
places the needle on a fixed 1,200–3,600 kcal scale so an activity change sweeps
the needle rather than nudging a fill. Imports geometry from the shared
`instrument/gauge.ts` so both instruments read as one panel. No footer row, no
burned input.

**New — `PlanDelta`.** The "+240 kcal from that change" line. Its own component
because it carries the direction's thesis and needs its own tests: announces via
`accessibilityLiveRegion="polite"`, debounced ~600ms, silent on first mount.

**New — `DerivationChain`.** Four labelled rows, mono values, hairline
separators. Takes an optional `proposed` set and renders before → after. Built
with that shape in milestone 1 because it is also milestone 2's diff surface.

**Changed — `AuthScaffold`** gains an optional `header` slot, pinned above the
scroll and outside it, mirroring the existing `footer`. The `progress` rail is
retained for sign-in and unused by onboarding. Collapse is driven by scroll
offset, cross-fading the dial out; under reduce-motion it snaps.

**Migrated onto Instrument Glass:** `Field` (inset well, mono value, engraved
label), `Segmented` → the existing `SegmentedGlass`, `Button` primary → accent
orange. These are shared with sign-in, which carries that screen too — correct,
since it was deferred in the same sentence of the uplift spec. `SelectableCard`
is *not* migrated for this screen: onboarding stops using it altogether. It
remains in the codebase for other surfaces.

**Accent discipline.** One accent element per view: the needle and hub. The
primary CTA is the spec's documented exception. Selected cards use accent at low
opacity as a fill tint, not a competing solid. Everything else lit is `tickLit`.

**Reused unchanged:** `Stepper`, `ActivityFromHealth`, `GlassPanel`,
`AppBackground`.

### Error handling

- **Validation errors move inline**, under their field. With a scroll this long
  a single banner above the footer can leave a birth-year error off-screen. Only
  submit failures keep the banner, positioned with the accept button.
- **Offline is distinct.** The plan computes locally and renders with no
  network; accept cannot complete. `apiErrorMessage` already distinguishes
  causes and must not tell an offline user their details are wrong.
- **Incomplete input shows nothing, not zero.** Until sex, birth year, height
  and weight are all valid, `PlanDial` renders unlit with "Awaiting your
  numbers". A target from partial data is a lie, and `NaN` reaching the dial is
  a crash.
- **The clamp announces itself.** When `max(bmr, …)` binds, the target stops
  obeying the user — the one moment the panel's central promise breaks. Ignoring
  it silently would undo exactly the trust the flow exists to earn, so the delta
  line reads "held at your resting burn" and the destination caption switches to
  "target held at your resting burn, so expect slower than N weeks". The input
  is not reverted and no error is raised: the user asked for something the
  formula will not do, and is told so.
- **Drift is surfaced, not swallowed.** A server/client mismatch beyond ±1 kcal
  resolves to the server value silently in the UI and is logged. The number
  never changes under the user after they tap accept.

### Accessibility

- `PlanDelta` announces politely, debounced, silent on mount.
- The dial is `accessibilityElementsHidden`; the target is exposed once, as
  text, on the panel.
- Every ruler is `accessibilityRole="adjustable"` with increment/decrement
  actions and an `accessibilityValue` that reads the label, not the index —
  "Moderate", not "2". The `radiogroup` roles on goal and activity go away with
  the cards; the adjustable role replaces them.
- At accessibility Dynamic Type sizes the pinned panel keeps only the numeral
  and label, dropping the dial rather than compressing it.
- Reduce Transparency and reduce-motion paths already exist in `GlassPanel` and
  the motion layer; the collapse and needle sweep both honour them.

### Testing

- **Golden vectors** — shared JSON fixture asserted by `calc_test.go` and
  `plan.test.ts`. Load-bearing; everything else is ordinary.
- **Floor and cap** — small user at 1 kg/week clamps to resting burn, and the
  clamp copy appears; pace above 1% bodyweight is rejected at the validator.
- **`TickRuler`** — continuous mode clamps at both range ends, rounds to `step`,
  and accepts typed values that bypass the drag; detented mode settles to the
  nearest stop and never reports a fractional index. Increment and decrement
  accessibility actions move exactly one step in both modes.
- **`onboarding.test.tsx` is rewritten**, not amended — it asserts the two-step
  machine and the Android back interception, both deleted.
- **`PlanDelta`** — silent on mount, announces on change, debounces.
- **Maintain path** — destination section absent, adjustment row reads "Holding
  steady", server accepts a payload with no goal weight.

## Milestone 2 — Otto on the plan

Chat is a weak intake mechanism and a strong editing one: a stepper requires the
user to already know which knob to turn, and "this feels like too much" does
not. Deferred to its own milestone so an LLM call does not land on the most
abandonment-sensitive screen until the core flow is proven.

The ghost button becomes **"Ask Otto about this plan"**, opening a sheet with
the manual steppers at its foot — one place to go when you disagree. It opens
with three tappable openers, because a blank chat box at this moment yields
nothing: *"Feels too aggressive" · "Why this much protein?" · "I barely eat
carbs."*

**Otto returns one of three shapes, never prose that mutates state:**

- `explain` — answers, changes nothing.
- `propose` — a structured patch over a closed set (`pace`, `goal_weight`,
  `activity_level`, `kcal`, `protein_g`) plus one sentence of rationale.
- `refuse` — the request breaches the floor. Explains why, offers the nearest
  safe alternative, and is not negotiable by re-asking.

A proposal renders as a **diff** in `DerivationChain`, before → after, with the
pinned readout previewing it live. Accept or discard. Chat drives the panel the
user already trusts rather than asking for credibility of its own.

**Clamping is server-side and absolute** — floor at resting burn, pace capped at
1% bodyweight per week. The model proposes; the server decides. This is the
`guardrails` concern restated: a free-form chat attached to a calorie target is
structurally a machine for talking the app into a lower number, which is exactly
what the Protective policy exists to prevent.

**Reuse:** `ai.Provider`, `ai.Meter`, and the thread repository pattern.
**Not reusable:** `coach.Grounder`, which grounds on logging history that does
not exist during onboarding. Grounding here is the pending plan itself — the six
inputs and the four derived numbers.

## Out of scope

Post-onboarding first-run (empty states, first-capture prompt), sign-in copy
changes beyond the shared component restyle, and generated illustration
integration.
