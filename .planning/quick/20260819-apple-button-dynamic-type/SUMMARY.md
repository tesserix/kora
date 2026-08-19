---
quick_id: 260819-gjr
slug: apple-button-dynamic-type
date: 2026-08-19
refs: kora#173
outcome: fixed
branch: positive
---

# Apple sign-in button now participates in Dynamic Type

Task 3 of kora#173. Measurement branch resolved **positive**: the native label
does track the frame, so scaling the height is a real fix.

## The measurement

Device: iPhone 17 Pro Max simulator, sign-in screen (pre-auth). Geometry read
off 3x screenshots by locating the white button rect and the bounding box of its
black glyphs, then dividing by 3.

| Content size | Height rule | Button height | Label ink height |
| --- | --- | --- | --- |
| `medium` (fontScale 0.941) | fixed 48 | 48.0pt | 17.0pt |
| `accessibility-extra-large` (fontScale 2.643) | fixed 48 | 48.0pt | **17.0pt** |
| `accessibility-extra-large` | `48 * fontScale` | 127.0pt | **29.7pt** |
| `accessibility-extra-large` | `48 * min(fontScale, 1.6)` | 76.7pt | **26.7pt** |

Two things fall out of this.

**The bug is real and total.** At a fixed height the label measures 17.0pt at
both `medium` and `accessibility-extra-large` — byte-identical, not merely
similar. `ASAuthorizationAppleIDButton` ignores the content size category
outright when its frame is pinned, while the Google and email labels beside it
grow to two lines.

**The frame is the lever.** Scaling the height to 127pt moved the same label to
29.7pt. The native control has no font API, but it sizes its title from its
frame, so height is the only way to make it participate — and it works.

**The title scales sub-linearly, which is what makes the cap cheap.** A 2.64x
frame bought only a 1.75x label. The capped 1.6x frame still yields a 1.57x
label — it keeps ~90% of the available label growth for 40% less height. Going
uncapped costs 50pt of vertical space to gain 3pt of label.

## The fix

`apps/mobile/src/components/auth/AppleSignInButton.tsx`

- Height is now `appleButtonHeight(fontScale)`, exported so the bounds are
  directly testable.
- **Capped at 1.6x**, matching the ceiling already used for primary controls
  (`FloatingTabBar`, `ModePill`, `GaugeDial`'s hero numeral). Uncapped, AXL
  produces a 127pt slab that dwarfs the Google button next to it.
- **Floored at 1.0x.** This half of the clamp is load-bearing and was not in the
  plan. iOS content sizes below the default `large` report a fontScale under 1 —
  this simulator reports 0.941 at `medium` — so a bare `48 * fontScale` would
  have *shrunk* the button to 45pt on the most common setting, regressing the
  tap target. Dynamic Type may grow this control; it may not shrink it.
- Reads the scale from `useWindowDimensions()` rather than
  `PixelRatio.getFontScale()`. The former is reactive, so the button resizes
  when the user changes text size in Settings and returns to a still-mounted
  app; the latter is a one-shot read that would only update on remount. The hook
  sits above the `Platform.OS !== "ios"` guard, so the structural
  return-null-off-iOS guarantee is intact and the Android test still passes.

## Verification

Screenshot-backed at both sizes, per the plan's constraint that a green suite is
not verification here.

- **`medium` is pixel-identical to the pre-change baseline.** Full-frame diff of
  `fix-medium.png` against the post-fix capture returns an empty bbox and a max
  channel delta of 0. The floor clamp is why.
- **AXL now reads as one coherent set.** All three buttons captured together:
  Apple at 76.7pt with a 26.7pt label, Google and email at two lines. The
  default-size-label-in-a-small-box mismatch is gone.
- 1763 tests pass (202 suites). `tsc --noEmit` clean. ESLint clean apart from
  one pre-existing `require()` warning in the test file's `jest.mock` factory.

## Tests

`src/components/auth/__tests__/AppleSignInButton.test.tsx` gains an
`appleButtonHeight` block pinning the baseline, the floor (0.941 and 0.5 both
stay at 48), growth between the bounds, and the 1.6 cap — plus a test that spies
on `useWindowDimensions` to pin that the component reads the *live* scale rather
than a constant. The measured pt figures are recorded in comments so a future
reader can tell the bounds are measured, not taste.

## Out of scope, untouched

Google button, email button, `AuthScaffold` — resolved or made moot by the
leading fix in f99e2f79. Tasks 4 and 5 of kora#173 were closed there.

## Simulator state

Content size restored to `medium`.
