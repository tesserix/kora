# Device test plan — TestFlight build 26

Seven mobile fixes, all found by testing build 25 on hardware, plus a server-side change that is
**already live in production** and needs no build at all.

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

## B. What this build fixes

### B1. Correcting a food actually works now (kora#189, kora#190)

Both found while you exercised the corrected-row flow on build 25.

- **Change a row, pick a replacement, then tap Change on that row again.** The search must pre-fill
  with the food that is on the row **now** — not the one you rejected.
- **A hand-picked row now has a portion control**, and takes the new food's own serving rather than
  inheriting the replaced food's. Check the diary afterwards: swapping a 170 g item for a drink must
  not log 170 g of the drink.

### B2. The review screen (kora#192, kora#193, kora#194)

Reachable only by draining an offline capture — queue in airplane mode, reconnect, tap the diary row.

- **The header must sit below the status bar.** The clock and battery were drawing on top of "Review
  capture".
- **One primary action, not two.** "Add N items to diary" is gone from the embedded card; Confirm and
  Discard are the screen's own pair.
- **A capture made in the small hours must not default to BREAKFAST.** Anything from midnight to 11am
  used to. Record a clip after midnight and check the slot.

### B3. The offline barcode message (kora#191)

- Airplane mode, scan a barcode you have never scanned. The message must **not** promise to handle it
  later — nothing is queued on that path. It should say to scan again once back online.

### B4. Data sources are attributed (kora#197)

- **More → About.** Three sources listed, Open Food Facts shown with its Open Database License. This is
  a licence obligation, not a courtesy — OFF data is now serving to users.

---

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
