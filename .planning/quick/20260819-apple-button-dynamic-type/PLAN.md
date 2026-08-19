---
quick_id: 260819-gjr
slug: apple-button-dynamic-type
date: 2026-08-19
refs: kora#173
---

# Apple sign-in button does not participate in Dynamic Type

Task 3 of kora#173. Tasks 4 and 5 were closed out by the leading fix in
f99e2f79 and are NOT in scope here.

## Problem

`apps/mobile/src/components/auth/AppleSignInButton.tsx:41` sets a hard
`height: 48`. At `accessibility-extra-large` the Google and email buttons scale
their labels and grow to ~2 lines, while the Apple button keeps a default-size
label in a 48pt box. The three controls visibly disagree, on a pre-auth screen
that is App Review-visible.

`AppleAuthentication.AppleAuthenticationButton` wraps UIKit's
`ASAuthorizationAppleIDButton`, whose label Kora cannot style directly — that is
the whole point of using it (a bespoke Apple button is a routine App Store
rejection, per the component's own comment).

## This is a MEASUREMENT task first

Do not assume a fix. `ASAuthorizationAppleIDButton` may size its title from its
frame, in which case scaling the height fixes it properly; or it may pin the
title to the system font regardless, in which case a taller button is a WORSE
outcome than the status quo — a big empty control with small text.

**Step 1 — measure.** Temporarily set the height to
`48 * PixelRatio.getFontScale()` and screenshot at `accessibility-extra-large`.
Compare the rendered Apple label against the medium-size baseline and against
the neighbouring Google label.

**Step 2 — branch on the result.**

- **If the label grows with the frame:** that is the fix. Keep it, but CAP the
  multiplier so the button cannot run away at the largest sizes (start from the
  cap used elsewhere in the app — ~1.4–1.6 is the established convention, see
  the `maxFontSizeMultiplier` call sites). Verify the capped height still looks
  deliberate next to Google's at AXL.
- **If the label does NOT grow:** revert the height change. Do not ship a taller
  button with a small label. Report the finding for kora#173 instead, stating
  plainly that the native control cannot participate in Dynamic Type and that
  the remaining options are cosmetic-only. Recording a measured negative result
  is a complete outcome for this task.

## Constraints

- A green test suite is NOT verification here. Every claim about rendering needs
  a simulator screenshot at BOTH `medium` and `accessibility-extra-large`.
  kora#173 exists because 1,729 green tests hid a rendering bug.
- Do not touch the Google button, the email button, or `AuthScaffold`. They are
  out of scope and were resolved or made moot by f99e2f79.
- `AppleSignInButton` returns `null` off iOS by design — keep that structural
  guarantee intact.
- `src/components/auth/__tests__/` has existing coverage; keep it passing and
  extend only if the fix introduces JS-side logic worth pinning.

## Acceptance

- A measured, screenshot-backed answer to "does the native label track the
  frame height?"
- Either a capped scaling fix that visibly aligns the three buttons at AXL, or a
  clean revert plus a written finding.
- `medium` renders unchanged from today's baseline in either case.
