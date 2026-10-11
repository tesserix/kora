# Handoff — Kora, R4 body composition

You are picking up work on **Kora** (`/Users/Mahesh.Sangawar/personal/tesserix-new/kora`),
a nutrition-tracking iOS app: Go API + Expo/React Native, pre-launch, one tester.

## Where the work stands

`main` is at `e3eafbf4`. The current focus is **R4 – Body composition**.

| slice | state |
|---|---|
| 1. Schema + storage | **merged** (#316) |
| 2. Manual entry + trends UI | **merged** (#329) |
| 3. Screenshot reader (#314) | **next** |
| 4. InBody / DEXA | after #314 |

**Not yet in any TestFlight build.** Build 37 is the latest (`459a280`); slice 2
merged after it. Cut one with:
`gh workflow run ios-release.yml --ref main -f profile=production -f submit=true`

## Milestone sequence — and why it is this order

```
R4 (+#153) ──┐
             ├──► R5 sharing ──► R6 Closed beta ──► R7 / R8 ──► R9 Release
Nutrition  ──┘      (#326)          (1 month)       if time
quality
```

Each milestone's GitHub **description** carries its own reasoning; read them
before re-planning. `R3` was renamed **R9** because launch prep is last
chronologically. **#328** is the closed-beta epic and pins entry/success
criteria deliberately up front.

The user's priority is **features over accessibility**, stated explicitly.
Accessibility issues are parked, not dismissed — do not spend time there unless
asked.

## Decisions already made — do not relitigate

- **Progress photos: dropped from #45 entirely**, not deferred.
- **Uploaded screenshots are NEVER stored** — processed in memory, discarded.
  Two consequences recorded on #314: content-hash caching still works (it caches
  the *resolution*, keyed by hash), and offline queueing is impossible, so
  body-composition upload is **online-only** and must say so rather than fail
  silently.
- **#314 uses the vision LLM, not OCR.** The hard problem is associating a number
  with its label across layouts, not reading digits. Reuse `IdentifyPhoto` in
  `api/internal/ai/provider.go`. Reasoning is on #314.
- **The model must return only what is legible and never infer.** A vision model
  asked for ten fields will compute BMI from weight and height. That defeats the
  derive-don't-store rule the schema is built on.
- **`BodyCompositionForm` is #314's confirm surface**, already built and merged.
  It is presentational — values in, payload out. Pre-fill it; do not build a
  second surface. A metric the reader could not see must be **omitted** from
  `initialValues`; a `0` there is written as a real measurement.

## Repo traps that cost real time to rediscover

- **Never run prettier.** No config exists; it silently swallowed an edit.
- **Jest performs no layout.** A green suite says nothing about clipping,
  wrapping or fold position. See the blind-spot note at the reanimated mock in
  `apps/mobile/jest.setup.js` (#257). Animated transforms are invisible to it.
- **Worklet directives**: any named function called from inside a worklet needs
  its own `"worklet"` directive, even in the same file. See `gauge.ts`.
- **The golden harness requires iPhone 17 Pro Max** and refuses other devices.
  It only captures the **widest** iPhone at default zoom, so horizontal
  truncation can never fail a golden (#322). Two booted simulators makes it
  refuse — shut the others down.
- **Capture goldens the way you compare them.** `--routes <one>` captures that
  route alone; the comparison captures the whole walk, and they differ (#310).
  Regenerate with a bare `npm run shots:golden`.
- **Dev client caches its bundle URL at :8081**, not the :8083 some docs say.
- **`idb ui text` truncates silently at ~13 characters**, and fields retain
  content across a failed attempt so re-typing appends. Clear with ~40
  `idb ui key <udid> 42` first, and read the a11y tree between steps because an
  error banner shifts every coordinate.
- **A signed-in simulator fixture is scriptable** — recipe in
  `apps/mobile/shots-golden/README.md`. Create the account via Firebase REST,
  then drive the ordinary sign-in screen. Delete it when done.
- **`main` moves from another source.** Five coach/agent PRs (#339–#343) landed
  mid-session from elsewhere. Pull before branching and expect company.

## Working practices the user expects

- Dispatch subagents for implementation (a global preference), review each diff,
  then merge. One agent per branch; do not let two share the working tree — a
  `git checkout` will yank it from under a running agent.
- **Mutation-check new tests**: break the fix, confirm the test goes red, restore.
  Report the result. Several bugs this session were only caught this way.
- Verify on the simulator when the claim is visual. Jest cannot see it.
- Single-line conventional commits, no signature, no `Co-Authored-By`.
- File issues for what you find rather than fixing silently out of scope, and
  put the *measurement* in them, not the impression.

## Suggested first move

Read `gh issue view 314` **including comments** — they carry the OCR-vs-LLM
decision, the cost analysis and the no-storage constraint. Then #327 (sleep
double-counts overlapping HealthKit samples; needs interval-union, and
`HKStatisticsQuery` is unavailable because sleep is a category type) is a
well-specified bug if you want something smaller first.

Also open: **#309** (draft, offline barcode) waits on a device test with a real
barcode — it is not in any build. **#344** is someone else's open PR.
