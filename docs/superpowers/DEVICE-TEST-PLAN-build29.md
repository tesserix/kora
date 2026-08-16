# Device test plan — TestFlight build 29

Three fixes that landed after build 27 was cut, plus everything 27 already carried (now confirmed).
The AI changes below are **already live in production** and need no build at all.

Ordered by consequence. Each item names the **specific failure to look for**.

## Building this one locally

```bash
source ~/.kora-build-env          # exports SENTRY_AUTH_TOKEN
cd apps/mobile
eas build --platform ios --profile production --local
eas submit --platform ios --profile production --path ./build-<timestamp>.ipa
```

`--path`, never `--latest`: a local build does not appear in `eas build:list`, so `--latest` submits a
stale cloud build. `SENTRY_AUTH_TOKEN` must come from the shell — it is a *Secret* EAS variable and
Expo does not pass those to local builds, so without it the build succeeds and silently skips the
source-map upload (kora#104's failure mode). Verify the upload afterwards via the **artifact-bundles**
endpoint, not `releases/`, which lags.

---

## A. The AI change — already live, no build needed

This is the one worth testing first, because it changes what the app *says* rather than how it looks,
and because it is already in production (`4b9fd17`) regardless of which build you run.

### A1. The index now has Australian food

Prod went from 7,900 rows (98% USDA) to ~12,400: the full FSANZ AFCD release (1,553 rows) plus
Australian branded products from Open Food Facts (5,666).

- **Say or type "Coke Zero".** Coca-Cola Zero Sugar now exists at **0.3 kcal/100 g**. The old failure
  was "Carbonated beverage, cream soda" at 16 kcal — a sugared drink standing in for a zero-calorie
  one, which is a nutrition error rather than a naming one.
- Try Weet-Bix, Tim Tams, Vegemite, a lamington, a flat white. None of these existed this morning.

### A2. The app can now say "I don't know" (kora#184)

Below a **0.40** match score the resolver abstains instead of returning its nearest row. The client
already had the screen for it: "couldn't identify that", with Search manually.

- **Say "McSpicy chicken burger".** It should **abstain**, not return a McDonald's Bacon Ranch Salad.
  That match scored 0.349 in production, which is what the floor was calibrated against.
- **The risk to watch for is the opposite failure:** abstaining on something it should have answered.
  The floor sits between the worst correct match measured (croissant, 0.4425) and the best wrong one
  (0.399), so a food that resolves *nearly* right is the interesting case. If it abstains on something
  obvious, say so — every abstain is logged with its score (`ai: abstaining`), so the figure can be
  re-derived rather than guessed at again.

---

> **Build 28 does not exist.** A first attempt failed on EAS's filename-casing check because the repo
> was being modified (a `git mv`) while the build scanned the tree — `autoIncrement` had already
> reserved 28 remotely by then. Do not edit the working tree during a local build.

## B. New in build 29 — untested

### B1. Correcting a QUEUED capture no longer double-logs (kora#198)

The one worth the most attention, because the old behaviour silently wrote wrong data.

Reaching it needs an offline capture: **airplane mode → photo or voice → back online → wait for the
drain → tap the row in the diary.**

- **Tap Change on a row.** It must open the food picker **in place**. It must NOT jump to the manual
  log screen.
- Pick a replacement, then **Confirm**, then **check the diary**: exactly one entry, for the food you
  picked.
- The old behaviour: Change logged the picked food immediately via `/log`, left the capture showing the
  food you rejected, and Confirm then logged that one too — two entries from one correction.

### B2. A typed phrase enters the thread (kora#199)

Already verified on the simulator; a device pass is confirmation, not discovery.

- Type something and Send. The composer clears **immediately** and the phrase appears as your own
  right-aligned bubble — not after the resolve finishes.
- **Make one fail** (airplane mode, then type and Send): the words come back into the composer and the
  bubble disappears. A failed text resolve is not queued, so losing the text would mean retyping.

### B3. The cluster glow is no longer orange

- Home and Trends: the panel should lift off the ground with a **warm, neutral backlight** — not an
  orange halo. Measured on the simulator, warmth beside the cluster dropped from R−B +37 to +6.
- The accent should now read as: gauge needle, "KCAL IN RESERVE", the dock camera button. If the panel
  edge still glows orange, the change did not ship.

## C. Regression surface

- **Every sheet** opens, scrolls and dismisses — `Sheet` gained the keyboard wrapper in build 25 and
  `DetectedCard` changed again here.
- **Live capture (not review)** still shows its own "Add to diary" CTA. Only the review screen hides it.
- **Voice end to end**, since the audio-session work is recent.

## D. Known-unfixed — expected, do not re-file

- **kora#196** — typed and barcode captures are still dropped offline (only photo/voice queue). The
  message is honest now; the capture is still lost.
- **kora#173** — sign-in at large accessibility text sizes. Still the highest-value open bug.
- **kora#176** — the onboarding ruler still drags on the JS thread.
- **~3,000 rows carry no embedding.** Deliberate: the Gemini free tier caps at 1,000/day, and branded
  products match lexically by name anyway. Not a defect.

---

## Reporting

Screen, what you did, what you expected, what happened. For capture failures **check Sentry first** —
several of these paths now leave a stack trace where they previously left nothing, and an absent event
is itself information.

---

# Appendix — the three "no code left" verifications

These three are already fixed in code. They are open only because nobody has confirmed them on
hardware, so each is a few minutes of tapping rather than any work.

## V1. kora#171 — a deleted account must not keep firing reminders

**Use the disposable account below. Do NOT delete your own.**

Both halves of the fix are in: `app/delete-account.tsx:101` cancels every locally-scheduled reminder,
and `src/lib/push.ts:141` gates the notification-tap handler on auth state (with a test asserting
reminders do not re-arm while signed out).

1. Sign out, then sign in as the test account below.
2. **Settings → Reminders**, and add a custom reminder a few minutes into the future. Make sure it is
   enabled and you have granted notification permission.
3. **More → Profile → Delete account**, and complete it.
4. **Wait past the reminder's time with the app closed.** Nothing must fire. A notification appearing
   here is the bug.
5. If any older Kora notification is still in Notification Centre, **tap it while signed out**. It must
   NOT deep-link into capture — you should land on sign-in.

Step 4 is the one that matters and the one that needs patience: it is a real OS-scheduled notification,
so there is no way to hurry it.

## V2. kora#170 — background polling and stale data

Fixed in build 21 (`src/lib/appFocus.ts` mirrors AppState into react-query's `focusManager`).

1. Open Kora, note the day's figures.
2. Background it — home screen, use another app — for **more than two minutes**. Under two minutes
   proves nothing; iOS has not suspended the process yet.
3. Return to Kora.
4. Data should refresh promptly and the notification badge update. The failure this guards against is
   the opposite: phantom timeouts logged to Sentry from polling a suspended process.

Worth glancing at Sentry afterwards — this bug's original signature was timeout events, not anything
visible on screen.

## V3. kora#137 — the denied photo-library card must clear

**Cannot be tested on a simulator**, which is why it is still open: `simctl privacy revoke photos` is
not enough, because modern simulators supply a working fake camera, so the library path is never
reached.

1. **iOS Settings → Privacy & Security → Photos → Kora → None.**
2. In Kora: capture → **Photo** → choose from library. The persistent denied card appears, with an
   Open Settings route.
3. Tap **Open Settings** from that card, and grant photo access.
4. **Return to Kora.** The denied card must be gone.

The failure is the card persisting after the permission has been granted, leaving the user stuck on a
screen telling them to fix something they have already fixed.

## Test account for V1

Created 2026-08-16 in `kora-app-e6d38` specifically so the deletion test does not cost a real account.

```
email:    kora.deletetest.20260816@example.com
password: KoraDelete!2026qa
uid:      AICL4vPfI1OSk5XnpRbKYIDrDus2
```

It has no data, so nothing is lost when it is deleted — which is the point of the test. If the deletion
path fails midway, the identity may survive: check with the runbook at
`docs/runbooks/kora-firebase-identity-deletion.md`, and note the two-project trap it documents
(identities live in `kora-app-e6d38`, workloads in `tesseracthub-480811`).
