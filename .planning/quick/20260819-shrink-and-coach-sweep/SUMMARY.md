---
quick_id: 260819-scs
slug: shrink-and-coach-sweep
date: 2026-08-19
refs: kora#173
---

# Summary — three shrink omissions, a wrapping tab label, and a coach-surface sweep

Tasks A–D are fixed and screenshot-verified at `medium` and
`accessibility-extra-large` on iPhone 17 Pro Max. Task E is an audit; its
findings are below and were deliberately NOT fixed.

Two of the four fixes needed a second attempt, because the first attempt was
measured and found wanting. Both are recorded here rather than smoothed over.

---

## Task A — `DerivationChain` value ran off-screen — FIXED

`src/components/instrument/DerivationChain.tsx:42-57`.

The label now carries `flexShrink: 1` and the value box `flexShrink: 0`. The
label is prose and wraps at a word boundary; the number can never split.

**Measured** (`scs/12-onb-axl-chain2.png`, AX-XL): "Activity-adjusted" wraps to
"Activity-" / "adjusted" and `2507 kcal` sits whole inside the right margin.
`medium` (`scs/08-onb-med-scrolled.png`) is one line per row, identical to the
pre-fix layout — `flexShrink` only engages under overflow.

## Task B — profile energy readout clipped — FIXED (second approach)

`app/profile.tsx:109-137`.

The first attempt used `flexShrink` on the unit, matching Task A. Measured on
the weight card below, that produced a MID-WORD break — "kg" rendered as "k" /
"g". A `flexShrink` box is allowed to narrow past the word it holds. Replaced
with `flexWrap: "wrap"` on the row and no shrink on either child, so the unit
moves to its own line whole and the numeral never splits.

**Measured** with the real 4-digit case (`scs/17-profile-axl-probe.png`, AX-XL,
values temporarily substituted because this account's targets are zero): `2507`
on one line, `kcal / day` whole on the next, nothing clipped. `medium`
(`scs/40-profile-med.png`) is baseline-identical to `fix/31-profile-bottom.png`
— same baseline row, same y positions.

## Task C — profile weight unit clipped — FIXED (second approach)

`app/profile.tsx:162-175`. Same `flexWrap` treatment, same reason.

**Measured**: `scs/15-profile-axl-weight.png` is the rejected `flexShrink`
attempt ("k" / "g"); `scs/16-profile-axl-wrap.png` and
`scs/17-profile-axl-probe.png` are the shipped one ("0.0" / "kg", "88.8" /
"kg"). `medium` unchanged.

Note on consistency: A uses `flexShrink`, B and C use `flexWrap`. That is
deliberate. A's compressible half is a multi-word prose label, where wrapping
inside the label is the right break. B and C's compressible half is a 2–10
character unit with no break point worth taking, so the row wraps instead.

## Task D — tab bar labels wrapped and clipped — FIXED (second approach)

`src/components/FloatingTabBar.tsx:107-152`, plus the comment rewritten to
match what actually ships.

The first attempt kept the fixed 52pt button and lowered the cap to 1.2 with
`numberOfLines={1}`. Measured (`scs/20-tabbar-axl.png`): no wrap, but "TRENDS"
ellipsized to "TREN…" — the arithmetic in the plan (and in my first comment)
was optimistic.

The root cause is not the cap. 52 is the size of the PAINTED box — the icon and
the sliding well that tracks it — not the space available. Each tab sits in a
`flex: 1` slot roughly 63–76pt wide. Pinning the button to `width: 52`
constrained the label's measurement to 52 too. Changed to `minWidth: 52`, so
the box grows with its label inside the slot it already had. The cap stays at
1.2 and `numberOfLines={1}` stays as the hard guarantee against a mid-word
break.

The well is positioned from the slot and a fixed `TAB_SIZE`
(`handleSlotLayout`), so it does not follow the grown box; painted geometry is
unchanged.

**Measured** (`scs/21-tabbar-axl.png`, AX-XL): TODAY, DIARY, TRENDS, MORE all
render complete, one line, no ellipsis, no clipping. `medium`
(`scs/41-tabbar-med.png`) has identical label positions and pill geometry to
the pre-fix baseline (`scs/42-tabbar-med-BASELINE.png`, cropped from
`fix/30-more.png`).

Two tests updated in `src/components/__tests__/FloatingTabBar.test.tsx`: the cap
assertion (1.6 → 1.2, plus `numberOfLines`, now covering all four labels) and
the touch-target assertion (`width: 52` → `minWidth: 52` with `width`
undefined, with a comment explaining why the ceiling had to go).

Full suite: 1788 passed / 205 suites. `tsc --noEmit` clean.

---

## Task E — coach surface audit (REPORTED, NOT FIXED)

### HIGH

**1. `app/recipes.tsx:56-63` + `src/components/ScreenHeader.tsx:41` — the
recipes screen is unusable at accessibility sizes.**
`accessibility-extra-large`. The header's `right` node is three 15pt labels in
a plain row with no `flexShrink` and no wrap; the title column beside it is
`flex: 1`. At AX sizes the actions take essentially the whole width and starve
the title column to about one glyph, so "Your recipes" and "Recipes" render one
letter per line and consume several screens of vertical space. The list is
pushed off-screen entirely. Evidence: `scs/31-recipes-axl.png`. Fine at
`medium` (`scs/44-recipes-med.png`). This is the same omission as Tasks A–C, in
a shared component — any screen passing a wide `right` node inherits it.
Trivial to fix (shrink the actions, or wrap them under the title above a
threshold) and severe in effect, so it wants a decision rather than silence.

### MEDIUM

**2. `src/components/home/CoachEntryCard.tsx:34` — the nudge summary is clamped
to one line.** `accessibility-extra-large`. `numberOfLines={1}` on a 14pt line
holding `${nudge.title}: ${nudge.text}`. Measured with the no-nudge copy it
truncates to "Ask Otto about yo…" (`scs/23-today-axl-2.png`); with a real nudge
the card conveys almost nothing at AX sizes. The control still opens the coach,
but the card's entire content is the message.

**3. `src/components/ScreenHeader.tsx` overline vs. the floating settings gear.**
Both sizes, worse at AX. The gear is an app-level floating button that overlaps
the header's right edge. "Grounded in your logs" runs under it on the coach
screen (`scs/24-coach-axl.png`), and on recipes the "New" action sits partly
beneath it even at `medium` (`scs/44-recipes-med.png`). A control obscured by
another control.

### LOW

**4. `app/ai-usage.tsx:34-38` — latent instance of the Task A omission.** Row
with `justifyContent: "space-between"`, no `flexShrink` on either side. At
AX-XL "Monthly" + "1 / 300" fits with very little margin
(`scs/30-aiusage-axl-2.png`). A 4-digit limit or a longer window label would
overflow exactly as `DerivationChain` did. Not currently broken.

**5. `app/(tabs)/index.tsx:372` — fixed `width: 60` on the meal-time text.** A
12pt mono text box pinned to 60pt. At AX-XL a scaled "12:30 PM" needs roughly
110pt, so it will wrap or clip. NOT verified visually — no meals could be
logged (see coverage gaps). Code-level finding only.

**6. `src/components/coach/AskInput.tsx:47` — `maxHeight: 120` on the input.**
About two lines of scaled text at AX-XL before internal scrolling. Cramped, not
broken (`scs/25-coach-typed.png`).

**7. `src/components/recipes/RecipeParseSheet.tsx:390` — `minHeight: 140` paste
area.** Shows about two lines at AX-XL and truncates its own placeholder.
Cramped, not broken (`scs/32-parsesheet-axl.png`).

### Checked and found LEGITIMATE

- `src/components/coach/FocusCard.tsx:17-18` (40×40) — icon-only tile, no text.
- `app/(tabs)/index.tsx:320-321` and `app/(tabs)/more.tsx:55-56` (34×34) —
  icon-only tiles inside rows that are themselves `minHeight: 44` and grow.
- `src/components/coach/AskInput.tsx:56` (44×44 circular send) — icon button at
  the a11y floor holding an 18pt glyph. Measured working at AX-XL.
- `src/components/coach/SuggestionChips.tsx:15-25` — already wraps, `minHeight: 44`.
- `app/coach.tsx` bubbles, error state and "Try again" — all wrap correctly at
  AX-XL (`scs/28-coach-scrolled-axl.png`).
- `app/ai-usage.tsx` quota card and copy — no clipping at AX-XL.

### Coverage gaps — states I could NOT reach

The local API (`EXPO_PUBLIC_API_URL=http://localhost:8080`) is not running;
port 8080 is a `kubectl port-forward` to an embeddings service, so data calls
404. Consequences:

- **Onboarding could not be completed** ("Couldn't reach Kora" on submit), so
  the tab shell was reached by temporarily short-circuiting the onboarding gate
  in `app/(tabs)/_layout.tsx`. That probe, and a temporary stub of
  `LinearGradient` in `FloatingTabBar` (its missing-module error box covers the
  tab labels), were both reverted — `grep "SWEEP PROBE"` is clean and the
  committed diff contains neither.
- **Not reached:** `FocusCard`, `SupportCard` and `CitationChips` in situ — all
  three require a server-provided nudge or an answered turn. Their code was
  read but never rendered at either text size.
- **Not reached:** `CoachEntryCard`'s nudge variant (only the no-nudge copy).
- **Not reached:** any populated `(tabs)/index.tsx` or `(tabs)/diary.tsx` list —
  hence finding 5 is code-level only.
- **Not reached:** the coach "thinking" and citation states; the parse sheet's
  result/review step (the parse call fails).
- **Unconfirmed:** at AX-XL only 2 of the 3 suggestion chips were on screen. The
  chips live inside the ScrollView so the third is probably reachable by
  scrolling further, but I did not scroll to the bottom to confirm it.
- The red "Unimplemented component: `<ViewManagerAdapter_ExpoLinearGradient>`"
  boxes in several shots are the known stale dev client, not a defect.

### Cleanup

The throwaway account `scs819@kora.test` was deleted through the app's own
delete-account flow, and its absence confirmed against the Identity Platform
admin lookup for `kora-app-e6d38` (empty response). Simulator content size
restored to `medium`.
