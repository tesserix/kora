# Golden screenshots

Committed reference images for the screenshot harness (kora#257 Stage C).
One PNG per route per content size, at **1x (440x956)** — box-averaged 3x3 down
from the simulator's native 3x capture. `manifest.json` records the device,
runtime, clock pin and rule parameters they were produced with; a comparison
against a capture that differs in any of those is refused rather than fudged.

## What a golden is a function of

This is the contract. A golden here reproduces given **all** of:

- iPhone 17 Pro Max on iOS 26.2 (the comparator refuses another device)
- content size `medium`
- `EXPO_PUBLIC_SHOTS_CLOCK=2026-08-19T09:41:00`, set for **Metro** as well as
  for the harness — Metro inlines it into the bundle
- a **freshly created account, onboarded by accepting every default** (see
  below)

Anything a golden depends on that is NOT in that list is a defect in the golden
set, not a tolerance to widen. Three such dependencies were found and removed in
the #289 follow-up: the status-bar battery glyph (now masked), the signed-in
email (`profile`, `tab-more` — excluded), and the server's real calendar date
(`ai-usage` — excluded).

### The account fixture

**Scriptable since kora#299 — the manual recipe below is the fallback, not the
first resort.** Sign-UP is what resists automation, not sign-IN: iOS's "Use
Strong Password?" sheet only fires on a new-password field, and `idb ui text`
truncates long strings (measured: it stopped at 13 characters of a 34-character
address, silently). Both are avoidable.

Create the account out of band, then drive the ordinary sign-in screen:

```bash
set -a && . ./.env && set +a
EMAIL=s@kora.test          # SHORT. idb ui text truncates around 13 chars.
PASS=Shots1!               # >= 6 chars for Firebase.

curl -s -X POST \
  "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=$EXPO_PUBLIC_FIREBASE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"returnSecureToken\":true}"
```

Then, on the simulator: tap **Continue with email**, type both fields, tap
**Sign in**. Two things will catch you out:

- iOS raises a **"Save Password?"** system alert after signing in. It renders in
  another process, so `idb ui describe-all` returns *only* the Application node
  and the app looks hung. Screenshot to see it; dismiss "Not Now".
- The account lands on **onboarding**, which is correct for a new user. Change
  nothing and tap **Start with this plan** — see step 2 below.

Delete it the same way when done:

```bash
TOKEN=$(curl -s -X POST \
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$EXPO_PUBLIC_FIREBASE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"returnSecureToken\":true}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['idToken'])")

curl -s -X POST \
  "https://identitytoolkit.googleapis.com/v1/accounts:delete?key=$EXPO_PUBLIC_FIREBASE_API_KEY" \
  -H 'Content-Type: application/json' -d "{\"idToken\":\"$TOKEN\"}"
```

Note this deletes the auth identity only. Identities live in a different GCP
project from the rest of Kora, which has bitten account deletion before.

---

If you would rather do it by hand, the original recipe still works:

1. Sign-in screen → **Create an account** → any throwaway email and password.
   (iOS's "Use Strong Password?" sheet renders in another process and swallows
   keystrokes while the field still shows a plausible `•`. Screenshot the
   simulator to see it; dismiss it with the X, then retype.)
2. On the onboarding screen **change nothing** and tap **Start with this plan**.
   The defaults — Lose weight, Male, 30 years, 170 cm, 70 kg — are what produce
   the 1,957 kcal / 140 g / 227 g / 54 g targets these goldens contain. That is
   the entire fixture: there is no remembered input to get wrong.
3. Delete the account through the app's own delete-account flow when you are
   done, and confirm it is gone.

Verified: goldens captured under one account compare clean against a capture
taken with a **different** account created by the same recipe, after a Metro
restart and fresh app launches. Nothing in the committed set depends on who
captured it.

## Capture goldens the same way you compare them

`npm run shots:golden -- --routes <one>` captures that route **alone**. The
comparison run captures the **whole walk**. Those are not the same picture:
`feedback` renders about 26pt lower in the walk than it does solo — same content
size, same golden, both passing the ready gate — because it is reached with a
navigation stack behind it rather than as a fresh root.

So a golden re-captured with `--routes` will fail the next full comparison, and
the failure looks like a real regression. **Regenerate with a bare
`npm run shots:golden`** unless you are certain the route is insensitive to how
it was reached. (The underlying inconsistency is its own bug, not a harness
quirk to work around — see kora#310.)

## Check a build against them

```
# Metro must be started with the SAME clock pin — it inlines the value.
EXPO_PUBLIC_SHOTS_CLOCK=2026-08-19T09:41:00 \
EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app \
npx expo start --dev-client --port 8083

EXPO_PUBLIC_SHOTS_CLOCK=2026-08-19T09:41:00 \
npm run shots -- --content-size medium --out .shots/medium --port 8083

npm run shots:compare -- --candidate .shots/medium
```

## Accept a change

Only when you have looked at the images and the change is intended:

```
EXPO_PUBLIC_SHOTS_CLOCK=2026-08-19T09:41:00 npm run shots:golden -- --port 8083
```

There is no `--force` and no `--update` on the comparator, deliberately.

## Not every route is here

`manifest.json` lists the excluded routes and why, and the comparator prints
every reason on every run. The reasons live in `scripts/shots.goldens.mjs`;
each says what would have to change to bring the route back. A route is
excluded when it cannot hold still, or when it holds still only for the person
who captured it — never by loosening the rule until it passes.

## The rules

See `scripts/shots.goldens.mjs` for the numbers and the measurements behind
each one, and `scripts/shots-blocks.mjs` for why there are three of them.
In short: no pixel over 48/255, no more than 3% of the frame over 8/255, no
20px block more than 30% dense.

**Applied below the top 62 rows.** That band is the iOS status bar and the
Dynamic Island — drawn by the system, carrying no app information, and not
reliably controllable from the harness. #289 shipped a golden set that failed
all 13 of its routes on 243 pixels of it, because `simctl status_bar override`
reported a pinned battery state it had not actually rendered. The reasoning,
the measurements and the experiments that ruled out "pin it harder" are in
`GOLDEN.ignoreTop`. The mask does not blunt the rule: the one-character label
edit the suite is falsified against still fails at exactly 38 pixels with it in
place.

## Not wired into CI

Running this needs a booted iPhone 17 Pro Max, a dev client, Metro and a
signed-in simulator. kora#262's macos-26 runner makes it possible; whether it
is worth the minutes is a separate decision.
