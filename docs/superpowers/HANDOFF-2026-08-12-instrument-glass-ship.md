# Handoff — 2026-08-12 — Instrument Glass redesign shipped, device findings to fix

## What shipped (all on main, through commit dc747f8+)

The complete Instrument Glass redesign: dial-K brand (icon/splash/BrandMark), all 5 core
screens + every More sub-page rebuilt (spec: `docs/superpowers/specs/2026-08-11-kora-instrument-glass-design.md`,
plan + ledger: `.superpowers/sdd/2026-08-11-kora-instrument-glass/progress.md`), widgets
merged with the empty-day fix and privacy hardening (uid-change snapshot clear, owner-scoped
dashboard cache), Reminders merged into Settings, safeBack for deep-linked screens,
notification-permission denial toast with native Open-Settings deep link (iOS 16+).

EAS build #14 (`108ed028`) built and auto-submitted to TestFlight; user installed on device.

## EAS build gotchas burned into this repo (do not rediscover)

1. **Lockfile**: local npm is 11.x, EAS runners use npm 10.9. Regenerate with
   `npx npm@10.9.3 install --package-lock-only` after dep changes, or `npm ci` fails remotely.
   `eas.json` now pins node 22.19.0.
2. **Widget target name**: must be `korawidgets` (no hyphen) in
   `targets/kora-widgets/expo-target.config.js` — EAS credentials use the sanitized name and
   the worker looks it up exactly.
3. **Capability sync**: EAS's Apple API patch for APP_GROUPS/HEALTHKIT was rejected until the
   App Group (`group.com.tesserix.kora`) and capabilities were configured MANUALLY in the
   developer portal (both bundle ids). Done 2026-08-12; future builds sync clean.
4. `ios.appleTeamId: 2CRHRRYBPL` now set in app.json — apple-targets needs it on CI.
5. Reanimated worklet crash class hit twice: any function reachable from
   `useAnimatedProps`/`useAnimatedStyle` needs a `"worklet"` directive — same-file is NOT
   auto-workletized (only the hook's own literal is). Jest cannot catch this.

## Device findings from the TestFlight build (NEXT SESSION'S WORK)

1. **Light-mode splash: logo hardly visible.** The splash icon is the cream/lume mark on
   transparency; over the light splash background it disappears. Fix: light splash should use
   the ink-on-light mark (`assets/brand/kora-mark-light.svg` exists) — expo-splash-screen
   supports `dark`/light image variants in app.json; regenerate `splash-icon-light.png` via
   `assets/brand/build-icons.sh` (add a light render) and wire both variants.
2. **No in-app appearance toggle.** Settings needs an Appearance section
   (System / Light / Dark) — store choice, apply via Appearance.setColorScheme() or a
   useColorScheme override at the theme root. Spec's theming is token-complete; this is
   plumbing + one SegmentedGlass row.
3. **Tab bar active state too subtle** (reported as "barely highlights active tab",
   observed on device, likely worst in light mode). FloatingTabBar active = ink label +
   4pt accent dot; consider raising contrast: active icon+label ink at full opacity vs mut,
   possibly an inset active pill behind the icon. Check both themes on device.
4. **Steps widget absent from the gallery — INTENTIONAL.** It was pulled from the bundle
   (`targets/kora-widgets/index.swift`, commented out) after the whole-branch review found it
   renders unknown-as-zero for denied Health reads and was never device-verified. Re-add ONLY
   after: (a) carrying a `stepsReadable` signal (or 7-day probe mirror) into the widget so
   denied ≠ 0, and (b) real-device verification. The nutrition widgets (small+medium) work —
   user confirmed seeing them.

## Still open from before

- **Issue #135 manual gate**: sign-out on device → both widgets revert to "Open Kora"
  (privacy). Code path reviewed sound end-to-end; never observed live. Now testable on the
  TestFlight build.
- Deferred minors live in the two SDD ledgers (`.superpowers/sdd/*/progress.md`): duplicated
  engraved literals in index/diary (2 sites), redundant tab test, sign-in/onboarding screens
  still legacy-styled apart from shared Button/Segmented (deliberate — next uplift candidate),
  midnight date-bucketing quirk (API buckets by UTC; 12:43 AM local logs land on the previous
  local day — backend ticket).

## Session mistakes worth recording

- Trusted "same-file functions are auto-workletized" from a reviewer instead of the
  Reanimated docs — it crashed live. The docs, then the device, are the authority.
- Repeated numeral-formatting/clipping bugs (gauge, diary, profile) — each caught on-screen
  after tests were green. Screenshot review on the simulator catches what jest cannot;
  budget for it after every visual change, not at the end.
- Ran `git add -A` from repo root once and swept an untracked file into a commit
  (recovered via amend). Scope adds to the files the task touched.
