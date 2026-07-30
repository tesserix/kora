# HANDOFF — 2026-07-30 (Kora coach deploy pending + R1 status)

## TL;DR — the ONE immediate task

The **#51 coach backend is merged to `main` but NOT deployed**. The running `kora-api` pod is the pre-coach image, so `/v1/coach/*` returns **404** in prod. Deploying = **manually rebuild + push the image** (CI is dead) then roll the Deployment. Blocked this session only because the user's **Docker Desktop engine was wedged** ("unexpected error / failed to fetch extensions", daemon never served). User is rebooting to fix Docker.

**Once Docker is healthy, run exactly this (nothing else is needed — no migration, schema stays v17):**
```bash
# gh active account must be the personal one for GHCR push:
gh auth switch --user mahesh-sangawar
gh auth token | docker login ghcr.io -u mahesh-sangawar --password-stdin
# cross-build amd64 for GKE, push :latest (context is api/):
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
docker buildx build --platform linux/amd64 -t ghcr.io/tesserix/kora/kora-api:latest --push api/
# roll the plain Deployment (pullPolicy: Always pulls the new :latest via the ghcr-remote mirror):
kubectl rollout restart deploy/kora-api -n kora
kubectl rollout status deploy/kora-api -n kora --timeout=120s
```
**Verify (this is the proof the coach is live):**
```bash
# 404 (old image, route absent) -> 401 (new image, route exists, needs auth) means success:
/usr/bin/curl -s -o /dev/null -w '%{http_code}\n' https://kora-api.tesserix.app/v1/coach/nudges
# regression sanity (must stay 200):
/usr/bin/curl -s -o /dev/null -w '%{http_code}\n' https://mark8ly.com
```
Gotcha: the AR `ghcr-remote` pull-through mirror can serve a **stale `:latest` manifest**. If after rollout the coach route still 404s, the mirror didn't refresh — bump `kora.tesserix.app/redeploy-at` in `tesserix-k8s/charts/apps/kora-api/values-prod.yaml` (a values-only PR) to force a fresh Revision, or delete the pod again after a short wait. Current running digest (pre-coach) is `sha256:43d45c5e39ebf142f27b38c1e59f7d41cbf05677c467a2ba26c05fda995a0488` — a successful deploy changes it.

Alternative that removes the Docker dependency entirely: **fix the GitHub billing block** (Settings → Billing) — that revives CI, which builds+pushes on merge automatically (also unblocks the TestFlight path).

---

## What shipped this session (all merged)

- **#19 public routing — DONE & LIVE.** kora-api was unreachable (Knative↔ambient mismatch + missing netpol + missing gateway/authz rules). Fixed across tesserix-k8s PRs **#134 + #135** (admin-merged past branch protection with user OK): Knative Service → plain Deployment + ClusterIP `kora-api-direct`, direct VirtualService, `allow-kora-ingress` NetworkPolicy, 3 kora-ns L4 AuthorizationPolicies, and a gateway public-API rule for `kora-api.tesserix.app /v1/*`. Verified live: `/health`+`/ready`→200, `/v1/dashboard`→401, `mark8ly.com`→200. Full playbook saved in memory `kora-ambient-reachability`.
- **#23 guardrails — DONE (merged, PR #53).** Onboarding non-medical disclaimer + `api/internal/guardrails` Protective policy package.
- **#51 coach backend — BUILT & MERGED (PR #55), DEPLOY PENDING.** New `api/internal/coach/` package: `GET /v1/coach/nudges` (deterministic real-number nudges, guardrail-filtered, no LLM) + `POST /v1/coach/ask` (Gemini over deterministic grounding block, budget-gated + guardrail-gated, returns citations). Added `ai.Provider.GenerateText`, exported `guardrails.AtRisk`. All 27 coach tests + guardrails + ai pass against real Postgres. Spec: `docs/superpowers/specs/2026-07-30-kora-coach-design.md`; plan: `docs/superpowers/plans/2026-07-30-kora-coach.md`.
- **EAS API URL — DONE (merged, PR #54).** `apps/mobile/eas.json` wires `EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app` into `preview`/`production` build profiles. Config-only; no build runs until credits (~Aug 8).

kora `main` HEAD at handoff: `3bb457c`.

## Coach follow-ups (filed by the final whole-branch review — acceptable for R1, all protectively biased)

1. `FastingStreakDays` counts today's partial (not-yet-logged) day as fasting → can raise `show_support` by time-of-day. Only ever *more* protective; never hides support or surfaces restrictive content. Refine: don't count today until the day is over.
2. `RecentDeficitPct` applies today's single kcal target across the 7d window (schema has no historical targets). Bias is protective.
3. `looksRestrictive` (the Q&A restrictive-answer detector) is a coarse substring lexicon; the system prompt is the primary defense. Broaden or add a lightweight classifier later.

## R1 – "Friends & family beta" board

| Item | State |
|---|---|
| #19 deploy | ✅ live |
| #23 guardrails | ✅ merged |
| #51 coach backend | ✅ merged — **deploy pending Docker** (see TL;DR) |
| EAS API URL | ✅ merged (build waits on Aug 8 credits) |
| Coach **mobile UI** | ○ next feature slice — nudge cards on home + Q&A input, calling `/v1/coach/{nudges,ask}` (snake_case bodies: `{nudges:[{text,reason}],show_support}` / `{answer,citations:[{label,value}],show_support}`) |
| #43 metrics | ◑ data captured (billing.Event + logs); needs Grafana/tesserix-home exposure |
| #22 offline queue | ○ not started |
| TestFlight drop (~Aug 8) | needs: this coach deploy (optional for TF), `eas init` (owner/projectId unset), Aug 8 credits, GH billing fix to revive CI |

## Access / gotchas (still current)

- **gh has TWO accounts.** `mahesh-sangawar` (personal — can create PRs on tesserix/*, and is the GHCR push identity) vs `Mahesh-Sangawar_civica` (EMU — can push, cannot open PRs on tesserix repos). Run `gh auth switch --user mahesh-sangawar` before `gh pr create` / GHCR login.
- **kora repo PRs are user-merged** (they merged #53/#54/#55). **tesserix-k8s** was admin-merged with explicit user consent (squash-merge only; serves live mark8ly prod; ArgoCD GitOps — change manifest → PR → merge → hard-refresh the app).
- **GitHub Actions is DEAD** (billing block). CI never builds/pushes → images must be built manually (Docker, above). User must fix billing to restore.
- **Auto-mode classifier DISABLED** this session — agent may run gh/gcloud/kubectl/DB directly.
- kubectl context `gke_tesseracthub-480811_asia-south1_tesseract-prod-in-gke`; project `tesseracthub-480811`. Repos under `/Users/Mahesh.Sangawar/personal/tesserix-new/{kora,tesserix-k8s,australis}`.
- **Go test DB:** repo idiom uses `TEST_DATABASE_URL` (default `postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable`), `t.Skip` if PG absent. This session used local Homebrew `postgresql@18` (started then STOPPED at end). To run coach/DB tests: `brew services start postgresql@18`, create role/db (`CREATE ROLE kora LOGIN PASSWORD 'kora_dev' SUPERUSER; CREATE DATABASE kora OWNER kora;`), `DATABASE_URL=... go run ./cmd/migrate`, then `TEST_DATABASE_URL=... go test ./internal/coach/...`. Do NOT run full `go test ./...` or `cmd/seed` (breaks nutrition tests — see memory `kora-food-index-test-state`).
- kora ns is network-policy-restricted; test the public path externally, not from inside the kora pod.

## Australis (parked)

`github.com/tesserix/australis` (engine) stays parked until Kora is public AND a real 2nd tenant wants grounded assistance. The coach (#51) is deliberately a thin in-Kora module, NOT Australis.
