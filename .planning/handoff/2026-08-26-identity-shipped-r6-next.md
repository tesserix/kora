# Handoff — Kora, #449 is merged; R5 is closed and R6 is next

You are picking up **Kora** (`/Users/Mahesh.Sangawar/personal/tesserix-new/kora`),
a nutrition-tracking iOS app: Go API + Expo/React Native, pre-launch.

**There is ONE real user — the owner.** The users table holds ~18 rows, but they
are test and throwaway accounts, not people. Confirmed by the owner 2026-08-26.
Read every "18 users" claim in older docs with that correction applied: it
changes what is urgent (nothing user-facing is), and it means a defect that
reaches "production" today reaches one person who knows what they are looking
at.

`main` is at **`fe7d6497`**. The stack, newest first: doc corrections ·
`ef71642c` the reaper-log fix (#457) · `b83d2aaf` the four #449 follow-ups
(#452–#455, PR #456) · `83a7bd4f` handles and profile pictures (#449, PR #451).

**The repo is PUBLIC.** Never put a real weight, measurement or intake value in
a commit, comment, test fixture, issue or PR. Describe results as counts.

## The single most important thing

**R5 is done, #449 shipped, and the pictures are now live too.**

`kora-prod-assets-in` was created on 2026-08-26 and `kora-api` points at it
(tesserix-k8s#624), so `assets.GCS` is selected and avatars render. Before that
the picture half was inert: uploads returned 200, `avatar_path` was written, and
every `avatar_url` came back `""`.

**Kora's manifests live in `tesserix-k8s`** (chart `charts/apps/kora-api`,
ArgoCD-managed), NOT `tesserix-infra` — an earlier version of this handoff said
otherwise and was wrong. Because ArgoCD self-heals, a `kubectl set env` on
`kora-api` is silently reverted; deployment config changes must go through that
chart. Note SSH may not be authorised for that repo — the `gh` API works.

**Rollout wrinkle:** rows written while `Noop` was active point at objects that
were never uploaded, so those users' `avatar_url` 404s. `Avatar`'s `onError`
falls back to initials, so it is cosmetic and self-corrects on re-upload. At
one real user, who had no working picture before 2026-08-26, the practical
impact is nil — but it reads as a bug if you do not know.

**Verified live, not inferred:** the pod carries both `ASSETS_*` vars, `/ready`
returns 200, the rollout completed, and there is NO `gcs unavailable` line in
the logs — which is the tell, because `main.go` logs that only when `NewGCS`
fails. Bucket round-trip was smoke-tested: write as the service account, then an
anonymous `curl` with no auth header returned HTTP 200 with the right body.

**There is no lifecycle reaper, by necessity.** GCS cannot express "delete
superseded avatars": each write issues a new object NAME (a fresh uuid in the
path), not a new object VERSION, so noncurrent-version conditions never match,
and an age-based rule would delete live avatars. The application-side delete on
replace / removal / account-deletion is the ONLY collector; when one fails the
object leaks permanently, and both paths now log `NEEDS MANUAL CLEANUP` (#457
— they previously claimed a reaper would collect it, which would have sent an
operator hunting for something that does not exist).

## What shipped

- **Handles**: exact-match lookup only — no prefix search, no listing, no
  directory anywhere in the API. Confusables (`l`/`i`/`1`, `o`/`0`) fold for
  uniqueness *and* lookup. Retirement is permanent, including on account
  deletion.
- **Pictures**: uploaded through the API (never direct-to-bucket), header-only
  pixel cap *before* decode, centre-crop, 512px, JPEG re-encode — which is how
  EXIF and its GPS coordinates go away.
- **The API's first rate limiter**: in-process, on handle lookup, friend-request
  send, and handle claim. In-process deliberately — Redis here is optional and a
  Redis-backed limiter would inherit that and fail **open**, silently.

## Decisions already made — do not relitigate

- **`golang.org/x/image` was never needed.** The spec and issue #449 both call it
  "a genuine new dependency", quoting a stale comment in
  `bodyread/downscale.go`. kora#365 had already replaced nearest-neighbour with
  box averaging, which *is* area resampling. `go.sum` is byte-identical to the
  merge base. The stale comment is deleted.
- **The limiter stays in-process.** See above. Moving it to a shared store
  requires first deciding what happens when that store is down.
- **Removing a handle or picture is ungated** — no confirmation. Mirrors the
  sharing circles' revoke: a surface that makes *stopping* harder than
  *starting* works against the person it exists for.
- **The four handle-write failures stay distinguishable** (invalid / reserved /
  taken / retired). That is what tells someone whether to fix a typo or pick a
  different name.
- **Reserved handles are derived** from plain names through the same fold, so the
  list cannot drift from the folding rules.

## Follow-ups — all four shipped

#452, #453, #454 and #455 are **closed**, merged as `b83d2aaf` (PR #456):

- **#455** — the leak was NOT where the issue said. `deletion_test.go` cleaned up
  fine; the culprit was `TestSetHandleRateLimitIsWiredIntoTheRealRouter`, which
  claims 21 random handles in a loop, each retiring the previous. The confusables
  fold moved to a new zero-dependency `internal/handlefold` so test cleanup can
  compute canonical forms without the `identity`→`user` cycle. **One fold
  implementation in the codebase.**
- **#453** — `GET /v1/users/lookup` returns `friendship_status`
  (`none`/`request_sent`/`request_received`/`friends`/`self`), via a
  consumer-declared interface because `identity` cannot import `social`. The TS
  side is a **string-literal union**, which caught a deliberate typo at compile
  time — the seam that failed silently four times in #449.
- **#454** — seven `initials()` copies (one more than the issue counted) with two
  algorithms became one shared helper; the fake `"K"` fallback is gone; every
  `<Avatar>` passes a `uri`, including the incoming-request row that previously
  had none.
- **#452** — rows reflow past a 1.5 font scale, matching `sign-in.tsx`'s existing
  `HERO_COLLAPSE_FONT_SCALE`. **Not visually confirmed** — the Firebase login wall
  blocked the real Social screen, so this is structural correctness plus 9 tests.
  If the threshold is wrong it is a one-line tune.

### Not looked at — surfaced on a push, outside today's scope

**GitHub reports 8 vulnerabilities on `main` (7 high, 1 moderate)** —
https://github.com/tesserix/kora/security/dependabot. Nobody triaged these
today. Seven high on a pre-launch app heading for public launch is worth its own
session.

### Residual, worth a follow-up

- `LeaderRow` has a `uri` prop **no caller passes** — `FriendProgress`,
  `GroupMemberView` and challenge leaderboard entries carry no `avatar_url` on
  the wire. An API-side gap.
- `friends.tsx`'s own incoming-request row still has no avatar, unlike Social's.
- `request_received` routes to `/friends` rather than reusing `onSend`, because
  `LookupView` carries no request id. A design decision types cannot enforce.

Also open and untouched by any of this: **PR #309** (offline barcode queue).

## The lesson that cost the most this session

**Every serious defect was a seam** — each piece correct, internally tested, and
approved, with the join between them broken:

- `POST /v1/friends/requests` accepted only email/`friend_code`, so "find by
  handle, then send a request" had **no API behind it**. Fifteen tasks green, the
  headline journey broken.
- `listRequests` was never updated when `FriendView` gained handle/avatar, so
  incoming requests showed nobody — on the one screen where consent is granted.
- **Four separate instances** of "the Go projection returns a field, the mobile
  TS type never declared it" (`Profile.avatar_url`, `Friend.handle`/`avatar_url`,
  `CircleMember.avatar_url`, and a fourth) — nothing type-checks across the wire,
  and none of it fails loudly. A fifth (`Friend.handle`) turned up during the
  follow-ups. **A string-literal union is the cheap defence** — it turns a wrong
  value into a compile error instead of a silent fallthrough.
- Account deletion did not retire the handle, against an invariant **this
  branch's own migration writes down in prose**.

**Do this on any change that adds a Go field with a `json:` tag:** check the TS
type declares it, check something renders it, and check the query's *sibling*
selects it too — query methods here come in pairs
(`ListAccepted`/`listRequests`, `ListForOwner`/`ListForMember`).

## Verification practices that earned their keep

- **A mutation only proves something if it breaks the exact property the test
  claims.** Two Criticals shipped past mutations that exercised surrounding
  machinery while the thing under test was wrong.
- **A mutation must still compile.** A build failure is not a test failure — it
  caught five people on this branch, me included.
- **Check the exit code, not the summary.** `npx jest` printing a green summary
  while exiting 1 is what let a CI-breaking regression past three reviews.
- **A skipped test is not a pass.** Several `testDB` helpers skip silently
  without `TEST_DATABASE_URL`.
- **Run DB suites twice** and confirm the tables return to zero — a single green
  run cannot detect leaked rows.
- **`git log` over a test file path does not tell you whether your branch broke
  it.** Two suites were called "pre-existing failures" through three reviews; the
  file was untouched, but what it *imports* was not. Check the module graph.

## Repo traps

Everything in the previous handoff still applies. Reconfirmed or new:

- **gopls lies here — eleven false diagnostics on this branch**, including a
  recurring phantom `shareHandler.Memberships undefined` and a batch of arity
  errors `go vet` accepts cleanly. **Never act on a language-server diagnostic
  without confirming via `go build`.** It was wrong every single time it
  disagreed with the toolchain.
- **`localhost:5432` is the native Homebrew postgres** (the dev DB, `api/.env`
  points at it). **5433 is the test DB.** Never point tests or migrations at 5432.
- **`config.Load()` does not auto-load `.env`** — running the API by hand needs
  `source .env` first.
- **`pkill -f "go run"` kills the wrapper, not the `api` binary.** Find the real
  listener with `lsof -nP -iTCP:8080 -sTCP:LISTEN`.
- **Never run prettier** — no config exists and it has silently swallowed an edit.
- This repo's `render` from `@testing-library/react-native` is **async**, and
  `UNSAFE_getAllByType` does **not** exist in the installed build — use
  `container.queryAll(instance => instance.type === "Image")`.
- **`gh pr merge --auto` does not gate here.** The repo has no *required* status
  checks, so `--auto` merges immediately rather than waiting. If you want a gate,
  wait for `gh pr checks` yourself. (#451 merged ahead of its checks this way.)
- **`Closes #1, #2, #3` only closes #1.** GitHub parses the keyword against the
  first number only; each needs its own `closes`. #456 auto-closed one of four.
- **SSH is not authorised for `tesserix-k8s`** from this machine, though it is
  for `tesserix/kora`. Use the `gh` API (`git/refs` + `contents`) to branch,
  commit and PR there.
- **`gcloud storage buckets create` rejects `--public-access-prevention=inherited`**
  — omit the flag; inherited is the default.
- **The org policy `storage.publicAccessPrevention` is NOT enforced**
  (`booleanPolicy: {}`), even though every sibling `*-assets` bucket sets it at
  bucket level. `kora-prod-assets-in` is deliberately public-read; do not
  "correct" it without re-deciding the consent model (see OPEN_QUESTIONS).

## Session state — cleaned up

Nothing is left running. Metro and the API are stopped, `/tmp/kora-assets` is
removed, the merged remote branch is deleted, the three stale
`tw-*@kora.test` rows are gone from the dev DB (5432), and the leaked
`retired_handles` rows are cleared from the test DB (5433).

The device pass cleaned up after itself: the two Firebase identities it minted in
`kora-app-e6d38` are deleted (verified by failed sign-in), and the simulator's
appearance and content-size were restored.

**Unverified:** whether Firebase identities exist for the three older
`tw-ada` / `tw-ben` / `tw-cleo` accounts whose DB rows were just deleted. Their
rows are gone; if the identities survive, they need deleting in the
`kora-app-e6d38` console separately.

## R6 is scoped and waiting

Six issues (#430–#435) implement the Product Admin Integration Contract so the
console can manage Kora: registration, `/admin/audit-logs` (which today shows
**mark8ly's** rows under Kora's name), `/admin/inbox`, `/admin/entities/{type}`,
`/admin/health`, `/admin/kpis`. AI usage needs no work.

**Correction to a task the previous handoff carried:** it said migration
000055's comment ("pre-launch with one real account") is *factually wrong*
because production has 18 user rows, and asked for it to be corrected before R6
onboards testers. **Do not make that change.** The owner confirmed on 2026-08-26
that there is one real account; the other rows are test and throwaway data. The
comment was right and the "fix" would have introduced the error. Row count is
not user count.

Still true from before: the widget extension's `CFBundleVersion` is `1` while
the app is `48`. Xcode warns these must match; App Store Connect has accepted it
anyway. Probably the widget target not picking up `autoIncrement`.
