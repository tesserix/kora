# HANDOFF — 2026-08-01 (R1 unblocked: auth, food index, correction loop all live)

## TL;DR

Kora went from **"no user has ever authenticated against prod"** to a working
end-to-end path in one session. Seven PRs merged. The two blockers were both
infrastructure, not application code, and both are fixed and verified in prod.

**The one thing left undone: a capture through the app UI on a simulator against
the real API.** Everything below it is proven at the API level. Start there.

## THE REMAINING TASK — sim capture against prod

Every high-value finding across the last three sessions came from **running the
app**, not from tests. A green suite hid the 401 dead-end, an Undo button that
rendered underneath its own sheet, and an empty food index. Do this early.

```bash
# 1. Metro MUST be restarted — EXPO_PUBLIC_API_URL is inlined at bundle time,
#    and it is currently pointing at localhost:8080 (see Environment below).
cd apps/mobile
EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app npx expo start --port 8082 --dev-client

# 2. Point the dev client at it
xcrun simctl openurl AD109A46-2F99-43C3-8AAA-FEE68DC8499E \
  "mobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082"
```

Sign in as `korabeta@tesserix.dev` / `KoraBeta2026x` (already onboarded in prod),
then **log a meal through the capture UI** and confirm it resolves instead of
"Something went wrong while I looked at that."

Then re-run the #64 correction checks against prod (they were verified against a
local API, never prod): change the food, confirm the in-sheet Undo row appears
and is tappable, tap it, confirm the alias row is gone.

Worth also checking the **new two-step onboarding** on a *fresh* account, since
it has only ever been seen with a pre-existing profile.

### idb notes (hard-won)

```bash
export PATH="$HOME/Library/Python/3.9/bin:/opt/homebrew/Cellar/idb-companion/$(ls /opt/homebrew/Cellar/idb-companion|head -1)/bin:$PATH"
```
- Coordinates are **points**: screen 402×874 pt / 1206×2622 px. From a 920×2000
  displayed screenshot: displayed ×1.31 → px, ÷3 → points.
- `idb ui text` **truncates at `.` and drops `@`** — type emails in single-token
  segments (`korabeta`, `@`, `tesserix`, `.`, `dev`) and verify with a screenshot.
- **iOS autocorrect rewrites typed words** ("brekkie" → "Beeline"). Use
  unambiguous phrases or check the field before submitting.
- `idb ui swipe` needs `--duration 0.4` to register as a scroll; a bare swipe
  silently does nothing.
- The floating gear is the Expo dev menu, not app UI. It won't exist in a release
  build — do not "fix" it.

## What was fixed (all verified in prod)

| Layer | Was | Now |
|---|---|---|
| Istio gateway | 401 `Jwt issuer is not configured` | Kora's issuer accepted, DENY-scoped to its host |
| Sign-in / onboarding / dashboard | unreachable | working; targets computed from real data |
| `food_items` | **empty** — nothing loggable | 85 items via a sync-wave-0 Job |
| `POST /v1/resolve/text` | 200 with `candidates: null` | 200 with a real candidate |

**Gateway** (tesserix-k8s #142): `RequestAuthentication` listed only
`tesseracthub-480811`, so Kora's `kora-app-e6d38` tokens 401'd *before* reaching
`kora-api`. Added an additive `extraGip` entry plus a paired DENY so a Kora token
cannot clear gateway authz on other products' hosts. See
`memory/kora-gateway-jwt-issuer.md` — including the trap where istiod takes
minutes to converge because it blocks retrying FanZone's dead JWKS endpoint.

**Food index** (kora #67 + tesserix-k8s #143): `cmd/seed` and `cmd/ingest` existed
all along but **the image shipped only `api` and `migrate`**, so they could never
run in-cluster. See `memory/kora-prod-food-index.md`.

## Merged this session

`#64` correction UI · `#65` alias short-circuit · `#66` pre-app polish ·
`#67` seed-capable image · `#68` honest API error copy ·
tesserix-k8s `#142` gateway JWT · `#143` seed Job.

`main` is green: 30 Go packages, 97 mobile suites / 543 tests, tsc clean.

## Verified vs NOT verified — read this before trusting anything

**Verified end to end:** the full #20 correction loop. Correct a food → alias
taught → re-typing the phrase resolves instantly from the alias with **no model
call** → Undo retracts it and the phrase falls back to the LLM. Proven with a
*deliberately invalid* `GEMINI_API_KEY`, so a 200 was only possible if the
short-circuit fired. Both directions checked against a real database.

**Verified only against a LOCAL API:** #64's in-sheet Undo row and
`retract_correction`. The C1 fix (Undo rendering *inside* the sheet rather than
beneath it) was confirmed on a device, but against localhost.

**Not verified at all:** any capture through the app UI against prod. That is the
task above.

## Open items

- **`eas init` has never run.** `eas.json` has no `EXPO_PUBLIC_FIREBASE_*` in any
  profile and EAS Build does not upload a gitignored `.env`. I reproduced this
  accidentally: a fresh worktree with no `.env` landed straight on
  `/config-missing`. Every tester on the first preview build hits that screen.
  Set them as EAS environment variables during `eas init`, **not** in `eas.json` —
  GitGuardian runs on CI.
- **Apple sign-in** needs four values from the Developer portal (App ID with Sign
  in with Apple, Services ID with return URL
  `https://kora-app-e6d38.firebaseapp.com/__/auth/handler`, a `.p8` key +
  Key ID, Team ID). Longest lead time; Google is already enabled.
- **R1 remaining:** #21 confidence tiers, #22 offline queue, #43 metrics.
- **`fat_loss` is the default-selected goal** and applies −500 kcal/day. For an
  app shipping deliberate ED guardrails, presetting every new user to an
  aggressive deficit before they've said anything is a values inconsistency.
  Raised, not changed — it's a one-line fix if wanted.
- **One unexplained failure.** Onboarding failed once in the app with valid input
  while the identical payload succeeded via curl seconds later. `apiFetch` does
  route through `fetchWithRetry`, so the 401 path is not the gap. Never
  reproduced. #68 at least means the copy no longer misdirects the diagnosis.
- Other `onError` call sites still have their own catch-all copy;
  `src/lib/apiErrorMessage.ts` now exists for them.
- `npx expo lint` **scaffolds an ESLint config and adds two devDependencies on
  first run** — the repo has a `lint` script but no ESLint installed. Reverted;
  worth its own change, as it surfaces 45 pre-existing errors.

## Environment left behind — IMPORTANT

- **Local API on `:8080`** started with
  `GEMINI_API_KEY="deliberately-invalid-key-for-shortcircuit-proof"`. It exists to
  prove the alias short-circuit never calls the model. **Do not mistake it for a
  working AI setup.** Kill it when done.
- **Metro on `:8082` points at `http://localhost:8080`.** Restart with the prod
  URL before any prod testing (command above). Port 8081 belongs to the user's
  Home-Chef project — always use 8082.
- Docker `kora-pg-test` on **55432**, schema at head, seeded with 85 foods.
  `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable`
- **Kora's schema needs pgvector.** A throwaway `postgres:15` fails migration with
  `extension "vector" is not available` — use `pgvector/pgvector:pg15`.
- Merged worktrees removed. Several stale local branches remain (`kora-alias-
  short-circuit`, `kora-log-correction-mobile`, `kora-onboarding-polish`, …) —
  all merged, safe to prune.

## Process notes worth keeping

- **Mutation-test your own tests.** Three of mine this session passed while
  asserting nothing real — including one named "the footer sits outside the
  scroll view" that passed with the footer *inside* it, and an icon test that
  covered iOS but left the Android path so uncovered the brand mark would have
  shipped as a grey circle. Green is not evidence until you have watched it fail.
- **Verify against the artifact, not the green check.** I pulled the published
  image by digest and listed `/usr/local/bin` rather than trusting CI.
- **Absent data is not evidence.** This repo has already spent a whole PR undoing
  three signals that read missing data as risk. The new activity inference
  returns `null` rather than defaulting to `sedentary` for exactly that reason.
- **Correct your own claims fast.** I said "HealthKit is already integrated" — true,
  but it read only *today's* steps and no workouts, so the feature needed real new
  queries. Saying so immediately was cheaper than building on it.
- Never `gh pr merge --delete-branch` a PR with dependents. Use worktree isolation
  for concurrent work.
