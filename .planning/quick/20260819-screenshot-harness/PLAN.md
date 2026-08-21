---
quick_id: 260819-ssh
slug: screenshot-harness
date: 2026-08-19
refs: kora#257
---

# A screenshot capture harness, and the noise data needed to decide what to assert

First step on #257. **This task builds the capture half only.** It deliberately
does NOT add pass/fail assertions — see "Why not goldens yet".

## The problem #257 describes

Correctness that lives in a layer jest does not run is invisible to the suite.
The evidence is no longer theoretical:

- A `useAnimatedStyle` transform clipped every TickRuler end label ("Lose
  weight" → "veight") and passed 1,729 tests.
- `Text.tsx` double-scaled every line box in the app for months. Five tests
  asserted the doubling **as the contract** and stayed green — the suite was not
  silent, it was confidently wrong (#260).
- `PlanDial` has never painted a single pixel on device, and a perf issue was
  filed against its render cost (#270).

Every one of those was caught in minutes by looking at a screenshot.

## What to build

A script — `apps/mobile/scripts/` — that captures a named set of screens at a
named content size, unattended.

Shape (adapt if the repo suggests better):

    node scripts/shots.mjs --content-size medium --out .shots/medium
    node scripts/shots.mjs --content-size accessibility-extra-large --out .shots/axl

It should:

1. Take the target simulator udid from a flag or env, defaulting to the booted
   one. **Refuse to run on anything but an iPhone 17 Pro Max** unless forced —
   testing on the narrower Pro actively conceals this class of bug, and that
   mistake has already cost a wrong conclusion in this repo.
2. Set the content size and **relaunch the app** — a content-size change does
   not reflow a running app.
3. Walk a declared route list, screenshotting each.
4. Write a manifest (route, content size, file, timestamp) alongside the images.

**Navigate by deep link, not by tapping.** Today's work showed
`xcrun simctl openurl <udid> "<scheme>://recipes"` reaches a screen directly and
reliably, where scripted tapping is brittle and coordinate-dependent. Note
`app.json` declares `"scheme": "mobile"` while sessions have successfully used
`com.tesserix.kora://` — establish which actually works and use it.

Routes to cover initially — keep the list in one obvious, editable place:
`sign-in`, `onboarding`, the four tabs, `recipes`, `settings`, `profile`,
`notifications`, `about`, `coach`, `ai-usage`, `feedback`.

## The auth problem — do not over-engineer it

Most routes need a signed-in app. Do NOT script signup: it is slow and its three
traps (truncated `idb ui text`, iOS's "Use Strong Password?" stealing the typed
value, coordinates shifting with the keyboard) make it the least reliable part
of every session so far.

Instead **assume the simulator is already signed in** and say so plainly in the
usage text: sign in once by hand, then the harness is repeatable. Routes that
land on sign-in when unauthenticated should be captured anyway and flagged in
the manifest rather than failing the run.

## The deliverable that matters most: a noise report

Before anyone writes an assertion, we need to know the noise floor. Measured
today: two full-screen captures of the **same screen with identical code** differ
by ~1px antialias ghosting across 3,933 pixels above threshold. Naive golden
diffing would be flaky immediately.

So: capture the same route **three times in a row without changing anything**, at
both content sizes, and report per-route:

- max per-channel delta
- count of pixels above a few thresholds
- whether the diff is spatially concentrated (a real difference) or scattered
  (antialias noise)
- whether a relaunch between captures changes the answer versus captures within
  one launch

Write this up as a short report in the branch. **It is the input to deciding
whether #257 gets golden diffing, crop-limited diffing, layout assertions, or
stays a human-review contact sheet.** Do not pick that strategy here.

## Why not goldens yet

Committing golden images before knowing the noise floor produces a suite that
fails randomly, gets muted, and then hides the next bug — a worse outcome than
having no checks, because it looks like coverage. The noise report is the cheap
thing that prevents it.

## Constraints

- `.shots/` output must be gitignored. Do not commit captured images.
- Do not wire this into CI in this task. #262 added a macos-26 runner which makes
  a CI simulator job possible later, but that decision needs the noise data too.
- Do not modify app source to make capture easier. If something is unreachable,
  report it.
- The dev client on the test simulator is stale and lacks `expo-linear-gradient`
  (red "Unimplemented component" boxes) and shows `expo-dev-menu`'s draggable
  FAB. Both are environment artefacts, not app bugs — but the FAB MOVES between
  sessions and will wreck a naive diff. Say so in the report; consider whether
  the harness should mask that region.

## Acceptance

- A working capture script producing both content sizes unattended.
- A route manifest that is obvious to extend.
- A noise report with real numbers and a recommendation for what #257 should
  assert.
- Nothing committed to `.shots/`; no app source changed.
- Atomic commits, single-line conventional messages, NO signature, NO
  Co-Authored-By trailer.
