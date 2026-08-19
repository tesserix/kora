---
status: resolved
trigger: "kora#173 Task 1 — measure whether RN 0.86/Fabric double-scales lineHeight. Text.tsx:33 assumes RN never scales lineHeight for Dynamic Type and multiplies the derived line box by PixelRatio.getFontScale(). Sim screenshots at accessibility-extra-large show roughly two blank line boxes between wrapped lines, suggesting the scale is applied twice. Need an empirical measurement (probe screen, screenshot at medium vs accessibility-extra-large, measure pixel deltas) before changing Text.tsx or rewriting src/components/__tests__/textLeading.test.tsx."
created: 2026-08-19
updated: 2026-08-19
---

# Debug: lineHeight appears double-scaled at accessibility text sizes

## Symptoms

Gathered by direct simulator observation on 2026-08-19 (not user-reported — the
orchestrator reproduced this while re-verifying kora#173, so all five fields are
evidence rather than recollection).

- **Expected behavior:** At `accessibility-extra-large`, text scales up and the
  line box scales with it, preserving the authored ratio. Wrapped lines sit one
  normal leading apart, exactly as they do at `medium`.
- **Actual behavior:** Wrapped lines are separated by roughly TWO blank line
  boxes. On the sign-in screen "Welcome" and "back." are a full screen-third
  apart, and the same gap appears on every multi-line string. The screen becomes
  ~4 viewport-heights tall and no sign-in control is visible on first paint.
- **Error messages:** None. Nothing is thrown or logged — this is a pure layout
  outcome. All 1,729 tests pass, including the five in
  `src/components/__tests__/textLeading.test.tsx` that assert the current
  multiplication as correct.
- **Timeline:** Unknown whether it ever worked. The scaling was introduced by the
  kora#177 leading work; the premise it rests on may have been true on the old
  architecture and become false when RN 0.82+ made the New Architecture the only
  option. RN is now 0.86.0 / Expo ~57.0.8. Needs establishing, not assuming.
- **Reproduction:**
  1. `xcrun simctl boot "iPhone 17 Pro Max"` (udid 8B6D805C-7155-4238-BFA6-DA7109C7DE84)
  2. `xcrun simctl ui <udid> content_size accessibility-extra-large`
  3. Relaunch the app (the content_size change needs a fresh launch to take):
     `xcrun simctl openurl <udid> "com.tesserix.kora://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082"`
  4. Screenshot the sign-in screen; compare against `content_size medium`.
  - Baseline at `medium` is clean, which is what makes this specific to scaling
    rather than to the type scale itself.

## Suspect

`src/components/Text.tsx:33-47`. The comment states the premise outright:

> RN scales `fontSize` for Dynamic Type but never `lineHeight`, so a pt line
> box collapses to zero spacing at accessibility text sizes

and the code multiplies the derived box by `PixelRatio.getFontScale()`
accordingly. If Fabric now scales `lineHeight` itself, the scale lands twice and
the observed ~2x gap follows directly.

`derivedLeading(size, scale)` returns `Math.round(size * ratio * scale)`, and the
variant branch returns `Math.round(p.lineHeight * scale)`.

## Current Focus

- **hypothesis:** CONFIRMED. RN 0.86 on the New Architecture multiplies whatever
  `lineHeight` a component passes by `PixelRatio.getFontScale()`. `Text.tsx`
  applies the same scale itself, so the rendered box is `ratio x size x scale^2`.
- **reasoning_checkpoint:**
    hypothesis: "The platform scales `lineHeight` by fontScale; Text.tsx scales
      it a second time, so the rendered line box grows as scale^2."
    confirming_evidence:
      - "Sweep of 15 lineHeight values (10..80) at fontScale 2.6430: measured
        per-line advance / specified lineHeight = 2.633..2.650 for EVERY value.
        The platform multiplier IS fontScale."
      - "allowFontScaling={false} with lineHeight 26 measures exactly 26.00 at
        fontScale 2.6430 - the platform multiplier is 1 when scaling is off."
      - "AppText fs20 measures adv=169.00. Derived box is round(20*1.22*2.643)=64,
        and 64*2.641=169. That is scale applied twice."
      - "A correctly-scaled box for fs20 is ~63pt (the unstyled natural advance,
        C3=63.00). 169 vs 63 is the ~2.7x gap seen on the sign-in screen."
    falsification_test: "If the platform did NOT scale lineHeight, the sweep ratio
      would have been 1.000 for every row and allowFontScaling={false} would have
      made no difference. Both would have refuted it."
    fix_rationale: "Pass the authored, UNSCALED derived lineHeight and let the
      platform apply fontScale once. Rendered box then = ratio x size x scale,
      which is exactly the authored ratio against the rendered glyph."
    blind_spots: "iOS only - Android not measured. Layout for text carrying
      maxFontSizeMultiplier is measured by RN with the UNCAPPED scale even though
      it renders capped (C2: measured 68.67, rendered 38.6 = 26*1.5); that is an
      RN inconsistency the component cannot correct by pre-scaling."
- **next_action:** Remove the `scale` multiplication from `src/components/Text.tsx`,
  rewrite `textLeading.test.tsx` against measured behaviour, restore the probe
  screen, and re-verify the real sign-in screen at medium and AXL.

## Evidence

- timestamp: 2026-08-19 — Sign-in at `medium` renders correctly: three buttons
  visible above the footer, normal leading, no clipping. Screenshot
  `173-medium.png`.
- timestamp: 2026-08-19 — Sign-in at `accessibility-extra-large`: "Welcome" and
  "back." separated by ~2 blank line boxes; subtitle likewise; all three sign-in
  buttons pushed below the fold; ~7 swipes to reach them. Screenshots
  `173-axl.png`, `173-axl-scrolled.png`, `173-axl-bottom.png` in the session
  scratchpad.
- timestamp: 2026-08-19 — RN 0.86.0 / Expo ~57.0.8 confirmed from
  `apps/mobile/package.json`. No `newArchEnabled` flag in `app.json` or
  `ios/Podfile.properties.json` — consistent with RN 0.82+ where the New
  Architecture is the only option, but not positive proof; worth confirming at
  runtime.
- timestamp: 2026-08-19 — `textLeading.test.tsx` asserts the doubling as correct
  in five places (`15 * 1.3 * 2`, `22 * 2`, etc). The jest environment cannot
  observe platform scaling, so these tests cannot distinguish the two
  hypotheses. They are not evidence either way.

### Measurement session (probe screen, iPhone 17 Pro Max, RN 0.86 / Fabric)

- timestamp: 2026-08-19 — Runtime self-report from the probe: `fabric=true`,
  `bridgeless=true`, `reactNativeVersion.minor=86`. New Architecture confirmed at
  runtime, not inferred from config.
- timestamp: 2026-08-19 — `PixelRatio.getFontScale()` reports 0.9410 at
  `content_size medium` and 2.6430 at `accessibility-extra-large`. These are RN's
  own RCTAccessibilityManager multipliers. Note `medium` is one step BELOW iOS's
  default `large` (1.0), so even the "clean" baseline was running a 0.941 scale.
- timestamp: 2026-08-19 — DECISIVE. lineHeight sweep at fontScale 2.6430,
  fontSize 20, no cap. Per-line advance measured as height(2 lines) -
  height(1 line), which cancels ascent/descent padding. Screenshot
  `sweep-axl-fresh.png`:
    lh=10 adv=26.33 x2.633 | lh=14 adv=37.00 x2.643 | lh=18 adv=47.67 x2.648
    lh=20 adv=53.00 x2.650 | lh=22 adv=58.00 x2.636 | lh=23 adv=60.67 x2.638
    lh=24 adv=63.33 x2.639 | lh=25 adv=66.00 x2.640 | lh=26 adv=68.67 x2.641
    lh=28 adv=74.00 x2.643 | lh=32 adv=84.67 x2.646 | lh=40 adv=105.67 x2.642
    lh=52 adv=137.33 x2.641 | lh=64 adv=169.00 x2.641 | lh=80 adv=211.33 x2.642
  The multiplier is fontScale for every value. **The platform scales lineHeight.**
  The premise in Text.tsx:33 is FALSE on RN 0.86 / New Architecture.
- timestamp: 2026-08-19 — Control set at fontScale 2.6430, clean launch,
  screenshot `caps-axl.png`:
    C1 lh26 no cap        adv=68.67  (26 x 2.641)
    C2 lh26 cap 1.5       adv=68.67  (cap does NOT reduce the measured box)
    C3 no lineHeight      adv=63.00  (natural 23.83 x 2.643)
    C4 no lineHeight cap  adv=63.00
    C5 lh26 noScale       adv=26.00  (exactly 26 - multiplier is 1)
    C6 AppText fs20       adv=169.00 (derived 64, then x2.641 = scale squared)
  C6 vs C3 is the bug in one line: AppText produces a 169pt box where correct
  body leading at that size is ~63pt. 169/63 = 2.68 ~= fontScale, i.e. one extra
  application of the scale.
- timestamp: 2026-08-19 — At `medium` (fontScale 0.9410), same law holds:
  lh26 with scaling on measured 24.56/line (26 x 0.941 = 24.47); lh26 with
  `allowFontScaling={false}` measured exactly 26.00. Screenshot `probe-medium.png`.
- timestamp: 2026-08-19 — METHOD NOTE, cost ~4 probe rounds. Fast Refresh
  PRESERVES `useState`, and `onLayout` only re-fires when layout actually
  changes, so measurements taken after an edit can be silently stale. Two runs
  reported lh26 scaling by 1.5 instead of 2.64 purely from carried-over state.
  Every number recorded above was taken after a full terminate + relaunch.
  Also: `onTextLayout` never fired under Fabric, and wrapping a probe in a
  fixed-height or zero-height View constrains the child and makes `onLayout`
  report the constraint rather than the intrinsic height - measure through an
  absolutely-positioned child instead.

## Eliminated

- hypothesis: "RN never scales `lineHeight` for Dynamic Type, so the component
    must scale it itself" (the premise Text.tsx:33 and textLeading.test.tsx were
    both built on)
  evidence: 15-value lineHeight sweep at fontScale 2.6430 shows a measured
    multiplier of 2.633-2.650 for every value, and exactly 1.000 when
    `allowFontScaling={false}`. The platform does scale it.
  timestamp: 2026-08-19
- hypothesis: "`maxFontSizeMultiplier` caps the line box, so the component must
    cap its own derived box to match"
  evidence: C1 vs C2 (68.67 vs 68.67) and C3 vs C4 (63.00 vs 63.00) - the cap
    changes neither measured box. It does cap the glyph and the RENDERED
    spacing (visible C2 renders at 26 x 1.5 = 39pt). Pre-scaling in the
    component cannot fix RN's measure/render disagreement and would corrupt the
    rendered result, so the cap branch is not the component's business.
  timestamp: 2026-08-19

## Resolution

- root_cause: On RN 0.86 / New Architecture (iOS), the platform multiplies the
  `lineHeight` a component passes by `PixelRatio.getFontScale()`, exactly as it
  does `fontSize`. `src/components/Text.tsx` applied that same scale itself,
  on a stated premise ("RN scales fontSize for Dynamic Type but never
  lineHeight") that measurement shows is false. The scale therefore landed
  twice and the rendered line box grew as scale², not scale. At
  `accessibility-extra-large` (fontScale 2.6430) a 20pt body string was given a
  169pt line box where ~63pt is correct — a 2.7x over-tall box, which is the
  "two blank line boxes" between "Welcome" and "back.". The bug was present at
  every text size, not only accessibility ones: at `content_size medium`
  (fontScale 0.9410) the box was 0.941² = 0.885 of correct, i.e. 11% too TIGHT.
  That is why the medium baseline looked clean — the error was a squeeze rather
  than a blowout and stayed under the threshold of noticing.
- fix: Removed the `PixelRatio.getFontScale()` multiplication from `Text.tsx`
  entirely. `derivedLeading` lost its `scale` parameter and the variant branch
  now passes `p.lineHeight` unscaled. AppText emits authored, unscaled points
  and the platform applies Dynamic Type once. The `allowFontScaling === false`
  and `maxFontSizeMultiplier` special cases were deleted rather than adjusted:
  measurement shows the platform multiplies the box by 1 when scaling is off
  (lineHeight 26 renders at exactly 26.00 at fontScale 2.6430), and a cap scales
  glyph and rendered box by the same capped multiplier, so the authored ratio
  survives both unaided.
- verification:
  - Simulator, iPhone 17 Pro Max, real sign-in screen, BOTH content sizes:
    `fix-axl.png` — "Welcome" / "back." now one normal leading apart (was ~2
    blank line boxes); subtitle likewise; two provider buttons visible above the
    fold on first paint where previously all three were ~7 swipes below.
    `fix-medium.png` — clean, three buttons above the footer, no clipping.
  - Pixel diff of `173-medium.png` (before) vs `fix-medium.png` (after):
    RMSE 0.091, differences confined to small vertical offsets of text within
    unchanged containers. This is the expected correction of the 11% squeeze,
    not a layout regression.
  - `npx jest`: 202 suites / 1758 tests pass. `tsc --noEmit` and `eslint` clean.
  - NOTE ON TEST VALUE: the suite is NOT the verification. It was green
    throughout the bug's life, asserting the wrong premise in five places.
    `textLeading.test.tsx` has been rewritten to pin the JS-side contract only,
    and says so in a header comment.
  - The probe screen used for measurement was written over `app/sign-in.tsx`
    and has been restored from backup; `git status` confirms the file is
    unmodified.
- files_changed:
  - apps/mobile/src/components/Text.tsx
  - apps/mobile/src/components/__tests__/textLeading.test.tsx
- out_of_scope_still_broken: The AXL screenshot still shows the other kora#173
  items, untouched by design — the Apple button's fixed height crops its label,
  the Google button wraps to two lines, and the AuthScaffold footer clips the
  third button. Those are separate tasks and were expected to change once
  leading was correct.

## Specialist Review

Dispatched: `code-reviewer` (specialist_hint: `react`) against the unstaged diff on
`Text.tsx` + `textLeading.test.tsx`. Verdict: **SUGGEST_CHANGE** — the code change
itself is correct; one issue is with the evidence trail.

**Important — dangling doc reference.** `Text.tsx:50-51` and the test header
(line 24) both cite `.planning/debug/resolved/lineheight-double-scaled.md`. This
file is still at `.planning/debug/lineheight-double-scaled.md` and is untracked.
The comment's whole job is to be a guard against someone reintroducing the
multiplication on reasoning alone, so a path that resolves to nothing defeats it.
Resolution: the debug doc must be archived to `resolved/` and land in the SAME
commit as the two code files (or the comments repointed at the un-archived path).

Confirmations from the review:

- **Removing the `allowFontScaling` / `maxFontSizeMultiplier` branches is safe.**
  Both props still reach RN's `Text` via `{...rest}`; only JS-side line-box math
  went away. Call-site sweep: zero non-test `allowFontScaling` uses; ~15
  `maxFontSizeMultiplier` uses (FloatingTabBar, ModePill, MacroCell, GaugeDial
  x6, EnergyBars, BezelCluster, WeekRail, DayTotalCluster), all at 1.4/1.6.
  Those sites are strictly BETTER off: previously at fontScale 3 with a 1.5 cap,
  JS emitted `15*1.3*1.5 = 29` and the platform applied the capped 1.5 again →
  ~43.5pt against a correct ~30pt. Now JS emits 20, platform renders 30.
  `GaugeDial.test.tsx:47-48` and `FloatingTabBar.test.tsx:207` still pin
  prop pass-through.
- **Signature and imports clean.** `derivedLeading(size: number)` has one call
  site, updated. `PixelRatio` correctly dropped from `Text.tsx`, correctly kept
  in the test (used by every `jest.spyOn`).
- **The rewritten tests are not tautological.** Reintroducing
  `* PixelRatio.getFontScale()` fails the `it.each([1, 2, 2.643, 3.571])` block
  at three of four scales (expect 20, get 40 / 52.9 / 71.4). Removing the
  `beforeEach` pin also hardened the first describe block by accident — RN's
  preset resolves `getFontScale()` to the mocked pixel ratio 2, so a reintroduced
  multiplication breaks those six size-band cases too. Two independent tripwires.
- **The "jest cannot observe platform font scaling" comment is honest.** It
  scopes the claim to the JS-side contract, names what does verify the rendered
  box, and does not overclaim.
- **Leaving the capped measure/render disagreement alone is the right call** —
  pre-scaling in JS would corrupt the rendered box without fixing reserved height.

Nit outside the diff: `src/motion/AnimatedNumber.tsx:20-23` says `AnimatedNumber`
"doesn't pick up AppText's `maxFontSizeMultiplier` handling for free." AppText no
longer has such handling — it just forwards the prop. Still directionally true;
worth a touch-up if that file is opened.
