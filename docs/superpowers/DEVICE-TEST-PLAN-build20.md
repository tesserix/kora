# Device test plan — TestFlight build 20

Ordered by consequence, not by screen. Each item states the **specific failure to look for** — a
vague "check it works" is how #154 passed twice while being untested.

## What is already proven, and what still needs you

Five fixes ship in this build. Three were verified end to end on the **iPhone 17 Pro Max simulator**
against the **production** API, including the values that landed in the database. Do not re-derive
those; spend device time on what a simulator structurally cannot show.

| Issue | Verified on sim | Still needs the device |
|---|---|---|
| #164 accept button | Yes — enabled on arrival, submitted, DB correct | Confirm on real hardware only |
| #165 ruler readouts | Yes — 30 years / 170 cm / 70 kg | **Imperial** units (sim ran metric) |
| #166 segmented contrast | Yes — solid pill | **Real screen, real brightness, outdoors** |
| #168 widget dash overlap | No — native, needs a build | **Everything** |
| #170 background polling | No — needs wall-clock backgrounding | **Everything** |

Prod currently holds one account, `kora-simtest@tesserix.dev` (goal `muscle_gain`, goal weight
75 kg, onboarded). Delete it before or during testing — see F1.

---

## A. The fixes in this build

### A1. #164 — the accept button no longer waits for every ruler

1. Fresh install, sign in with a **new** account, reach the plan screen
2. **Touch nothing.** Tap "Start with this plan"

**Pass:** the button is live on arrival and submits.
**Fail:** greyed until each ruler is dragged.

Then confirm the values persisted equal the values displayed:

```sql
SELECT birth_year, height_cm, weight_kg, goal, goal_weight_kg, pace_kg_per_week, target_kcal
FROM users;
```

**The trap this fix must not spring:** a button that enables but submits zeros is worse than the
original bug, because it silently corrupts the plan instead of blocking it. `birth_year` must be
`<this year> - 30`, not 0. `pace_kg_per_week` must be non-zero — it was previously omitted, which
decoded to Go's zero value server-side and collapsed the deficit to plain TDEE. **`target_kcal` must
match the number shown on screen.** That equality is the real test: it proves screen and server agree.

### A2. #164 follow-up — goal weight stays coherent

Two paths that previously failed on values the user never chose:

1. Select **Build muscle**, touch nothing, submit -> goal weight must be **above** current weight
2. Under **Lose weight**, drag current weight **below** the default goal weight, submit -> must stay
   coherent, no validation error

**Pass:** both submit cleanly.
**Fail:** "Your goal weight is below/above your current weight" on defaults you never set.

Then confirm the opposite: set a goal weight explicitly, change the goal and the current weight, and
check your value is **not** silently overwritten.

### A3. #165 — rulers show their value

Drag each ruler slowly. **Pass:** a numeric readout updates live and matches what is submitted.

**Imperial is the untested case.** Switch to ft/in and lb and confirm the readout is sane: height
reads like `5'7"`, weight in whole lb. Known and accepted: imperial rounds, so 70 kg displays as
`154 lb` (154.32 exact) — the readout matches the ruler, the residual gap is the pre-existing
imperial scale, not new.

Regression check: **VoiceOver must still announce each value.** The announcements already worked;
the fix adds the visual readout and must not disturb them.

### A4. #166 — segmented control selection

Glance at Male/Female. **Pass:** unambiguous without a second look. Check at **minimum brightness**
and **outdoors** — the sim cannot reproduce either, and the old state measured ~1.2:1 contrast,
effectively invisible.

**This control is shared.** The same change lands on **settings, feedback and progress**. Look at all
three for anything that now reads too heavy. `FloatingTabBar` deliberately keeps its softer active
state (it also carries icon tint, stroke, scale and an accent dot) — that is intentional, not a miss.

### A5. #168 — widget dash no longer overlaps the dial hub

1. Force the unknown-steps state (HealthKit denied, or no data), add the widget

**Pass:** the placeholder sits clear of the centre hub in **both small and medium** families.
**Fail:** the dash crosses the hub.

Regression checks:
- Known values must not shift — check a wide one like `10,000`. It now renders at ~0.92 scale
  (small/large) and ~0.84 (medium); `minimumScaleFactor(0.6)` absorbs it, so **no truncation**.
- **iOS 18 tinted/vibrant home screen** — the system recolours widget content and this was not
  verifiable off-device.
- At full deflection the needle tip reaches the readout band and is occluded by the digits.
  Pre-existing and unchanged in kind. Look at it and decide whether it matters; it is not a
  regression.

### A6. #170 — no background polling, no phantom timeouts

1. Open the app, background it, leave it **>2 minutes**
2. Foreground it

**Pass:** no `TimeoutError` in Sentry, and no `/v1/notifications/unread-count` traffic while backgrounded.
**Fail:** timeouts keep appearing.

**The regression is the real risk here.** Over-aggressive pausing trades phantom timeouts for silent
stale data, which is worse and harder to notice. On foreground, data must refresh **promptly**, and
the notification badge must still update within ~60s during active use. If the badge goes stale,
that is a worse bug than the one being fixed.

---

## B. Still outstanding from build 19

Unchanged by this build; all still need the device.

- **#140 — widget Steps, the DENIED case specifically.** Settings → Privacy → Health → Kora → Steps
  **off**. What was tested before was the *undetermined* state, which is a different code path.
- **#137 — denied photo library recovers.** Deny, open capture, grant in Settings, return **without
  force-quitting**. If iOS restarts the app on grant, the test proves nothing — record that rather
  than a pass. Repeat for camera and mic, which are *expected* to restart and therefore mask it.
- **#114 — branded provider buttons.** Both marks looked correct on the simulator sign-in screen;
  confirm on device. A generic Sign in with Apple button is a routine rejection.
- **#104 — a symbolicated crash.** Force a crash, confirm a real file and line in Sentry. Minified
  frames mean source maps did not upload.
- Capture (all four modes), **#158** dismissing a pending resolve, **#83** failed actions say so,
  offline queue, **#84** the day a meal belongs to. Sections C–E of the build-19 plan still apply.

---

## C. Known-unfixed — expected to reproduce

Do not file these again; confirm they still behave as described.

- **#171 — deleted account still fires local reminders.** Delete the account, stay signed out, wait
  for a reminder time. A notification firing, and tapping it landing on **capture** while signed out,
  is the known bug. Queued for the next build.
- **#172 — fixed-point vertical layout.** Content is pinned in points, so the Pro Max's extra 82pt of
  height becomes empty space rather than larger content. Measured: the sign-in button is **47.7pt on
  both** Pro and Pro Max. Note where the voids are worst — that is the input to the #167 design pass.

---

## D. Observation pass for #167 (flatness)

No code change ships for this. While testing, note **where** surfaces read flat, and whether the
cause is contrast, hierarchy, or simply empty space (#172). Resist reaching for a material —
measure first. Liquid Glass would reduce contrast on a surface that already has a contrast problem.

---

## E. Cheap sanity passes

- Sign-in: cancel Apple mid-flow, cancel Google, airplane mode → an honest error, no stuck spinner
- Widget after sign-out
- Notifications arrive and deep-link correctly **while signed in** (the signed-out case is #171)

---

## F. Account hygiene

### F1. Delete `kora-simtest@tesserix.dev` — and re-test #106 for free

Delete it **through the app's own flow**, not the console. That re-tests the #106 fix on a second
account:

```bash
# Firebase identity must be gone (no "users" key in the response)
curl -s -X POST "https://identitytoolkit.googleapis.com/v1/projects/kora-app-e6d38/accounts:lookup" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "x-goog-user-project: kora-app-e6d38" -H "Content-Type: application/json" \
  -d '{"localId":["<uid>"]}'
```

```sql
SELECT firebase_uid, email FROM users;   -- row must be gone
```

**Pass:** identity gone, row gone, and Apple emails you if the account used Sign in with Apple.
**Fail:** identity survives — #106 has regressed, which would mean the IAM grant on `kora-app-e6d38`
was lost. See `docs/runbooks/kora-firebase-identity-deletion.md`.

---

## Recording results

For each item: **pass**, **fail**, or **void**. "Void" is a real and useful outcome — a test whose
preconditions did not hold (iOS restarted the app on permission grant, no reminder fired in the
window) proves nothing, and recording it as a pass is how #154 survived two rounds of testing.

A green result is only trustworthy if you know what the failure would have looked like.
