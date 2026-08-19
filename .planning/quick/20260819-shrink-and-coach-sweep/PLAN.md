---
quick_id: 260819-scs
slug: shrink-and-coach-sweep
date: 2026-08-19
refs: kora#173
---

# Three shrink omissions, a wrapping tab label, and a sweep of the new coach surface

Follow-on to #260. All findings below come from the kora#173 sweep except Task E,
which is new exposure.

Order matters: **write Tasks A–D first (no simulator needed), then do ONE
simulator session that verifies A–D and performs the Task E sweep.** One
throwaway account covers everything. Do not do two account cycles.

---

## Task A — `DerivationChain` value runs off-screen

`apps/mobile/src/components/instrument/DerivationChain.tsx` — the row at ~:30 is
`flexDirection: "row"` + `justifyContent: "space-between"`, with a label
`<AppText variant="footnote" muted>` at ~:44 and a value `<View>` at ~:49.
Neither side is given `flexShrink` or `flex`, so at accessibility sizes
"Activity-adjusted **2507 kc|al**" overflows the right edge of the screen.

The label is the compressible half — the value is a number and must stay whole
(see #260's water-pill fix for why a mid-number break is unacceptable). So the
label should shrink and the value should not.

Onboarding summary screen. Verify there.

## Task B — `profile.tsx` energy readout clipped

`apps/mobile/app/profile.tsx:109-116` — a baseline row holding a 40pt mono
numeral and the unit "kcal / day", with no shrink on either. At accessibility
sizes "kcal / da|y" is clipped at the screen edge.

## Task C — `profile.tsx` weight unit clipped

`apps/mobile/app/profile.tsx:144-149` — same pattern inside a `flex: 1`
`GlassPanel`: a 24pt mono value plus its unit, "k|g" clipped by the card edge.

Tasks A–C are the same omission three times. Fix them consistently rather than
three different ways, but do NOT invent a shared abstraction for it — three
small local fixes are the right size here.

## Task D — tab bar labels wrap and clip

`apps/mobile/src/components/FloatingTabBar.tsx:117-133`. At accessibility sizes
"TODAY" renders as "TODA/Y" and "TRENDS" as "TREN/DS", both clipped by the pill.

The existing comment argues the 1.6 cap is legitimate here — a short label in a
fixed 52pt slot, with an icon carrying the same meaning. **That reasoning is
sound; do not discard it.** But the arithmetic does not work out: 9pt at 1.6 is
14.4pt, and "TRENDS" at 14.4pt with `letterSpacing: 1.4` needs roughly 62pt
against a 52pt slot.

A wrap that clips mid-word is worse than either a smaller label or a widened
slot. Decide between capping lower, letting the slot grow, and `numberOfLines={1}`
— MEASURE the result, and update that comment to match whatever you choose, since
it currently states a justification the rendering does not honour.

---

## Task E — sweep the coach surface (AUDIT, do not fix)

#259 landed a large new surface AFTER the kora#173 sweep ran and BEFORE the
leading fix (#260) merged. None of it has been seen at accessibility text sizes,
and all of it was authored against the old, 11%-too-tight line box.

Screens and components to cover:
- `app/coach.tsx`, `app/ai-usage.tsx`
- `src/components/coach/`: `AskInput`, `Bubble`, `CitationChips`, `FocusCard`,
  `SuggestionChips`, `SupportCard`
- `src/components/home/CoachEntryCard.tsx`
- `src/components/recipes/RecipeParseSheet.tsx`
- the rewritten `app/(tabs)/index.tsx` and `app/(tabs)/more.tsx`

Known fixed heights worth checking first: `FocusCard.tsx:18` (40),
`(tabs)/index.tsx:321` (34), `(tabs)/more.tsx:56` (34), `AskInput.tsx:56` (44,
a circular send button — a fixed square is legitimate for an icon button, judge
on what it contains).

**Report findings, do not fix them.** They are new scope and belong in an issue,
not bundled into this branch. If something is both trivial and severe, say so and
leave it for a decision.

Expect the coach screens to fail their network calls — `EXPO_PUBLIC_API_URL`
points at a local API that is not running. Empty, loading and error states are
still worth assessing at both text sizes; say plainly which states you could not
reach.

---

## Constraints

- **A green suite is NOT verification.** Screenshots at BOTH `medium` and
  `accessibility-extra-large` for every claim. This whole line of work exists
  because 1,729 green tests hid a rendering bug.
- `medium` must be visually unchanged by A–D.
- Do not touch #261 (the ruler's `SvgText` labels) — separate issue, deliberately
  out of scope.
- Do not touch `GaugeDial`'s caption collision or sign-in's below-fold email
  button; both are LOW and still tracked on #173.

## Acceptance

- A–D fixed and screenshot-verified at both sizes; `medium` unchanged.
- Task D's code comment matches the behaviour actually shipped.
- A findings report for the coach surface, with explicit coverage gaps.
- Atomic commits, single-line conventional messages, NO signature and NO
  Co-Authored-By trailer.
