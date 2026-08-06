# Handoff — 2026-08-06

Take over Kora development at `/Users/Mahesh.Sangawar/personal/tesserix-new/kora`
(branch `main`, clean, everything pushed). Siblings: `../tesserix-k8s`,
`../tesserix-home`.

## START HERE

    .superpowers/sdd/progress.md    ← ledgers. Trust these and `git log` over
                                      anything else, including this file.
    ~/.claude/projects/.../memory/MEMORY.md

`main` is at `5de3230`. **Four PRs merged today**, across three repos:

- **kora #103** — food-data admin slice 2 (audited mutations, soft delete, cache
  generation). Merged AND DEPLOYED; migration is at **v23** in prod.
- **tesserix-k8s #167** — denies `/v1/admin/*` at the ingress gateway. Merged,
  synced, and **verified by traffic** (external 403, in-cluster 401, controls unchanged).
- **tesserix-home #71** — Kora food admin portal UI + audit page. Merged and live.
- **kora #110** — offline capture queue, #22 slice 2. Merged; **NOT deployed** and
  **NOT device-verified**.

## THE TASK

**Device-verify #22 slice 2, then close #22.** It is implemented, merged, and
122 suites / 809 tests green — and none of that proves it works. Do not close
#22 on the suite.

The feature: a photo or voice capture taken offline copies its media to
`documentDirectory`, queues durably, and resolves on reconnect. Tier `auto`
(≥0.90) hands off to slice 1's log queue; `confirm`/`follow_up` park for review;
failures keep their media. Every log is stamped with the CAPTURE time.

### The checks, in order. Physical device, airplane mode — not the simulator

`netinfo` reads the HOST's interface state and there is no per-simulator toggle
(`simctl status_bar --dataNetwork` only repaints the icon). Slice 1 left this
branch unverified on device for exactly this reason. Do NOT disable workstation
Wi-Fi; Mahesh declined that outright — it takes down the agent's own connectivity.

1. Capture in airplane mode → a pending row appears on **today**.
2. **Force-quit and relaunch while still offline** → the row survives. This is
   what the `documentDirectory` copy exists for.
3. Reconnect → an `auto`-tier capture appears as a **SERVER row**, not a stuck
   queued one. **This is the most important check on the list.** A defect that
   would have lost every capture (the capture id was passed as the log-queue id;
   the server binds `*uuid.UUID`, so it 400s permanently AFTER the media is
   deleted) was invisible to all 809 tests and was found only by reading the Go
   handler's binding. Only a real round-trip proves it fixed.
4. A `confirm`-tier capture waits for review and does NOT move the day total.
5. `ai_usage_events` shows exactly ONE `identify_photo` per resolved capture.
   Two means the in-flight guard leaked and Gemini was billed twice.

Then close #22. **#111** holds its deferred follow-ups; leave that open.

## AFTER #22

R1 is **11 open / 2 closed**. R0 is closed (0 open / 4 closed — #20 was verified
done and closed today). Mahesh's stated order, with two adjustments I recommended
and he has not yet ruled on:

- **#105 (Redis) BEFORE #43.** Redis is unreachable in prod — the pod dials
  `127.0.0.1:6379` expecting a sidecar that is not in the Deployment. Every
  resolve is a forced cache miss, so every one costs a Gemini call. It also makes
  the slice-2 generation-counter machinery inert. Measuring cost/latency (#43)
  against a configuration you do not intend to ship measures the wrong thing.
- **#43** instrumentation — unblocked now that #81 and #82 are closed. Taxonomy
  already decided: two counters, `resolution` and `derived`.
- **#51** coach mobile UI — decide explicitly whether this is R1 or R2. The
  08-04 handoff called it "a differentiator, not R1-blocking" but it still sits
  in the milestone.
- **#83** — 13 mutation sites with no error surface; `isPending`-gated buttons end
  up permanently disabled. A friend hitting this sees a dead app.
- **#104** crash reporting — there is NO Sentry/Crashlytics/Bugsnag anywhere.
  Ship it in the same build as #109 or the first beta failures are invisible.
- **#108** social login (Apple + Google via GIP) — must land BEFORE the first
  external install, or existing accounts need linking afterwards. Apple
  Guideline 4.8 means Google alone is a rejection.
- **#106 / #107** are App Review gates and prerequisites of #109, not peers of it.
- **#109** EAS build + TestFlight — **this is the actual R1 gate**; R1's own
  definition is "TestFlight to ~10-30 F&F". Start the Apple-side paperwork early;
  its queue time is not yours to control.

## ENVIRONMENT

    Postgres (Go tests):  TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'
                          Container `kora-pg-test`. Run `go run ./cmd/migrate` first.
    Go:      cd api && go test -race -p 1 ./...    (foreground)
    Mobile:  cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit
             — currently 122 suites / 809 tests green, must stay green
    Expo deps: `npx expo install <pkg>`, never plain npm install
    `npx expo lint` REGENERATES apps/mobile/eslint.config.js, untracked ON
      PURPOSE. Never commit it — check `git status` before staging.

**Metro:** use port **8083**. 8081 and 8082 are taken by Home-Chef-App, and
`expo run:ios` has silently attached to another project's Metro before, serving
a bundle pointing at `vendors.fe3dr.com`. Verify by grepping the SERVED BUNDLE,
never Metro's startup line:

    curl -s "http://localhost:8083/node_modules/expo-router/entry.bundle?platform=ios&dev=true" \
      | grep -oE '"EXPO_PUBLIC_API_URL": \{ enumerable: true, value: "[^"]*"'

**Database is NOT Cloud SQL.** The workspace CLAUDE.md describes the marketplace
services and is wrong for Kora. Kora is on self-hosted CloudNativePG: cluster
`global-postgres` in ns `global`, primary pod `global-postgres-1`, database
`kora_db`, **shared** with devai/homechef/mark8ly/stockpilot. Keep prod queries
cheap. Note ns `kora` also has a `kora-postgres-1` — that is the not-yet-cut-over
cluster and it is EMPTY. Querying it will mislead you; I lost time to this today.

**Deploying kora-api.** `image.tag` on the live ArgoCD Application is pinned to a
commit SHA, and the parent `kora-app-of-apps` has `ignoreDifferences` on
`/spec/source/helm/parameters`, so a git merge neither resets nor advances it.
Currently pinned to `4c9cecfd` (#103); `main` is at `5de3230`, so **#110 is merged
but not deployed** — it is mobile-only, so no API deploy is needed for it.

    kubectl -n argocd patch application kora-api --type=json \
      -p='[{"op":"replace","path":"/spec/source/helm/parameters/0/value","value":"<sha>"}]'

Then verify the RUNNING DIGEST, filtering pods by `ownerReferences[].kind ==
ReplicaSet` — the `app.kubernetes.io/name=kora-api` label also matches Job pods
and a seed Job will produce a false green.

**A real deploy-ordering hazard, unfixed.** During #103's deploy the new pod
became Ready at 02:18:03Z and the migrate Job completed at 02:18:04Z — one second
later. The Job is `sync-wave: -1` and the Deployment has no wave annotation, so
ArgoCD should have gated it and did not. Harmless that time (v23 is additive, the
old pod served the window) but a slower migration puts a v23-expecting pod in
front of a v22 schema. Worth filing.

## PROCESS

Mahesh's global CLAUDE.md mandates **subagent-driven execution** for plans
(`superpowers:subagent-driven-development`). Note this session's operator config
says not to use the Agent tool unless he asks — he asked explicitly, so agents
were used. Confirm before assuming.

Commits: conventional prefix, **single line**, no body, no trailers, no signature.
PRs are merge-committed here (not squashed).

## THE LESSON FROM TODAY, WHICH COST THE MOST

#110 was executed by 8 subagent tasks with a review after each, then a
whole-branch review. **Nine defects were found, and every one was in the PLAN,
not in the implementers' work.** Four would have shipped broken:

- The capture id used as the log id — **every capture permanently lost**, after
  its photo was deleted. Found by reading the Go handler's binding.
- `AuthTokenError` beats `NetworkError` past `getIdToken()`'s ~1h cache — so the
  feature worked in short offline tests and was **dead on a flight**, the exact
  case it exists for.
- `source: "photo"` instead of `"ai_photo"` — silently buckets to "other"
  server-side and corrupts the metric #43 exists to produce.
- `sweepOrphans` asserted *called* rather than *called with* — a two-line test
  gap in front of deleting every queued capture at cold start.

The recurring authoring mistake was one shape: **an assertion whose expected value
equals the initial state cannot distinguish "it worked" from "nothing ran yet."**
Three tests asserted `rows` equals `[]` where `rows` starts as `[]`; one survived
its mutation only because the fixture date happened to be that day's real date.

So: when you write a test, reason BACKWARD from "what implementation would make
this pass while broken?" When you assert an absence, first reach a state where a
wrong implementation would produce a PRESENCE. And treat a surviving mutation as
a finding to raise, never a row to pass over — before you call it an environment
limitation, check the mutation actually targets the code path the test exercises.
That specific error happened twice today.

## LOOSE END

A `statusline-setup` agent was mid-run configuring `~/.claude/settings.json`.
The version installed at handoff shows model + context but is MISSING the
requested directory and git-branch segments, and it shells out four times per
render with no graceful degradation if `jq` is absent. Either finish it or revert
`statusLine` — it is cosmetic and blocks nothing.
