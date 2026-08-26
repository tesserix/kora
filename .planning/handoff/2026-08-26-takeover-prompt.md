Take over Kora (`/Users/Mahesh.Sangawar/personal/tesserix-new/kora`) — a
pre-launch nutrition iOS app, Go API + Expo/React Native. One real user: the
owner. The repo is PUBLIC, so never put a real weight, measurement or intake
value in a commit, comment, test fixture, issue or PR.

**Read `.planning/handoff/2026-08-26-r6-console-integration-shipped.md` first.**
It covers what shipped, the decisions not to relitigate, and the repo traps.
`main` is at `cc1a7ca7`.

## Your task: make ordinary Australian food resolve correctly

R6 is done (ten issues closed, the console integration is live and verified in
production). The remaining gate on the closed beta (#328) is the **Nutrition
quality** track — 6 open, 0 closed — and #328 names it as the reason the cohort
exists at all: *"the Nutrition quality track at a state where ordinary food
resolves correctly."*

Start with **#235**, then **#234**. They are the same defect class: the ranker
picks a confidently-wrong row for everyday food.

- **#235** — `bacon and egg roll` resolved 3× against the prod index: correct
  once, then `Chiko roll` twice **at `auto` tier**. Auto tier means it logs
  without asking, so a tester's data is silently wrong. The correct row
  (`Bacon & egg roll`, AUSNUT) is in the index.
- **#234** — `chips` ranks `Banana chip` first (0.41), then corn chips. No hot
  chips in the top 5. Confirmed in `api/testdata/eval/ranking.out.tsv`.
- **#219** (precision term / headToken mis-ranking) is plausibly the shared
  cause; **#212** (model entity type, locale, query intent) is the
  architectural fix. Try to fix #235/#234 through #219 before reaching for #212.

There is an eval harness: `api/internal/ai/eval_ranking_test.go` and
`api/testdata/eval/`. It already exercises these exact phrases.

## Verify every issue's premise before planning

This is not generic advice. In one session, **six** issues had a central claim
that no longer held — including one I asserted wrongly myself. In this track
specifically:

- **#97's headline is already done.** It claims 3,820 of 7,898 items embedded
  (2026-08-04). The live index is **26,187 items, 26,187 embedded, 0 missing**.
  Its *second* bug is still real: `cmd/embed` has a bare `os.Exit(0)` on the
  give-up path, so a Job reports Complete having embedded nothing.
- Check #219, #234, #235 and #212 against the code and the eval output before
  designing anything.

## Traps that will cost you time on this task

- **Stubbing `ai.Provider` hides real failures.** A stub once hid three shipping
  blockers. Smoke-test through `ai.Router`.
- **`score`, `rankKey` and `confidence` are three different things** and are easy
  to conflate. `ai.TierFor` owns the confidence decision; do not re-derive
  thresholds elsewhere.
- **Two postgres answer on 5432.** The dev DB is the native Homebrew one and has
  **zero embeddings**; `5433` is the test DB (docker `kora-pg-test-r45`, may need
  `docker start`). Never point migrations or tests at 5432.
- `config.Load()` does not read `.env` — `source .env` before running the API by
  hand. `pkill -f "go run"` kills the wrapper, not the binary: find it with
  `lsof -nP -iTCP:8080 -sTCP:LISTEN`.
- **gopls lies in this repo.** Confirm every diagnostic with `go build`.
- **Never run prettier.** No config exists and it has silently swallowed an edit.
- `Closes #1, #2` only closes #1 — each needs its own `closes`.
- `gh pr merge --auto` does not gate here (no required checks), so it merges
  immediately. Wait for `gh pr checks` yourself.

## Verification bar

**Mutation-test your tests.** Three tests written in one session passed while
checking nothing — a mock that intercepted no module, a double-press test that
let state commit before the second press, and a test that returned at an earlier
branch than the one it named. Each looked green. Break the exact property a test
claims and confirm it fails.

Also: check the exit code, not the summary; a skipped test is not a pass; run DB
suites twice and confirm tables return to zero.

## Two things outstanding, not yours unless they bite

- The `api` CI job for #464 (conformance in CI) was **still running** at handoff.
  If `main` is red, that step is where to look — it boots the API and runs
  `@tesserix/admin-conformance`. It was green locally: 8 passed, 0 failed.
- Kora's Prometheus metrics are exported correctly and **collected by nobody**
  (observability parked at 0 pods; GMP not enabled). Do not build a dashboard.
  Product data still lands in Postgres — see `docs/runbooks/kora-product-metrics.sql`.

Next local iOS build needs `npx expo prebuild -p ios` (the `ios/` dir was
deleted to reclaim disk; it is gitignored and regenerable).
