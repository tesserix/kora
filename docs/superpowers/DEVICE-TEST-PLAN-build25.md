# Device test plan — TestFlight build 25

Four fixes ship here, and **three of them cannot be verified in the simulator** — they are iOS audio
session behaviour, keyboard geometry, and touch targets. This build exists to test them on hardware.

Ordered by consequence. Each item states the **specific failure to look for**: a vague "check it
works" is how #154 passed twice while being untested.

## Building this one locally

```bash
source ~/.kora-build-env          # exports SENTRY_AUTH_TOKEN
cd apps/mobile
eas build --platform ios --profile production --local
eas submit --platform ios --profile production --latest
```

`SENTRY_AUTH_TOKEN` must come from the shell — it is a *Secret* EAS variable and Expo does not pass
those to local builds. Without it the build still succeeds and silently skips the source-map upload,
which is exactly kora#104's failure mode. Never substitute a raw `expo prebuild` + Xcode Archive:
`apps/mobile/.env` sets `EXPO_PUBLIC_API_URL=http://localhost:8080` and the production URL lives only
in eas.json's `env` block, so a raw archive ships a TestFlight build pointing at localhost.

---

## A. The four fixes — these are why the build exists

### 1. Voice recording actually starts (#186) — **the headline**

Three builds in a row failed here, each for a different reason, so treat a pass as provisional until
you have done all four sub-checks.

- **Hold the mic button.** Recording must start. The failure to look for is the toast
  **"Something went wrong starting the recording"** — that is the exact #186 symptom.
- **Flip the ring/silent switch to silent and record again.** This is not decoration:
  `playsInSilentMode` is part of the fix, and a lot of people carry a phone on silent. A clip that
  comes back empty or silent is a fail.
- **Record, then immediately play any audio** (Music, a video, anything with sound). If playback is
  quiet, or comes out of the *earpiece* rather than the speaker, `endRecordingSession` is not
  releasing the session.
- **Switch capture mode mid-recording**, and **swipe out of the capture screen mid-recording**. Both
  must stop the recorder AND release the session — repeat the playback check after each.

If it fails, the error is now **reported to Sentry** rather than swallowed, so check there before
guessing. That reporting is itself part of this fix.

### 2. Correcting a food is possible again (#182)

The whole correction journey previously failed twice in a row — the affordance was invisible, and the
picker it opened was unusable.

- Capture something, tap **Change** on a row, and **type in the picker**.
- **The results list must stay visible above the keyboard.** The failure is the keyboard covering the
  list — you can type but cannot see or tap what you typed for.
- Tap a result. It must apply to the row.
- Repeat on a **short** sheet with an input (Weight log, Add friend, Rename group) — the fix is in
  `Sheet`, so all eleven inherit it, and a regression there would be a regression everywhere.

### 3. Rows are selectable, and the count is honest (#183)

- On a **multi-item** result (a photo of a plate is the easiest way), **uncheck one row**.
- The CTA count must drop by one. Then **add to diary and check the diary**: the unchecked row must
  **not** be there. A count that changes while the diary still gets everything is the original bug
  wearing a disguise.
- **Uncheck every row** — the CTA must read **"Select an item to add"** and be disabled, not
  "Add 0 items to diary".
- Check the tap target: the box is 38px with 6px hitSlop. If you have to aim, that is a finding.

### 4. The correction affordance is visible (#181)

- An uncertain row must show a bordered **Change** button with a chevron — not the old grey
  "tap to change" text fragment.
- **A confident row must show it too.** This is the part most likely to have been missed: previously a
  confident-but-wrong row was not pressable at all and could be neither corrected nor removed.

---

## B. Regression surface — what these changes could have broken

- **Every sheet in the app** opens, scrolls, and dismisses (drag-down and scrim tap). `Sheet` gained a
  wrapper element; a layout break would show as a sheet that is clipped, mis-sized, or won't dismiss.
- **capture-review** (the offline replay screen) — it got its own copy of the exclusion state. Queue a
  capture offline, replay it, uncheck a row, confirm. Same honesty check as A.3.
- **Voice → resolve → add to diary**, end to end, since every voice path was touched.

## C. Already confirmed on device — do not re-test

- **Airplane mode** no longer sticks on the splash screen (#174's offline path) — confirmed on
  build 24.
- **The mic no longer crashes the app** (#185, the worklet boundary) — confirmed on build 24. Note
  this is *distinct* from #186 above: the crash is fixed, the recording start was not.

## D. Known-unfixed — expected to reproduce, do not file again

- **#184** — a typed "El Janah 1/2 chicken with Chips" still resolves to butter chicken and potato
  crisps. This is an API-side ranking/index problem (fraction parsing, AU locale for "chips", missing
  index rows) and needs a deploy, not a mobile build. Prod currently runs `78a0072`.
- **#176** — the onboarding ruler still drags on the JS thread: no momentum after a flick, hard stop
  at min/max.
- **#178** — iOS Increase Contrast and Bold Text are still ignored.

---

## Reporting

For anything that fails, capture: the screen, what you did, what you expected, what happened — and for
the mic, **check Sentry first**, because #186's fix means a start failure now leaves a stack trace
instead of nothing. The absence of a Sentry event is itself information.
