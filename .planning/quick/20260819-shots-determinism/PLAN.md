---
quick_id: 260819-sdt
slug: shots-determinism
date: 2026-08-19
refs: kora#257
---

# Stage B — make the screenshot harness deterministic

Follow-on to #272, which built the capture harness and measured its noise floor.
Stage C (golden diffing on a block-density rule) is blocked on this.

## What #272 established

- **Within one launch the renderer is deterministic** — 84 comparisons, not one
  pixel above 4/255. Pixel comparison is viable; that was not a given.
- Across launches, differences come from **content**, not rendering:
  - *App state*: a route catching `Loading…`/`Retry` instead of its loaded
    screen. `ai-usage` at AXL differed by 47.8% of frame this way.
  - *Sub-pixel drift*: ±0.25 device px, edge-only, on screens with a large
    composited card. Frame-wide but low density.

So the job is not tolerance tuning. **The job is making the same route render
the same screen.**

Full data: `.planning/quick/20260819-screenshot-harness/NOISE-REPORT.md`.

## Work items, in priority order

Do them in this order and commit atomically. **If you run out of road, stopping
after item 2 with a clear report is a good outcome** — items 3 and 4 are
lower-value and one of them may not be worth doing at all.

### 1. A readiness gate (highest value, cheapest)

`shots.routes.mjs` currently carries a per-route `settle` in milliseconds. A
fixed timer is the direct cause of every `Loading…` capture: it is simultaneously
too slow for static screens and too fast for a cold fetch.

Replace it with a **readiness selector polled from the accessibility tree** —
`idb ui describe-all` exposes it, and per-route you can wait for a known element
to exist (and optionally for a known "loading" element to be *absent*) before the
shutter, with a timeout that FAILS the capture loudly rather than shooting
anyway.

A capture that fails honestly is far better than one that silently records the
wrong screen — the whole point of Stage C is trusting these images.

Keep `settle` as an optional extra dwell for animation, but it must no longer be
the primary mechanism.

### 2. A deterministic clock (found while planning this; the noise report missed it)

`app/(tabs)/index.tsx:44` renders "Good morning" / "Good afternoon" /
"Good evening" from `new Date().getHours()`, and `:47` renders a date like
"Wed, Aug 19". **A golden captured this morning fails this afternoon, and every
route showing a date fails tomorrow.**

This matters more than it sounds for Stage C specifically: a changed date string
is *spatially concentrated*, which is exactly what the block-density rule is
designed to flag. Left alone it would trip on every run.

`xcrun simctl` cannot freeze the clock. So this needs to be app-side and
strictly test-only. Options, pick with reasons:

- an env-gated fixed clock (`EXPO_PUBLIC_SHOTS_CLOCK=...`) that a date helper
  consults
- routing all display dates through one helper that the harness can pin
- accepting the variance and having Stage C mask those regions — **weakest**,
  because masking loses real coverage exactly where text is most likely to
  overflow

Whatever you choose, it must be impossible to enable in a production build, and
say in the code how that is guaranteed.

### 3. Fixture data instead of prod

Prod returns different data over time and can be down (it 503'd mid-session
during #266). Determinism wants canned responses.

Note the auth boundary before designing this: Firebase auth is separate from the
API. A signed-in simulator plus `EXPO_PUBLIC_API_URL` pointed at a local fixture
server should work, because the fixture server can ignore the bearer token — the
app stays genuinely signed in while its data becomes canned.

Keep the fixture set small and obvious. Do NOT build a general mocking framework.

### 4. The dev-menu FAB and the stale dev client — INVESTIGATE, do not assume

`expo-dev-menu`'s draggable FAB sits **over app content** (it overlaps the
notification bell on `tab-today`). #272 recommended removing rather than masking
it, because a fixed mask also hides real UI.

Find out whether it can be disabled by configuration in a dev client. If it
cannot, say so — the alternative is capturing from a release-style build, which
trades away Metro's fast reload and is a bigger decision than this task should
make alone. **Report the trade-off; do not unilaterally switch the harness to
release builds.**

Separately, the dev client on the test simulator is stale and lacks
`expo-linear-gradient`, so some screens render a red "Unimplemented component"
box. That is a **one-time rebuild**, not harness engineering — do it if it is
quick (`npx expo run:ios --device "iPhone 17 Pro Max"`), otherwise note it.

## Constraints

- **No production behaviour change.** Every mechanism here is test-only and must
  be provably inert in a release build.
- Do not add golden images or assertions — that is Stage C.
- Do not modify app source beyond what items 2 and 3 genuinely require, and keep
  those diffs small and obviously test-gated.
- `.shots/` stays gitignored.

## Acceptance

- Three consecutive across-launch runs of the full route list where every route
  renders its loaded screen, with the run failing loudly if one does not.
- Date/greeting-bearing routes byte-stable across those runs.
- A short report: the new across-launch noise numbers versus #272's, and whether
  Stage C's block-density rule is now viable.
- Atomic commits, single-line conventional messages, NO signature, NO
  Co-Authored-By trailer.
