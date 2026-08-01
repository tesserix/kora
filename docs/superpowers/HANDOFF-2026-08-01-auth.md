# HANDOFF — 2026-08-01 (correction loop shipped, auth chain half-fixed)

## TL;DR

The post-log correction feature (#20) is **done**: backend merged (#63), mobile UI open and CI-green (#64). Along the way, trying to test it on a device uncovered that **no Kora user has ever been able to authenticate against prod** — 0 users, 0 food logs. That has two causes; one is fixed, one needs a decision. Everything else is downstream of it.

## THE ONE BLOCKER

Istio rejects Kora's tokens **at the gateway**, before `kora-api` sees them.

`RequestAuthentication/jwt-auth-gip` (and `jwt-auth-gip-custom`) in ns `istio-ingress`, selector `istio=ingressgateway` — the whole shared gateway — accepts only:

```
issuer:   https://securetoken.google.com/tesseracthub-480811
audience: tesseracthub-480811
```

Kora's VirtualService (`kora-api.tesserix.app`) attaches to `istio-ingress/tesseract-gateway`, so a `kora-app-e6d38` token 401s at the gateway.

**Proven, not guessed:** a token minted directly from Firebase (`aud`/`iss` both `kora-app-e6d38` — exactly what `kora-api` expects) still returns 401 on `GET /v1/dashboard`, while the running pod demonstrably has `FIREBASE_PROJECT_ID=kora-app-e6d38`.

**Decision needed** — that resource is shared with fanzone, tesserix-customer and homechef:

- **(a)** Add a second `jwtRule` (issuer + audience `kora-app-e6d38`) to `jwt-auth-gip`. Additive, unblocks today. But Kora tokens then satisfy gateway auth for every host on that gateway; per-host isolation rests on the existing AuthorizationPolicies.
- **(b)** A Kora-specific RequestAuthentication. Cleaner, but RequestAuthentication selects *workloads*, not hosts — real per-host scoping needs a separate gateway deployment or `when: request.auth.iss` conditions per host.

Recommended: **(a)** now, plus an issuer condition on Kora's AuthorizationPolicy if isolation matters. Repo: `tesserix-k8s` (ArgoCD-managed).

## What was fixed already

**`kora-api` validated the wrong Firebase project.** `tesseracthub-480811` (shared platform project, zero apps registered) instead of `kora-app-e6d38` (Kora's own). Fixed in `tesserix-k8s` PR #141, merged, ArgoCD synced, running pod confirmed. Necessary but not sufficient — see the blocker above.

Note the direction: **the app was right, the infra was wrong.** `.env.example` said `kora-app` (stale — the real ID carries the `-e6d38` suffix) which sent the first investigation the wrong way. Now corrected with a comment tying it to `kora-api`'s value.

## Firebase state (project `kora-app-e6d38`, number `564299717841`)

| | |
|---|---|
| Web app `kora-mobile` | ✅ pre-existing |
| iOS app `com.tesserix.kora` | ✅ registered this session |
| Android app `com.tesserix.kora` | ✅ registered this session |
| Email/password | ✅ |
| Google Sign-In | ✅ enabled, OAuth client provisioned |
| Apple | ❌ needs the Apple Developer portal |

`apps/mobile/firebase.json` declares the auth providers; `firebase deploy --only auth` applies them and auto-provisions OAuth clients. The Firebase CLI (`npx -y firebase-tools@latest`) is already authenticated.

**Apple needs four values from the user** (they have a Developer account): App ID with Sign in with Apple enabled, a Services ID with return URL `https://kora-app-e6d38.firebaseapp.com/__/auth/handler`, a `.p8` key (**single download**) + Key ID, and the Team ID.

## Open work

**PR #64** — mobile correction UI + 401 recovery. CI green, not merged. Device pass blocked on the gateway. Includes the in-sheet Undo (a whole-branch review found the original toast rendered *underneath* the meal Sheet, since `Sheet` is a native Modal and `ToastProvider` lives in the React root — the headline affordance was unreachable and no test could see it).

**PR3 alias short-circuit — WRITTEN BUT UNVERIFIED.** Worktree at `<scratchpad>/kora-pr3`, branch `kora-alias-short-circuit`, commits `9eb5fc2..e71903c`. Fixes a real flaw in the merged #63: `AddAlias` keys the alias on the user's **raw phrase**, but `ResolveText` looks it up under the **LLM's guess** — so corrections take effect in the picker and manual search but *not* in the main capture path. The agent reports 14 tests and two genuine mutation proofs; **I could not confirm that** (the classifier blocked running the suite from the scratchpad path). Verify before opening.

**`eas.json` has no `EXPO_PUBLIC_FIREBASE_*` in any profile.** EAS Build doesn't upload gitignored `.env`, and `eas init` has never run so there are no EAS env vars. The first preview build ships with `readFirebaseConfig()` null and every tester hits `/config-missing`. Set them as EAS environment variables during `eas init` — not in `eas.json`, since GitGuardian runs on CI.

**Unanswered question:** the user's Firebase-plugin prompt said "use Firebase as my backend, using Firebase Authentication and **Firestore** database". Firestore conflicts with Kora's Go + PostgreSQL v20 backend (correction loop, coach, guardrails — 30 Go packages). Read as plugin boilerplate; **nothing was touched**. Confirm before anyone acts on it.

## R1 remaining

#21 confidence tiers · #22 offline queue · #43 metrics · `eas init` (user's) · the alias short-circuit · Apple sign-in · social sign-in UI + **account-linking design** (what happens when Google sign-in hits an email that already has a password account — security-relevant, painful to change post-beta; user chose brainstorm-first).

## Environment

- **Simulator:** iPhone 17 Pro `AD109A46-2F99-43C3-8AAA-FEE68DC8499E`, app installed and working.
- **idb is installed but not on PATH:**
  `export PATH="$HOME/Library/Python/3.9/bin:/opt/homebrew/Cellar/idb-companion/$(ls /opt/homebrew/Cellar/idb-companion|head -1)/bin:$PATH"`
- **idb coordinates are POINTS**, screen 402×874 pt / 1206×2622 px (density 3). From a 920×2000 displayed screenshot: displayed ×1.31 → px, ÷3 → points.
- **`idb ui text` silently truncates at `.` and sometimes `@`** — type addresses in small segments and verify with a screenshot.
- **Metro must run on 8082** — 8081 belongs to the user's Home-Chef project. `EXPO_PUBLIC_*` is inlined by Metro at bundle time, so the API URL must be set on the *bundler*:
  `cd apps/mobile && EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app npx expo start --port 8082 --dev-client`
  then `xcrun simctl openurl <udid> "mobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082"`
- **Test account:** `korabeta@tesserix.dev` / `KoraBeta2026x` (in `kora-app-e6d38`, created through the app's own signup).
- **ArgoCD doesn't poll instantly:** `kubectl annotate application kora-api -n argocd argocd.argoproj.io/refresh=hard --overwrite`
- **Test DB:** docker `kora-pg-test` on 55432, schema v20.
- **Ledger:** `.superpowers/sdd/progress.md` (gitignored) — full per-task history, every review finding, every mutation proof.

## Classifier denials hit this session

Editing `tesserix-k8s` (later authorised), merging its PR, running tests from the scratchpad worktree path, and `gcloud services api-keys get-key-string`. If one blocks you, explain and ask — don't route around it.

## Process notes worth keeping

- **Verify, don't trust agent reports.** Several "done" reports needed correction this session; two whole-branch reviews each found a Critical that every per-task review had missed.
- **The most valuable findings came from running the app, not from tests.** The 401 dead-end, the unreachable Undo, and the gateway rule were all invisible to a green suite.
- **Break-it-to-prove-it must revert the *whole* behaviour.** A partial revert leaves an early return that hides the bug.
- Never `gh pr merge --delete-branch` a PR with dependents. Use worktree isolation for concurrent agents.
