# Device test plan — TestFlight build 28

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

## B. New in build 28 — untested

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
