# HANDOFF — 2026-07-30/31 (coach deployed, CI fixed, coach UI PR1 in review)

## TL;DR

The previous handoff's one blocked task is **done**: the #51 coach backend is **deployed and live**. Along the way the "CI is dead from a GitHub billing block" belief turned out to be **wrong** — CI was failing on a duplicate migration, now fixed and merged. The coach **mobile UI** work is underway as 3 PRs; **PR 1 is open and awaiting review**.

**The one thing that needs YOU (not code):** GHCR won't let Actions push the image — see [Action required](#action-required-ghcr-package-access).

## Shipped this session

- **Coach deploy — LIVE.** Docker was healthy after the reset. Built amd64, pushed, rolled `deploy/kora-api`. `/v1/coach/nudges` and `/v1/coach/ask`: **404 → 401**. Digest `43d45c5e` → `f190410e`. No regressions (`/health` 200, `/v1/dashboard` 401, `mark8ly.com` 200). The feared stale `ghcr-remote :latest` manifest did NOT bite. Gotcha: routes return **503** for ~30s while the pod warms — wait and re-curl before concluding failure.
- **CI fixed and merged (PR #56, squashed as `584a1ba`).** `weight_entries` was created **twice** — `000002_phase1_core.up.sql` and again `000008_weight_entries.up.sql` — so every *fresh* DB died at migration 8, failing the `api` job's Test step, which gated `build-image`. That, not billing, is why images never built. Verified against prod before fixing: prod is genuinely **v17 clean** and its `weight_entries` has `body_fat_pct`, proving **000002 is authoritative and 000008 never executed there**. 000008 is now a documented no-op (its `down` was also actively wrong — it would `DROP` a table 000002 owns). After merge: **`api` passes on main**.
- **Coach UI design + PR1.** Spec `docs/superpowers/specs/2026-07-30-kora-coach-mobile-ui-design.md`; plan `docs/superpowers/plans/2026-07-30-kora-coach-nudge-enrichment.md`. **PR #57 open** (nudge enrichment). Race suite 29 ok / 0 FAIL, vet clean.

## Action required — GHCR package access

`build-image` now **runs** but fails at the push:

```
denied: permission_denied: write_package
```

Root cause: the GHCR package `tesserix/kora/kora-api` has **no repository linked** (`.repository == null`, visibility private). It was created by a manual laptop `docker push`, so `GITHUB_TOKEN` has no write access — regardless of the workflow correctly declaring `permissions: packages: write`.

**Fix (UI, ~1 min):** GitHub → `tesserix` org → Packages → `kora/kora-api` → Package settings → **Manage Actions access** → add repo `tesserix/kora` with the **Write** role.

**Durable extra:** add `LABEL org.opencontainers.image.source=https://github.com/tesserix/kora` to `api/Dockerfile` so future pushes auto-link.

Until then, deploys still work manually:
```bash
gh auth switch --user mahesh-sangawar
gh auth token | docker login ghcr.io -u mahesh-sangawar --password-stdin
docker buildx build --platform linux/amd64 -t ghcr.io/tesserix/kora/kora-api:latest --push api/
kubectl rollout restart deploy/kora-api -n kora
```
(`api/Dockerfile` sets `GOOS=linux` but not `GOARCH`, so `--platform linux/amd64` builds the whole Go stage under QEMU on an arm64 Mac — slow but correct.)

## Coach mobile UI — the 3-PR plan

Design decisions were made with the user: **enrich the backend** (not adapt the UI or duplicate coach logic client-side); **server-side thread history, store + replay only** (each `/ask` stays independently grounded, so guardrail tests keep their meaning); **`show_support` → persistent card** above the focus cards; **citations → chips** under Otto's bubble (following `ProvenanceChip`); **entry = `app/coach.tsx` pushed route + a home entry card**.

| PR | State |
|---|---|
| **1 — nudge enrichment** | **OPEN: #57.** `kind` + `title` on `coach.Nudge`, 30-day grounded `WeightTrend`, ED-risk-gated weight card, `Soften` now sanitises title+kind, `reason` off the wire |
| **2 — thread persistence** | ○ not started. Migration `000018_coach_turns` + `GET /v1/coach/thread`. Spec section written |
| **3 — Expo mobile UI** | ○ not started. `app/coach.tsx`, `src/components/coach/*`, home `CoachEntryCard`, TanStack Query hooks. Spec section written |

### Things PR 2 must know
- `/thread` must recompute `show_support` from **current** signals via `guardrails.AtRisk(SignalsFrom(ctx))`, NOT by calling `BuildNudges` — which now does an extra `WeightSeries` read per call. Never store `show_support`: a stale risk flag must not reappear, and a cleared one must not persist.
- Budget-degraded replies are **not** persisted (a UI state, not a turn). Neither is the user turn, so nothing is silently swallowed.
- Both turns commit in one transaction — no orphaned question without an answer.
- **Before adding the migration, check no earlier migration already creates `coach_turns`, and run the whole chain against a fresh DB.** That is exactly the class of bug PR #56 fixed.

### Things PR 3 must know
- `nudges` is always `[]`, never `null`.
- Kind values are `protein`, `fibre`, `weight_down`, `weight_up`, `today` (neutral, used when a nudge was softened). Map each to icon/hue/variant. **Neither weight direction may use a celebratory or shaming accent** — it's an ED-sensitive surface.
- `reason` is **no longer in the payload** (`json:"-"`) — don't code against it.
- Candidate order is protein → fibre → weight, now pinned by a test. The home card uses `nudges[0]` as its headline.
- `apps/mobile/AGENTS.md`: **read `https://docs.expo.dev/versions/v57.0.0/` before writing code** — Expo APIs changed. Stack is Expo Router 57 / RN 0.86 / TanStack Query v5 / `apiFetch` from `@/lib/api`.
- Mockup is `design-system/ui_kits/kora/CoachScreen.jsx` — the UI-fidelity gate requires reviewing against it before merge. Note its copy differs deliberately: no invented food suggestion ("one more Greek yogurt"), no forecast ("on pace for 75kg").

## Local environment left behind

- Docker container **`kora-pg-test`** on port **55432**, migrated to v17 — the test DB for the Go suite. `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable`. Remove with `docker rm -f kora-pg-test` when done.
- Branch `backup-coach-nudge-enrichment` is a pre-rebase safety ref for PR #57; delete once #57 merges.
- SDD ledger with full per-task review history: `.superpowers/sdd/progress.md` (gitignored).
- Still true: `go test ./...` needs a clean `food_items` table; do **not** run `cmd/seed` (breaks two nutrition tests).

## Still open from the R1 board

| Item | State |
|---|---|
| #19 routing / #23 guardrails / #51 coach backend | ✅ live |
| CI | ✅ `api` green on main; `build-image` blocked on the GHCR grant above |
| Coach mobile UI | ◑ PR 1 open, PRs 2–3 planned |
| #43 metrics | ◑ data captured; needs Grafana/tesserix-home exposure |
| #22 offline queue | ○ not started |
| TestFlight (~Aug 8) | needs `eas init` (`app.json` has no `owner`/`projectId`), Aug 8 credits, and the GHCR grant for CI images |

## Notes / gotchas confirmed this session

- `cfg.Env` is used in exactly **one** place — a log line in `cmd/api/main.go:97`. The prod pod logging `"env":"development"` is **cosmetic only**; no security or behavioural impact. Auth never reads it.
- Redis is unreachable in prod (`127.0.0.1:6379` refused) so caching is disabled. Graceful by design, but no cache layer is live.
- `gh` still has two accounts; `mahesh-sangawar` is the one that can open PRs on `tesserix/*` and is the GHCR push identity.
- Prod DB is **in-cluster** (`global-postgres-rw.global.svc.cluster.local`, ns `global`, db `kora_db`), not Cloud SQL. Query it directly: `kubectl exec -n global global-postgres-1 -c postgres -- psql -d kora_db -tAc '...'`. That is how prod's schema version was verified rather than assumed.
