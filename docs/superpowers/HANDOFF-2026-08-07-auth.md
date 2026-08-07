# Handoff — 2026-08-07

Take over Kora at `/Users/Mahesh.Sangawar/personal/tesserix-new/kora`.
Siblings: `../tesserix-k8s`, `../mark8ly` (reference implementation for auth).

## START HERE

    .superpowers/sdd/progress.md    ← ledgers. Trust these and `git log`
                                      over anything else, including this file.

`main` is at **`e40f7b3`** and **deployed** (schema v24). Four PRs merged today:

- **#113** — #108 social login (Apple + Google). Merged, deployed. **Not device-verified.**
- **#115** — #107 HealthKit entitlement. Merged, **#107 closed**.
- **#116** — #106 slice 1, Apple authorization capture. Merged, deployed.
- **#117** — Google Sign-In OAuth wiring (`app.json`, `eas.json`). Merged.

R1 is **11 open**.

## THE TASK THAT IS STILL NOT DONE

**Device verification. Nothing has been verified on a physical device.** The
iPhone (`00008150-0005749C2684401C`) has been listed *offline* for this entire
session, and the previous handoff's task — device-verify #22 slice 2 and close
#22 — was never started for that reason. It is still outstanding, and two more
features have piled up behind it.

Three verification sets, all blocked on the same phone:

1. **#22 slice 2** — five checks, in the 2026-08-06 handoff. Airplane mode,
   physical device. `netinfo` reads the HOST's interface, so the simulator
   cannot substitute. Do NOT disable workstation Wi-Fi; Mahesh declined that.
2. **#108** — six checks, in `specs/2026-08-07-social-login-design.md`.
3. **#106 slice 1** — confirm by query that `users.apple_refresh_token` is
   non-empty after a real Apple sign-in.

A Release build is required for #22 (a Debug build fetches its bundle from
Metro, which airplane mode kills — the force-quit-and-relaunch check would fail
for reasons unrelated to the queue):

    EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app npx expo run:ios --device --configuration Release

**The simulator works and the app runs on it.** `npx expo run:ios` succeeded
this session. Use it for everything that isn't airplane-mode or real-signing.

## BLOCKING EVERYTHING APPLE: three secrets do not exist

Sign in with Apple is **enabled in Firebase** but **cannot function**, because
kora-api has no credentials to exchange or revoke tokens with.

Missing from Secret Manager in `tesseracthub-480811`:

    prod-kora-apple-team-id
    prod-kora-apple-key-id
    prod-kora-apple-private-key      (the .p8 contents)

**`tesserix-k8s#177` is a DRAFT that wires them, and must NOT be merged until
they exist.** ESO fails the *entire* ExternalSecret if any `remoteRef` key is
missing, which would stop `database_url` re-syncing and put the ArgoCD app
Degraded. Create the secrets, then mark it ready.

**kora-api refuses to start** if `APPLE_PRIVATE_KEY` is set while
`APPLE_TEAM_ID` or `APPLE_KEY_ID` is empty. Deliberate — a partial config would
otherwise mount `/v1/me/apple-authorization` and have every exchange fail,
silently making every Apple user permanently unrevokable while looking like
success. **All three land in one deploy.**

Verified in prod today: `POST /v1/me/apple-authorization` → **404**, which is
the designed unconfigured behaviour, not a bug.

## THE ORDERING CONSTRAINT THAT INVERTED

#106 slice 1 existed to land *before* the Apple provider went live, because
Apple returns `authorizationCode` **only at sign-in** and a user created before
capture exists can never be revoked.

The provider was enabled before slice 1 merged, so that window opened. Exposure
is nil only because no Apple-capable build has reached anyone yet.

> **Deploy the API before distributing the first Apple-capable build.** Every
> Apple user created in between is permanently unrevokable.

`app.json` gained the google-signin plugin in #117, so a **native rebuild** is
needed before either provider works on device. Batch it with the device checks.

## IN FLIGHT

**Branch `feat/auth-flow-redesign`** — spec committed (`4ed9066`), awaiting
Mahesh's review, then `superpowers:writing-plans`. Covers four surfaces:
sign-in, the link prompt, the entry gate, onboarding. Decisions already locked
in with him: sharpen the existing dark/green idiom (not a new aesthetic);
social-only first paint with "Use email instead" revealing the form; Apple's
iOS-only gate becomes structural inside the component.

Two findings in that spec are defects, not polish:

- **The entry gate strands new users.** `app/(tabs)/_layout.tsx:34-36` redirects
  to onboarding only once `profile.data` exists. So a new user sees a flash of
  empty app — and if the profile request *fails*, `profile.data` stays
  undefined, the effect never fires, and they sit in an empty tabs shell with no
  onboarding and no way out. #108 widened this: one tap now creates an account.
- **The brand mark is wrong.** `BrandLockup` renders a Lucide `sparkles` glyph.
  Kora's real mark (`assets/images/icon.png`) is a 3×3 dot grid — six large dots
  in `primary`, three small muted ones at top-centre, middle-right, bottom-centre.

## ENVIRONMENT — things that cost time

**You can read the live auth config.** This is how the provider state above was
verified rather than guessed:

    TOKEN=$(gcloud auth print-access-token)
    curl -s -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: kora-app-e6d38" \
      https://identitytoolkit.googleapis.com/admin/v2/projects/kora-app-e6d38/defaultSupportedIdpConfigs

The `x-goog-user-project` header is required; without it you get a confusing
`SERVICE_DISABLED` about a quota project. The `/config` endpoint returns the
project's password-hash **signing key** — do not paste its output anywhere.

Confirmed live on `kora-app-e6d38`:

- `apple.com` enabled, Services ID `com.tesserix.kora.signin`
- `google.com` enabled
- `allowDuplicateEmails: false` — one account per email
- **`enableImprovedEmailPrivacy: true`** — enumeration protection is ON, so
  `fetchSignInMethodsForEmail` returns `[]` and `LinkAccountPrompt`'s
  **fail-open branch is the live path**, not a rare fallback.

**Google OAuth clients** (now in `eas.json`; public, embedded in the app):

    web  564299717841-45p3feut4bgauj6e2k4hijtcm5b5u72l.apps.googleusercontent.com
    ios  564299717841-k80q23k7nouu7525plsjb812gn5bajm7.apps.googleusercontent.com

`GoogleSignin.configure()` wants the **web** client as `webClientId` on an iOS
app. The iOS one's reversed form is the `iosUrlScheme`. Backwards gives an
opaque `DEVELOPER_ERROR`.

**Apple `client_id` is the BUNDLE ID `com.tesserix.kora`, not the Services ID.**
The code comes from the native flow. A Services ID gives a bare `invalid_client`
with no other diagnostic. Both identifiers now exist; do not cross them.

**Database.** Kora is on self-hosted CloudNativePG: cluster `global-postgres` in
ns `global`, database **`kora_db` owned by the `kora` role** — a separate
database, not shared tables, despite the shared instance. Note ns `kora` also
has `kora-postgres-1`, which is EMPTY and not cut over. The workspace CLAUDE.md
describes the marketplace services and is wrong for Kora.

Local test DB: `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'`
(docker `kora-pg-test`). Run `go run ./cmd/migrate` after pulling a migration.

**Deploying kora-api.** `image.tag` is pinned on the ArgoCD Application and the
parent has `ignoreDifferences` on helm parameters, so a merge neither resets nor
advances it:

    kubectl -n argocd patch application kora-api --type=json \
      -p='[{"op":"replace","path":"/spec/source/helm/parameters/0/value","value":"<full-sha>"}]'

Wait for `build-image` on the main CI run first — the image will not exist
otherwise. Verify the RUNNING digest, filtering pods by
`ownerReferences[].kind == ReplicaSet` (the name label also matches Job pods).

**Suites.** `cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit` →
129 suites / 887 tests. `cd api && go test -race -p 1 ./...` → 34 packages.
`console.error` from `hooks.test.tsx`, `useQueuedLogs.test.tsx` and
`useActivityHistory.test.tsx` is **pre-existing** — proven by running those
suites in a worktree at `main`. Do not chase it.

`npx expo lint` regenerates `apps/mobile/eslint.config.js`, untracked ON
PURPOSE. Never stage it. `apps/mobile/.env` is gitignored and now carries the
Google client IDs.

## THE LESSON, WHICH IS THE SAME ONE AS YESTERDAY

Across four plans this session, **nine-plus defects were found. Every one was in
the PLAN, and all but one were in a test fixture.** The implementers' production
code was consistently correct.

Concretely: a byte-vs-rune length bound; `jest.fn(async () => …)` inferring a
zero-arg signature that strict `tsc` rejects; `jest.clearAllMocks()` not
removing implementations, so a `mockRejectedValue` leaked into every later test;
a missing `await` on RNTL 14's async `render`; `act()` warnings in two files; a
mutation guard on `IS NULL` that could never match because GORM writes `''`; an
assertion whose expected value *was* the initial state; and a `jwt.Parse` that
validated `exp` against wall-clock while the test pinned a fixed 2023 clock.

Two things worth copying:

- **An implementer refused to commit a red suite** and reported BLOCKED with a
  correct diagnosis. That was right. Another **rejected a patch I supplied**
  because the fake echoed its success value on the error path, making my test
  vacuous against the exact bug it was written to catch. That was the single
  most valuable catch of the day.
- **Every task carried a mutation step** — break the implementation, name the
  test that must fail. That is what surfaced all of the above. When a mutation
  fails *everything*, it has proven nothing: it cannot distinguish "the feature
  works" from "no code runs at all". Demand that exactly the named test fails.

So: reason BACKWARD from "what implementation would make this pass while
broken?" When you assert an absence, first reach a state where a wrong
implementation would produce a PRESENCE.

## AFTER THE DEVICE PASS

Mahesh's order, with the outstanding rulings:

- **#114** — social-login follow-ups: console config (done), device verification
  (not done), and **branded provider buttons**, which the auth redesign now
  covers.
- **#105 (Redis) before #43.** Redis is unreachable in prod — the pod dials
  `127.0.0.1:6379` for a sidecar that is not in the Deployment. Every resolve is
  a forced Gemini call, and it makes the slice-2 generation-counter machinery
  inert. Measuring cost against a config you do not intend to ship measures the
  wrong thing.
- **#106 slice 2** — the deletion itself. Spec exists
  (`specs/2026-08-07-account-deletion-design.md`), no plan yet. Decisions locked:
  transfer group ownership rather than cascade; `ai_usage_events.user_id` → NULL
  rather than delete; immediate, no grace period; DB delete **before** Firebase
  delete (that ordering is the load-bearing decision — it is the only one that
  is retryable).
- **#118** — the deploy-ordering race, filed today with two data points that
  landed opposite ways.
- **#104** crash reporting — ship in the same build as #109 or the first beta
  failures are invisible.
- **#51** coach mobile UI — still needs an explicit R1/R2 ruling. API is done;
  `apps/mobile` has zero coach code. Largest unstarted item in the milestone.
- **#83**, **#109**, **#106**, **#97**, **#84**, **#85** — as before.

## PROCESS

Superpowers, not GSD: brainstorm → spec → `writing-plans` →
`subagent-driven-development`. Mahesh asked for subagents explicitly this
session; the operator config says not to use the Agent tool unless he does, so
confirm rather than assume.

Commits: conventional prefix, **single line**, no body, no trailers, no
signature. PRs are merge-committed here, not squashed.
