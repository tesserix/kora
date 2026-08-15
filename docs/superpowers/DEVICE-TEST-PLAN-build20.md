# Device test plan — TestFlight build 20

Ordered by consequence, not by screen. Each item states the **specific failure to look for** — a
vague "check it works" is how #154 passed twice while being untested.

## Building this one locally

Build 20 is the first build off the **local** path, which does not consume the hosted EAS quota:

```bash
source ~/.kora-build-env          # exports SENTRY_AUTH_TOKEN
cd apps/mobile
eas build --platform ios --profile production --local
eas submit --platform ios --profile production --latest
```

**`SENTRY_AUTH_TOKEN` must come from the shell.** It is stored as a *Secret* EAS environment variable,
and Expo does not pass secret-visibility variables to local builds — confirmed in this build's own log,
which lists only the Plain-text and Sensitive vars as loaded from EAS. Without the export the build
still succeeds and silently skips the source-map upload, which is exactly kora#104's failure mode.

Never use a raw `expo prebuild` + Xcode Archive instead: `apps/mobile/.env` sets
`EXPO_PUBLIC_API_URL=http://localhost:8080`, and the production URL lives only in eas.json's `env`
block, so a raw archive ships a TestFlight build pointing at localhost.

## What is already proven, and what still needs you

**Twelve issues ship in this build.** Some were verified end to end on the iPhone 17 Pro Max simulator
against the production API, including the values that landed in the database. Do not re-derive those.

| Issue | Verified on sim | Still needs the device |
|---|---|---|
| #164 accept button | Yes — enabled on arrival, submitted, DB correct | Confirm on hardware |
| #165 ruler readouts | Yes — 30 years / 170 cm / 70 kg | **Imperial** units (sim ran metric) |
| #166 segmented contrast | Yes — solid pill | **Real screen, brightness, outdoors** |
| #167 surface tokens | **No** — only sign-in borders seen | **Every panel-heavy screen** |
| #168 widget dash | No — native | **Everything** |
| #170 background polling | No — needs wall-clock backgrounding | **Everything** |
| #171 deleted-account reminders | No | **Everything** |
| #172 spacer cap | Measured only | Whether it reads better at all |
| #173 accessibility text sizes | Yes — sign-in and onboarding | Other screens, unswept |
| #174 error states | Unit-tested only | **Needs a forced network failure** |
| #175 press feedback | Unit-tested only | **The feel — cannot be unit-tested** |
| #177 line height | Unit-tested only | **List-row heights may have shifted** |

Prod holds two test accounts, `kora-simtest@tesserix.dev` and `kora-a11y@tesserix.dev`. Delete both —
see F1.

---

## A. Highest-value checks

### A1. #174 — no fabricated zeros (needs a deliberate network failure)

This one cannot be checked by using the app normally; you have to break the network on purpose.

1. Open the app signed in, with real data on Home, Diary and Progress
2. **Enable Airplane Mode**, then force-quit and reopen
3. Look at **Diary** and **Progress**

**Pass:** an explicit "couldn't load" notice with a Retry on each. Totals show `—`, not `0`.
**Fail — and this is the bug:** `0 / 0 kcal`, a 0% progress bar, `0.0 L` water, a **"0/7 days"** streak,
or — the worst one — **"No weigh-ins yet"** on Progress when you have months of weigh-ins.

Then check the inverse, because the fix must not over-correct: with the network **on**, a genuinely
empty day must still say "Nothing logged" and a genuinely zero value must still read `0`.

Also check friends, groups, notifications and a challenge in Airplane Mode — each should say it could
not load, not that you have none.

### A2. #164 — accept the shown defaults

1. Fresh install, sign in with a **new** account, reach the plan screen
2. **Touch nothing.** Tap "Start with this plan"

**Pass:** the button is live on arrival and submits.

Then verify what persisted equals what was displayed:

```sql
SELECT birth_year, height_cm, weight_kg, goal, goal_weight_kg, pace_kg_per_week, target_kcal
FROM users;
```

A button that enables but submits zeros is **worse** than the original bug. `birth_year` must be
`<year> − 30`, `pace_kg_per_week` must be non-zero, and **`target_kcal` must equal the number on
screen** — that equality is the real test, because it proves screen and server agree.

Repeat with **Build muscle**, touching nothing: goal weight must land **above** current weight.

### A3. #167 — do the surfaces read as depth now?

The whole point of the change, and the least verified. Look at **Home, Settings, Diary** (panels and
recessed wells) and **onboarding** (gauge ticks).

**Pass:** cards read as raised off the page; wells read as sunk; gauge graduations are visible rather
than a lit needle floating on nothing.
**Fail:** still flat.

Computed: panel-vs-page went 1.06:1 → ~1.31:1, borders 1.27:1 → 3.07:1, ticks 1.47:1 → ~3:1. But
on-device `BlurView` samples what is behind the panel, which can only **reduce** that delta. If it
still reads flat, the honest conclusion is that translucency is the wrong material here — not that the
numbers need pushing further.

### A4. #177 — line heights changed on ~183 text nodes

**The regression risk of this build.** Leading now derives from the rendered font size.

**Look for:** list rows that have grown taller or now clip, text that runs together, and anything
misaligned in a row that mixes sizes. **Diary and Progress** are the places to look.

Specifically: on Progress, the weight figure must **not jump vertically** when data lands (it was
rendered by two different components with different line boxes).

### A5. #175 — do controls respond to the press?

Cannot be unit-tested; it is entirely a feel check.

Tap and **hold** each: the capture viewfinder, the mic, diary row pin/bookmark, the ± steppers, the
Toast's Undo. **Pass:** something visibly responds the instant your finger lands, before you lift.

The camera cap's haptic should now fire on **contact**, not on release. Dragging a ruler should feel
like texture rather than a buzz storm, and hitting min/max should give one distinct bump where it
previously went silent.

**Reduce Motion check** (Settings → Accessibility → Motion): buttons must still respond — a gentle
opacity dip, not nothing. Numbers and the gauge should cross-fade rather than snap.

### A6. #171 — a deleted account stops nagging

1. Sign in, complete onboarding, ensure meal reminders are on
2. Delete the account in-app
3. Stay signed out, background the app, wait for a reminder time
4. Also relaunch the app once while signed out

**Pass:** no notification fires at all, including after the relaunch — the re-arm on launch is gated on
being signed in. If one does fire, tapping it must land on sign-in, never capture, and never stack.

### A7. #168 — widget dash clear of the hub

Force the unknown-steps state (HealthKit denied, or no data), add the widget.

**Pass:** the placeholder clears the centre hub in **both small and medium**. Check a 4–5 digit value
like `10,000` still fits, and look at the **iOS 18 tinted** home screen, which recolours widget content
and was not verifiable off-device.

### A8. #170 — no background polling

Background the app for **>2 minutes**, then foreground it.

**Pass:** no `TimeoutError` in Sentry. **The regression is the real risk:** on foreground, data must
refresh promptly and the notification badge must still update within ~60s of active use. Stale data is
worse than the phantom timeouts this fixed.

### A9. #173 — accessibility text sizes

Settings → Accessibility → Display & Text Size → Larger Text, into the accessibility range.

Sign-in and onboarding were fixed and verified on the simulator. **Sweep the rest** — Home, Diary,
Capture, Settings, the widget — looking for clipped labels, controls that cannot be reached, and icons
escaping their buttons.

### A10. #165 / #166 / #172 quick checks

- **#165 imperial:** switch to ft/in and lb; the readout must be sane (`5'7"`, whole lb) and match what
  is submitted. VoiceOver must still announce each value.
- **#166 shared control:** the new selection also lands on **settings, feedback and progress** — check
  none reads too heavy.
- **#172:** sign-in only, and a partial fix. Content is still ~26% of the screen; the question is
  whether the top gap is less cavernous, not whether it is solved.

---

## B. Still outstanding from build 19

- **#140 — widget Steps, the DENIED case** (Settings → Privacy → Health → Kora → Steps **off**). What
  was tested before was the *undetermined* state, a different code path.
- **#137 — denied photo library recovers.** Grant from Settings, return **without force-quitting**. If
  iOS restarts the app on grant, the test proves nothing — record that rather than a pass.
- **#114 — branded provider buttons** on device.
- **#104 — a symbolicated crash.** Force a crash, confirm a real file and line in Sentry. **This is
  also the check that the local build's source-map upload worked** — minified frames mean the
  `SENTRY_AUTH_TOKEN` export did not take.
- Capture (all four modes), **#158**, **#83**, the offline queue, **#84**.

---

## C. Known-unfixed — expected to reproduce

- **#176** — the ruler still drags on the JS thread: no momentum after a flick, a hard stop at min/max
  rather than rubber-banding. Expected.
- **#178** — iOS "Increase Contrast" still does nothing.
- **#174 items 4–6** — `/log` still discards history on success; remove-member still unguarded;
  onboarding still has no exit.

---

## D. Account hygiene

### D1. Delete both test accounts — and re-test #106 for free

Delete **through the app's own flow**, not the console:

```sql
SELECT firebase_uid, email FROM users;   -- both rows must be gone
```

```bash
curl -s -X POST "https://identitytoolkit.googleapis.com/v1/projects/kora-app-e6d38/accounts:lookup" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "x-goog-user-project: kora-app-e6d38" -H "Content-Type: application/json" \
  -d '{"localId":["<uid>"]}'
```

**Pass:** identity gone, row gone. **Fail:** identity survives — #106 has regressed, meaning the IAM
grant on `kora-app-e6d38` was lost. See `docs/runbooks/kora-firebase-identity-deletion.md`.

---

## Recording results

For each item: **pass**, **fail**, or **void**. "Void" is a real and useful outcome — a test whose
preconditions did not hold proves nothing, and recording it as a pass is how #154 survived two rounds.

A green result is only trustworthy if you know what the failure would have looked like.
