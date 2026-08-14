# Device test plan — TestFlight build 19

Ordered by consequence, not by screen. Each item states the **specific failure to look for** — a
vague "check it works" is how #154 passed twice while being untested.

Account currently in prod: `a5U406v831…` / `mahesh.sangawar@gmail.com`, no logs, **not onboarded**.

---

## A. Do these before logging anything

### A1. Onboarding sends the device timezone (verifies kora#84's onboarding half)

You are in Sydney and the server default is `Australia/Sydney`, so onboarding normally proves
nothing — the correct value and the fallback are identical.

1. **Change the device timezone** to something else first (Settings → General → Date & Time →
   off auto → London)
2. Complete onboarding
3. Check: `select email, timezone from users;`

**Pass:** `Europe/London`. **Fail:** `Australia/Sydney` — the client isn't sending it, and every
account will keep defaulting, which is the bug that made all 8 prior accounts Sydney.

Set the timezone back afterwards.

### A2. kora#106 — account deletion actually deletes the identity

Known broken as of today (see the issue), so this is a re-test after the fix, not a first look.

1. Note the current Firebase UID before deleting
2. Delete the account in-app
3. Firebase console → Authentication

**Pass:** the identity is gone. **Fail:** still listed with the same UID — deletion is destroying
Kora data while leaving the account alive, which is an App Review rejection risk.

Also confirm the app signs you out and lands on sign-in rather than a broken authenticated state.

---

## B. App Review gates

### B1. kora#114 — branded provider buttons

Both **Sign in with Apple** and **Continue with Google** must carry the official marks and wording.
Apple's HIG makes the branded Sign in with Apple button mandatory; a generic button is a routine
rejection — on the very feature added for Guideline 4.8 compliance.

### B2. Sign-in edge cases

- Cancel the Apple sheet mid-flow → app returns to sign-in cleanly, no spinner stuck
- Cancel Google likewise
- Airplane mode → tap a provider → an honest error, not a silent no-op

### B3. kora#137 — denied photo library recovers

**The simulator cannot test this** (granting terminates the app there), so device is the only way.

1. Deny photo access
2. Capture → Photo → tap viewfinder → denied card appears, viewfinder gone
3. Settings → grant photo access
4. Return to Kora **without force-quitting**

**Pass:** card clears, viewfinder returns. **Fail (or void):** if iOS restarts the app on grant, the
test proves nothing — note that rather than recording a pass.

Repeat for camera and microphone: those are *expected* to restart the app, which masks the same bug.
If they don't restart, they need the same fix as photo.

---

## C. Core flows a beta cannot break

### C1. Capture — all four modes

**Photo**, **Voice**, **Scan** (barcode), **Type**. For each: does it resolve, and does the result
match what you gave it? Scan needs a real barcode — a packaged item from the kitchen.

Watch for: a spinner that never ends, a resolve that returns nothing with no message, or a portion
that is obviously wrong.

### C2. kora#158 — dismissing a pending resolve

Meal → **Ask Kora again** → submit → dismiss the sheet **while the spinner is up**, all three ways:
backdrop tap, swipe down, and (Android) back.

**Pass:** sheet closes, nothing hangs, and no result appears afterwards on a sheet you dismissed.

### C3. kora#83 — failed actions say so

Airplane mode on, then tap: pin a food, send a friend request, accept/decline, leave a group, join
or leave a challenge, remove a member.

**Pass:** a toast — "Couldn't reach Kora. Check your connection." **Fail:** a tap that does nothing
and says nothing, which is what this issue was.

Also confirm the button re-enables rather than staying greyed out.

### C4. Offline queue (kora#22 / #111)

1. Airplane mode
2. Log a meal → it should appear in the diary as queued
3. Turn airplane mode off
4. It should drain and become a real log — **without duplicating**

Then the harder variant: log offline, **force-quit before reconnecting**, reopen, reconnect. The
queue is durable, so it must still drain.

### C5. kora#84 — the day a meal belongs to

1. Log a meal
2. Confirm it appears on **today** in the diary
3. Confirm **Trends** and the **streak** agree it was today

These three disagreed until this morning, and the fix reached prod at 07:09Z. A meal visible in the
diary but missing from the streak is the failure.

Worth doing once **near midnight** if you get the chance — that's where day boundaries actually bite.

---

## D. Widgets and notifications

### D1. kora#140 — widget Steps

With **Health permission denied**, the Steps metric must render as denied/unavailable, **never `0`**.
A zero is a lie: it says "you took no steps" when the truth is "I can't see".

Then grant Health and confirm it shows real steps.

### D2. Widget after sign-out

Sign out. The widget must not keep showing the previous user's calories — there is explicit
scrub-on-sign-out logic and it is worth confirming on a real home screen.

### D3. Notifications

Open the inbox; the unread badge should clear. Tap a notification and confirm it deep-links to the
right place.

---

## E. Crash reporting

### E1. kora#104 — a readable stack in Sentry

Force a crash, then check Sentry (`tesserix/kora`).

**Pass:** the event arrives **with a symbolicated frame** — real file and line.
**Fail:** minified bundle offsets, which means source maps did not upload. Build 19 is the first
build to attempt the upload, so this is genuinely unverified.

Also worth confirming a *handled* error reports: airplane mode, trigger an API failure, and check it
appears as a non-fatal.

---

## F. Cheap sanity passes

- **Rotate / large text** — Settings → Accessibility → larger text, then walk the main screens for
  clipped or overlapping copy
- **Cold start time** — how long from tap to usable
- **Backgrounding mid-capture** — background during a resolve, return; nothing should be stuck
- **Sign out → sign in** as a different account: no data from the previous user anywhere (diary,
  widget, streak)

---

## Recording results

For anything that fails, capture: what you did, what you expected, what happened, and a screenshot.
For anything that **passes**, note *how you know* — the trap this session kept hitting was
observations that looked like passes but proved nothing.
