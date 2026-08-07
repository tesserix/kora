# Handoff — 2026-08-07 (evening)

Take over Kora at `/Users/Mahesh.Sangawar/personal/tesserix-new/kora`.
Siblings that matter today: `../tesserix-home` (the admin portal), `../tesserix-k8s`.

Supersedes the **morning** handoff `HANDOFF-2026-08-07-auth.md`. Most of what that
document said was blocked is now done — read this one first, then that one only
for the auth-flow background.

## START HERE

    .superpowers/sdd/2026-08-07-auth-flow-redesign/progress.md    ← auth ledger
    .superpowers/sdd/2026-08-07-kora-feedback-triage/progress.md  ← feedback ledger

Trust those and `git log` over this file. `main` is at the #121 merge; kora-api in
prod runs `599c8a2a0dad85bf78bedcbaf3a27803a0645680`.

## WHAT SHIPPED TODAY

**Sign in with Apple is live.** The three secrets the morning handoff said did not
exist now exist in `tesseracthub-480811`:
`prod-kora-apple-team-id`, `-key-id`, `-private-key`.

They were **already in Firebase** all along — the Apple provider's `codeFlowConfig`
held real values. That was the confusion: Firebase's copy is used by Firebase, and
kora-api reads its own `APPLE_*` env from Secret Manager via ESO
(`api/internal/config/config.go:72-75`). Two consumers, one credential. They were
copied across by streaming the identitytoolkit response straight into
`gcloud secrets create --data-file=-`, so the private key never touched a
transcript or disk; the stored bytes were then validated with `openssl pkey`,
which is the same parse `appleid/client.go` does.

`tesserix-k8s#177` merged (`1141ddec`) after one real blocker: the chart changed but
`Chart.yaml` was still `0.1.3`, so `Lint Helm Charts` failed on a required version
bump. Bumped to `0.1.4`.

Verified, not assumed: `POST /v1/me/apple-authorization` went **404 → 401**, matching
the `/v1/me` control. And since kora-api *refuses to start* on a partial Apple config,
a pod booting at all proves all three values landed intact.

> **The morning handoff's inverted ordering constraint is now satisfied.** The API is
> deployed, so an Apple-capable build may ship. Before today, every Apple user created
> would have been permanently unrevokable.

**The auth flow redesign shipped.** PRs #119, #120, #121. Suite went **129 suites /
887 tests → 135 / 935**. Ten tasks: dot-grid `BrandMark` (the Lucide `sparkles` was
never Kora's mark), Apple's own HIG-compliant button, Google's dark-spec button,
labelled `Field`, a recomposed sign-in, the entry-gate render gate, a reframed link
prompt, onboarding labels, plus two rounds of post-simulator fixes.

**Google sign-in works.** It was never a code bug — see the prebuild trap below.

**`display_name` is seeded from the token.** #121. `verifier.go` extracted only the
`email` claim and discarded `name`, so Google users had no name anywhere: the home
screen said "Good evening, **there**" and the avatar rendered a hardcoded `"K"`
(`index.tsx:39`). Now seeded whenever `display_name` is empty — which repairs
existing rows, not just new ones — and never overwrites a name the user chose.

## OPEN PRS — MERGE ORDER MATTERS

| PR | Repo | Note |
|---|---|---|
| **tesserix-home#75** | portal | Nav fix. **Merge first** |
| **tesserix-home#77** | portal | Feedback page. After #75 — both edit `koraNav`, expect a trivial conflict |
| **kora#122** | kora | Feedback API. Independent, but **must deploy** before #77 works |

## THE TASK THAT IS STILL NOT DONE

**Device verification. Fifth session.** The iPhone
(`00008150-0005749C2684401C`) has never come online. Still queued:

1. **#22 slice 2** — five checks, airplane mode, Release build. `netinfo` reads the
   HOST interface, so the simulator cannot substitute.
2. **#108** — six checks in `specs/2026-08-07-social-login-design.md`.
3. **#106 slice 1** — confirm by query that `users.apple_refresh_token` is non-empty
   after a real Apple sign-in.

The simulator now runs the current build and Google sign-in completes on it.
**Apple cannot be tested on the simulator without signing it into iCloud** — the
failure you will see is `AKAuthenticationError -7026` / `AuthorizationError 1000`,
which is the no-iCloud-account signature, not a bug. The app maps it correctly.

## ENVIRONMENT — THINGS THAT COST TIME TODAY

**`expo run:ios` does NOT re-run config plugins.** This is the big one. The morning
handoff says "a native rebuild is needed" after #117 added the google-signin plugin
to `app.json`. That is **not sufficient and actively misleading**: `expo run:ios`
reuses an existing `ios/` directory as-is. Only `expo prebuild` re-runs the plugins.

The stale `ios/` was missing **both** the Google URL scheme and the
`com.apple.developer.applesignin` entitlement. Google sign-in failed with the
library's own message — *"Your app is missing support for the following URL schemes:
com.googleusercontent.apps.564299717841-k80q…"* — which the generic
`firebaseAuthMessage` fallback had been swallowing as "Something went wrong."

    npx expo prebuild -p ios --clean

is safe: `/ios` is gitignored (`apps/mobile/.gitignore:42`), never committed, and
fully derived from `app.json`. **Shipped builds were never affected** — EAS
regenerates it. This was a local-only staleness trap.

**Verify a PR's head SHA before merging.** #119 merged against a **stale head**:
GitHub's API still reported `5284754` while the branch was at `db42c1d`, so two
commits silently never reached `main` and the green tick was against the wrong code.
Recovered by #120. Compare `gh api repos/.../pulls/N --jq .head.sha` against
`git rev-parse HEAD` before merging.

**Go repository tests SKIP silently without `TEST_DATABASE_URL`.** They do not fail;
`go test` still prints `ok`. A bare `go test ./...` looks green while never touching
a single DB path. This produced a false "the mutation passed" result today.

    export TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'

CI is unaffected — `.github/workflows/ci.yml` runs a postgres service and sets it.
Separately, `internal/nutrition` has 6 tests gated by a *different* var,
`CALIBRATION_DATABASE_URL`; those skips are expected.

**ArgoCD can report `Synced/Healthy` at a revision that predates your merge.** After
#177 merged, the app sat green at `73297739` — `git merge-base --is-ancestor` proved
it predated the merge commit. It needed
`kubectl -n argocd annotate application kora-api argocd.argoproj.io/refresh=hard --overwrite`.
Also: after patching `image.tag`, the app may settle at `OutOfSync/Healthy` with the
operation `Succeeded` and the rollout **complete** — do not wait on `Synced`. Verify
the **running pod's imageID changed**, filtering by `ownerReferences[].kind == ReplicaSet`.

**`gcloud` is broken on this machine** for some commands —
`module 'importlib.metadata' has no attribute 'packages_distributions'` (the Python
3.9 deprecation). `gcloud secrets` works; `gcloud artifacts docker images describe`
does not. Use the registry API directly with `gcloud auth print-access-token`.

**Deploys silently consume the daily embedding quota.** Every ArgoCD sync fires the
sync-wave seed Job, which runs `seed → ingest → embed`. Today's two deploys drained
the full 1,000/day Gemini allowance between them. Current index state, measured:

    embedded 6,827 | missing 1,071 | total 7,898

That is roughly **one more full quota day**. Reset is midnight Pacific. `cmd/embed`
still treats any fully-failed batch as terminal and exits 0 reporting success —
#97's false green, unchanged.

## R1 — 11 OPEN

**Blocked only on the phone:** #22, #108, #114 (its branded-buttons item is now done).
**#106 slice 1 is deployed**; slice 2 (the deletion itself) has a spec, no plan.

**Not started, in Mahesh's order:** **#105** (Redis unreachable — the pod dials
`127.0.0.1:6379` for a sidecar that is not in the Deployment) **before #43**;
**#104 + #109 together** (crash reporting must ship in the first TestFlight build or
beta failures are invisible); **#51** still needs an explicit R1/R2 ruling — API done,
`apps/mobile` has zero coach code.

**Admin is not in R1 today.** Mahesh said it is crucial for R1; the milestone contains
none of it. That is a real scope change and should be filed as issues, because it
competes with the above for the same time.

## THE ADMIN SURFACE IS ALREADY SPECCED — READ BEFORE DESIGNING ANYTHING

This is the single most useful fact in this document. Six admin specs were written
**with Mahesh on 2026-08-05**. Only Phase 1 (Overview) was ever built
(`tesserix-home#65`). Do not re-brainstorm these:

- `2026-08-05-kora-admin-surface-design.md` — the parent. Four phases: 1 Overview
  (built), 2 Logs, 3 **User management**, 4 Economics.
- `2026-08-05-kora-ai-key-management-design.md` — the API-key UI. Note the recorded
  ruling: **rotation was deliberately deferred**, because the keys are pod env vars
  behind a 1h ExternalSecret refresh, so rotation is a 3-step operation a single
  button would lie about. Read-only key *health* was Phase 1 scope and never shipped.
- `2026-08-05-kora-user-visibility-design.md` — the "active users" ask.
- `2026-08-05-kora-economics-design.md`, `-failed-capture-explorer-`,
  `-resolution-quality-`.

Feedback triage was the only genuinely unspecced piece, which is why it is the one
that got built today (`2026-08-07-kora-feedback-triage-design.md`).

**Subscription management is blocked, not small.** Kora has **no billing concept at
all** — no provider, no plans, no entitlement column on `users` (verified against the
live schema). mark8ly has `/admin/apps/mark8ly/subscriptions`, which is probably where
the expectation comes from, but mark8ly has billing. For Kora the admin page is the
last 10% of a product workstream, not the first.

## OPEN FOLLOW-UPS (none block merge)

From the auth redesign reviews: `BrandMark`'s nine dots are individually
screen-reader-navigable, and on the splash/error screens it renders bare so they are
the *only* thing a reader finds; `automaticallyAdjustKeyboardInsets` is iOS-only;
the 401 + failed-`signOut` path is a terminal splash (pre-existing, better than the
old empty shell).

From feedback triage: `actions.ts` uses `revalidatePath` rather than re-rendering
from the PATCH response as the spec describes — and that is *why* a PATCH
shape mismatch went unnoticed until the final review; the status enum is spelled
three times in tesserix-home plus once in Go; `users.email` lacks the `COALESCE`
that `display_name` has (harmless, GORM scans NULL to `""`, but asymmetric).

Not built, worth filing: **avatar photo support** (`Avatar` takes only
`initials: string` — there is no image path at all, and the `picture` claim is still
discarded), and a **"Your plan" reveal after onboarding**. On the latter: the target
is fully derivable — Mifflin-St Jeor × activity factor, then −500 (fat loss) / 0 /
+300, protein at 2.0 g/kg, fat at 25% (`api/internal/onboarding/calc.go`). The two
motivating facts — **−500/day ≈ 0.5 kg/week** and *why* protein is that high — are
computable today and never said. A user finishes onboarding and is dropped on a
dashboard showing an unexplained 2,631 kcal.

## THE LESSON, AGAIN, AND SHARPER

The morning handoff said every defect was in a plan and almost all in a test fixture.
Today that held, plus a second failure mode: **a green check that was checking the
wrong thing.**

- A mutation "passed" because the test **skipped** for a missing env var.
- #119 merged green against a **stale head**.
- ArgoCD reported **Synced/Healthy at a pre-merge revision**.
- A clamp test asserted `len(items) <= MaxLimit` against an **empty table** — `0 <= 100`,
  true regardless of the code.
- A PATCH client type promised `email`/`display_name` the endpoint **never sends**, and
  the fixture asserted `toEqual` against that fiction.

Every one was green. So the discipline is not only "reason backward from what would
make this pass while broken" — it is **check that the green light is wired to the
thing you think it is**. Ask what the assertion would do if the code did nothing at
all; if the answer is "still pass", it is not evidence.

The counter-practice that worked all day: **make reviewers reproduce the mutation
themselves**, and make them verify mechanically rather than by eye — md5-comparing
two `onPress` bodies to prove Apple's `authorizationCode` capture survived byte-identical,
and diffing extracted `test(`/`expect(` line-lists to prove no assertion in a
long-passing suite had been weakened.

## PROCESS

Superpowers, not GSD: brainstorm → spec → `writing-plans` →
`subagent-driven-development`. Mahesh's global CLAUDE.md mandates subagent-driven
execution for plans and says not to ask — dispatch, review between tasks.

Commits: conventional prefix, **single line**, no body, no trailers, no signature.
PRs are merge-committed here, not squashed.
