---
quick_id: 260819-sdt
slug: shots-determinism
date: 2026-08-19
refs: kora#257, kora#272
status: items 1, 2 and 4 done; item 3 not started
---

# Stage B — making the screenshot harness deterministic

## Headline

**The readiness gate removed 100% of the app-state noise #272 measured.** Every
route that differed by 4–48% of the frame across launches is now byte-identical,
and — the part that matters — each one is *verified loaded* rather than
consistently broken.

Stage C's block-density rule is **viable**, with a 2.0x margin at `medium` and
4.6x at `accessibility-extra-large`.

## New across-launch numbers vs #272's

Same method: `--repeat 3 --relaunch-each-repeat`, worst pair of the three
passes, iPhone 17 Pro Max, 1320x2868. `diff%` is the share of the frame above
8/255.

### accessibility-extra-large — where #272's headline numbers came from

| route         | #272 diff% | now diff% | note |
| ------------- | ---------- | --------- | ---- |
| ai-usage      | **47.824** | **0.000** | gate required `QUOTA WINDOWS` + `Cached matches` |
| coach         | **35.306** | **0.000** | gate required `TODAY'S FOCUS` + `Conversation` + `Send question` |
| profile       | 9.489      | **0.000** | gate required `DAILY TARGETS` + `MEMBER SINCE` + `ACCOUNT` |
| notifications | 4.859      | **0.000** | |
| recipes       | 4.073      | **0.000** | |
| tab-today     | 0.000 †    | 0.407     | |
| tab-progress  | 0.000 †    | 0.445     | |
| tab-diary     | 0.000 †    | 0.272     | |
| tab-more      | 0.000 †    | 0.000     | |

† **These four are the trap, and the direction of travel is the opposite of what
the numbers look like.** #272's axl run scored all four tabs at 0.000% *because
all three passes showed "Couldn't load your profile"* — a perfectly stable
picture of a broken screen. They now show real, gate-verified content, and the
honest residual is 0.27–0.45%. A rise from 0.000% to 0.407% here is an
improvement, not a regression.

### medium

| route        | #272 diff% | now diff% |
| ------------ | ---------- | --------- |
| coach        | **24.077** | **0.000** |
| tab-today    | 0.801      | 1.101     |
| tab-progress | 0.781      | 0.433     |
| tab-diary    | 0.748      | 0.693     |
| other 10     | 0.000      | 0.000     |

`coach` was the large win. `tab-today` is discussed under "not deterministic"
below — it is worse than #272's figure and I could not close it.

Gate outcome across both runs: **69/69 captures ready, 0 failures, exit 0.**

## Is Stage C's block-density rule viable? Yes.

The rule: fail when any 60x60 block has >40% of its pixels above 8/255. One
block on this frame is 3585 px, so the rule trips at **1434 differing pixels in
one block**.

| content size | worst route  | >8 px  | densest block | density | margin |
| ------------ | ------------ | ------ | ------------- | ------- | ------ |
| medium       | tab-today    | 41,692 | 719 px        | **20.1%** | 2.0x |
| medium       | tab-diary    | 26,223 | 382 px        | 10.7%   | 3.7x |
| medium       | tab-progress | 16,377 | 364 px        | 10.1%   | 4.0x |
| axl          | tab-progress | 16,838 | 315 px        | **8.8%**  | 4.6x |
| axl          | tab-today    | 15,397 | 229 px        | 6.4%    | 6.3x |
| axl          | tab-diary    | 10,283 | 234 px        | 6.5%    | 6.1x |

Every other route is 0 differing pixels, so it has no density at all.

Two caveats to carry into Stage C:

1. **The margin is 2.0x, not the 3x #272 projected**, and it rests on one route
   (`tab-today` at `medium`). If Stage C wants headroom, either exclude the
   three GlassPanel screens from the block rule or set the threshold at 30%,
   which still leaves 1.5x over noise and sits well under the >50% density a
   clipped label produces.
2. Noise stays **spatially scattered** — 19–28% of blocks touched, but no block
   holds more than 2.3% of the differing pixels. That is the property the rule
   keys off, and it survived Stage B intact.

## What was done

### 1. Readiness gate (`scripts/shots.mjs`, `scripts/shots.routes.mjs`) — commit `fc09f66`

`settle` is no longer the mechanism. After navigating, the harness polls
`idb ui describe-all` until every string in the route's `ready` list is present
and no `NOT_READY` marker (`Loading…`, `Retry`, `Couldn't`, …) is. All 14 routes
carry selectors chosen to exist only after their data lands — a screen title is
a bad selector because it renders during loading too.

A route that never becomes ready is written to `<name>.not-ready.png`, recorded
`ready:false` with a reason in the manifest, and **exits 1**. Verified by
negative test with an unsatisfiable selector: correct filename, correct message,
exit code 1.

Also handled: idb's companion goes stale and the first `describe-all` after a
launch often fails to parse — retried 4x with backoff. And a 500ms nav grace, so
the first poll cannot read the outgoing route's tree.

**`settle` survives as an animation dwell, and it still matters.** With the gate
open but `settle` at 250ms, `tab-today` measured **1.005%** — worse than #272's
timer-based 0.801%. At 3000ms it dropped to **0.113%**. The gate answers "is the
content there", which on an animated screen is true long before the pixels stop.
The new default is 3000ms, derived from the longest one-shot entrance in the app
(`SpecularSweep` = 500ms delay + 1600ms = 2100ms).

Two smaller determinism fixes landed here: the **status bar is pinned** to 9:41
(the one clock `simctl` can freeze — otherwise it advances in the corner of
every frame), along with battery and signal bars.

### 2. Deterministic clock (`src/lib/shotsClock.ts`) — commit `5ed9b1e`

Chose **env-gated fixed clock routed through one helper** — both of the plan's
first two options, since one without the other is half a fix.

`now()` and `todayLocalDate()` consult `EXPO_PUBLIC_SHOTS_CLOCK`. Call sites
changed: `app/(tabs)/index.tsx` (greeting, date label, query date),
`app/(tabs)/diary.tsx` (week strip, selected day), `app/(tabs)/progress.tsx`,
`src/components/home/YourUsualStrip.tsx` (its meal slot is a function of the
hour). Masking was rejected for the reason the plan gives: it blinds the suite
exactly where text overflows.

**Scope is reads, not writes.** `logged_at`, the offline queue's `queuedAt` and
`localDateNow()` in request bodies are deliberately untouched — a dev with the
pin set must not file logs under a fabricated day, and the queue's replay
ordering needs a real monotonic clock.

**Inertness in production — three independent barriers**, stated in the file:
`__DEV__` is false in release so the pin is never read; Metro's minifier
constant-folds that branch away so the shipped bundle contains no pin logic;
and `EXPO_PUBLIC_SHOTS_CLOCK` appears in no `eas.json` profile, so it inlines as
`undefined`. 5 unit tests cover all of them, including the `__DEV__ === false`
case. An unparseable value throws rather than silently falling back.

Verified end to end, not just by unit test: with the pin at `2026-03-04T09:41`,
Home rendered `Wed, Mar 4 · Good morning, there` (real time was 19 August,
evening) and Diary's week strip rendered `2026-03-02 … 2026-03-08`.

### 4. Dev-menu FAB — RESOLVED, and no release-build trade-off is needed — commit `a55d701`

**The plan's feared decision does not have to be made.** The FAB is disablable
by configuration, in a dev client, with no rebuild.

`expo-dev-menu` reads `EXDevMenuShowFloatingActionButton` straight from
UserDefaults (`node_modules/expo-dev-menu/ios/Modules/DevMenuPreferences.swift`,
`showFloatingActionButtonKey`). Writing it false on the simulator is sufficient:

    xcrun simctl spawn <udid> defaults write com.tesserix.kora \
      EXDevMenuShowFloatingActionButton -bool NO

The harness now does this in `launchApp()`, after terminate and before the
launch URL — it must happen while the app is not running, or iOS's defaults
flush on termination clobbers it. Verified: the `gearshape.fill` node is gone
from the accessibility tree, and the notification bell and profile avatar on
`tab-today` — which the gear used to overlap — are fully visible in a clean
capture.

There is also an `Info.plist` route (the same key is read as a *registered
default* at setup), settable from `app.json` via `expo.ios.infoPlist`. It is
weaker: a registered default loses to any explicit UserDefaults value, so a
simulator where anyone ever toggled the FAB would ignore it. The direct write is
the reliable one.

Side effect, documented in the script: the preference is persistent, so after a
run the gear stays gone for interactive work too. The dev menu itself still
opens via shake or Cmd+D, and the restore command is in the file.

## What was NOT done

### 3. Fixture data instead of prod — not started

Deliberately traded away to do items 1, 2 and 4 properly, per the plan's
instruction. It is also now **less urgent than it looked**: with the readiness
gate in place, prod-backed captures were stable across three launches at both
content sizes with zero gate failures, so live data is no longer the top source
of nondeterminism. It remains worth doing for the reason the plan gives — prod
can 503, and it did during #266 — but it is now an availability fix, not a
determinism fix.

The auth-boundary note in the plan still holds and is worth keeping: a fixture
server can ignore the bearer token, so the app stays genuinely signed in.

### 4b. The stale dev client — BLOCKED on disk space, not on effort

The dev client still lacks `expo-linear-gradient`, so 9 of 14 routes carry a red
`Unimplemented component: <ViewManagerAdapter_ExpoLinearGradient>` LogBox box
over real content. The harness now detects and reports these (`renderErrors` in
the manifest, a loud summary line, and `--strict-render` to make them fatal),
but does not fix them.

The one-time `npx expo run:ios --device "iPhone 17 Pro Max"` **cannot run**: the
volume has **~250 MB free of 460 GB** and an Xcode build of this app needs
several GB. The disk also failed a capture run mid-flight
(`profile.03.png … No space left on device`). This needs a human to free space
before any golden is committed — the overlay would be enshrined otherwise.

## Not deterministic — named explicitly

1. **`tab-today`, `tab-diary`, `tab-progress` at `medium`: 0.4–1.1% of frame,
   irreducible so far.** Cause identified: `GlassPanel` renders `BlurView`
   (`expo-blur`), and a backdrop blur re-samples per launch. This is #272's
   "Cause B", now with a name. Evidence it is not animation timing: raising the
   dwell from 3000ms to **8000ms did not help** `tab-today` (0.951%). Evidence
   it is compositing: flat card background sampled at the same point reads
   `(95,21,24)` in one launch and `(94,21,24)` in the next — a 1-LSB shift
   across ~1.95M pixels, with only ~42k above 8/255. Low amplitude, frame-wide,
   scattered — harmless to the block rule, but it will never be byte-zero.
2. **`tab-today` is bimodal** — 0.113% in one three-pass run and 1.101% in
   another, same settings. Whatever selects the mode is per-launch and I did not
   isolate it. Treat 1.1% as the planning number.
3. **`useDailyIgnition` is a first-run hazard.** It fires a flourish once per
   local-day key, persisted in AsyncStorage. Because the clock is now pinned the
   key never changes, so it fires on the *first ever* capture against a fresh
   install and never again. It did not affect these runs (the key was already
   written), but a golden captured on a fresh simulator would differ from every
   later run. Clear `kora.ignition.lastPlayed`, or warm the app once, before
   capturing goldens.
4. **The LogBox overlay's own layout is not stable** — the error text wrapped at
   a different vertical position between passes, visible in the amplified diff.
   Another reason the rebuild in 4b must happen before goldens.

## Verification

- Full jest suite: **207 suites / 1807 tests pass**, including 5 new for
  `shotsClock`.
- `tsc --noEmit`: no errors in app source (pre-existing errors in the generated
  `.expo/types/router.d.ts` only).
- eslint on changed files: no new problems. The `react-hooks/refs` errors in
  `index.tsx` / `diary.tsx` / `progress.tsx` are pre-existing and at lines far
  from these edits.
- Gate negative test: unsatisfiable selector produces `.not-ready.png`, a named
  reason, and **exit code 1**.
- `.shots/` remains gitignored; no golden images or assertions added.

## Environment left as found

Content size restored to `medium`; the throwaway account
(`shotsb1@kora.test`) deleted through the app's own delete-account flow; the
dev-menu FAB preference restored to `YES` for interactive use; my Metro on 8083
stopped; the pre-existing Metro on 8082 untouched; all capture directories from
this session removed (#272's four baseline directories left in place).
