# Device verification backlog

Everything currently gated on a physical phone, in one place. Thirteen open issues are held open
*only* because nobody has looked at them on hardware — no code work remains on several of them.

Ordered by consequence. Each item says the **specific failure to look for**, because "check it works"
is how #154 passed twice while being untested.

Build under test: **TestFlight 25**. Device: iPhone 17 Pro Max.

---

## A. Build 25's four fixes — untested code, highest risk

Three of these cannot be reproduced in a simulator at all: audio-session behaviour, keyboard geometry
and touch targets are hardware concerns.

### A1. Voice recording starts (#186)

Three consecutive builds failed here, each for a different reason. Treat a pass as provisional until
all four sub-checks are done.

- Hold the mic. Recording must start — failure is the toast **"Something went wrong starting the
  recording"**.
- **Ring/silent switch to silent, record again.** Not decoration: `playsInSilentMode` is half the fix
  and many people carry a phone on silent. An empty or silent clip is a fail.
- **Record, then play any audio.** Quiet playback, or sound from the *earpiece* instead of the
  speaker, means the session is not being released.
- **Switch capture mode mid-recording**, and **swipe out of the screen mid-recording**. Both must stop
  the recorder and release the session — repeat the playback check after each.

A failure now leaves a Sentry stack trace rather than nothing, so check Sentry before guessing.

### A2. Correcting a food is possible (#182)

- Tap **Change** on a row, type in the picker. **The results list must stay visible above the
  keyboard** — the failure is typing blind.
- Tap a result; it must apply to the row.
- Repeat on a short sheet (Weight log, Add friend, Rename group) — the fix is in `Sheet`, so all
  eleven inherit it.

### A3. Rows are selectable and the count is honest (#183)

- On a multi-item result, **uncheck one row** → CTA count drops by one → **add, then check the
  diary**: the unchecked row must not be there. A count that changes while the diary still gets
  everything is the original bug in disguise.
- **Uncheck everything** → CTA reads "Select an item to add", disabled.

### A4. The Change affordance is visible (#181)

- Bordered **Change** button with a chevron, not grey "tap to change" text.
- **Present on confident rows too** — most likely thing to have been missed.

---

## B. Fixed earlier, never confirmed on hardware

No code work left on any of these. They are open purely for want of a device.

### B1. #170 — focusManager / phantom timeouts
Background the app **more than two minutes**, return. Data must refresh promptly and the badge must
update. The failure is phantom Sentry timeouts from polling a suspended process. Needs real
backgrounding — a simulator does not suspend the same way.

### B2. #137 — denied photo-library card
Deny photo library → see the denied card → **grant it in Settings** → return. The card must clear.
Note the simulator genuinely cannot test this: `simctl privacy revoke photos` is not enough, because
modern simulators provide a working fake camera so the library path is never reached.

### B3. #104 — crash symbolication
**Force a crash and confirm the Sentry frame shows a real file and line**, not minified output. Source
maps are confirmed uploaded for build 25 via the API — this is the last link in the chain and the only
check that proves it end to end.

### B4. #158 — AskAgainSheet dismissal
Open AskAgainSheet, trigger a resolve, **dismiss it mid-flight**. The AI resolve must stop. This one
costs money when wrong. (Code looks correct — `handleClose` aborts before `onClose` — so this is
confirmation, not investigation.)

### B5. #22 — offline capture, pre-flight branch
**Airplane mode ON, then capture.** This is the `netinfo` pre-flight enqueue, which is *different*
from the already-confirmed mid-flight `NetworkError` path — the earlier verification used a blackholed
host, which leaves `onlineManager` online. There is no per-simulator network toggle, so only a device
reaches this branch.

You already confirmed airplane mode no longer sticks on the splash screen; this is the adjacent check
and is cheap while you are there.

### B6. #139 — cold start on a light-mode phone
Set the device to **Light**, clear any stored preference, **cold launch**. Look for a dark-splash →
light-app → dark-app flash. Invisible on a dark simulator, which is exactly why the first pass missed
it.

---

## C. Bugs to reproduce and characterise — not fixes to confirm

### C1. #173 — sign-in at accessibility text sizes **(beta blocker)**
Settings → Accessibility → Display & Text Size → **Larger Text**, near maximum. Then sign in. Look for
the clipped button label, the escaped Google icon, and the truncated footer. This is the app's entry
point — if it breaks, nothing else matters.

### C2. #184 / #180 — AI accuracy on real food
The product's core claim. Photograph and type real meals and record what comes back:
- A **branded/restaurant** item with a fraction and a side ("El Janah 1/2 chicken with Chips") — known
  to return butter chicken and potato crisps.
- A **packaged item with a label** you can read, to check the number against ground truth. The mini
  croissant now lands at 117 kcal against a 115.4 label.

### C3. #179 — transient provider failure
Hard to force deliberately. If a photo resolve ever fails with a 503, note whether the app retries or
simply dies — there is no retry and no fallback on the photo path today.

---

## D. Widgets (#187) — secondary gates

The blocking one (Health denied renders `—`, not `0`) **passed**, so Steps ships. These remain:

- **Steps with access GRANTED** — must match the Health app *and* Kora's Home screen. Worth doing:
  a wrong-but-plausible number is far harder to spot than `0`.
- **Sign out** → widget reverts to "Open Kora". A widget still showing a signed-out user's data is a
  lock-screen privacy leak.
- **Midnight rollover** — a stale snapshot must not render yesterday as today.
- **Lock Screen rectangular + inline** — legible under iOS's flat white mask.
- **iOS 18 tinted home screen, steps medium** — goal-hit bars (accent) vs normal bars (ink 55%) may
  collapse toward the same tint.
- **Long-press → Edit** switches metric across all families.

---

## E. Low priority

- **#111** — a copy judgement: `resultSummary`'s "from a scan you've done before" was written for the
  live capture thread and may read oddly on the review screen. No test can make this call.
- **#114** — social-login hygiene; the blocking items and the App Review gate are already done.

---

## Reporting

For each failure record: screen, what you did, what you expected, what happened. For anything in
capture, **check Sentry first** — several of these now leave a stack trace where they previously left
nothing, and the *absence* of a Sentry event is itself information.
