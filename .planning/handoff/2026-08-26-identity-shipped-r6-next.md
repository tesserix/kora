# Handoff — Kora, #449 is merged; R5 is closed and R6 is next

You are picking up **Kora** (`/Users/Mahesh.Sangawar/personal/tesserix-new/kora`),
a nutrition-tracking iOS app: Go API + Expo/React Native, pre-launch, ~18 users.

`main` is at **`83a7bd4f`** — "feat(identity): handles and profile pictures
(#449) (#451)", 28 commits squashed.

**The repo is PUBLIC.** Never put a real weight, measurement or intake value in
a commit, comment, test fixture, issue or PR. Describe results as counts.

## The single most important thing

**R5 is done. #449 shipped, and the handle half is live while the picture half
is inert.**

`ASSETS_BUCKET` is unset in every environment because **`kora-prod-assets-in`
has never been created** — Kora's manifests live in `tesserix-infra` and nothing
in this repo can create it. Until it exists:

- `assets.Noop` is selected,
- uploads return **200**,
- `avatar_path` **is written to the users row**,
- every `avatar_url` comes back `""`.

So the database accumulates paths pointing at objects that were never written.
That is documented in `docs/OPEN_QUESTIONS.md` and in PR #451's body. **Do not
debug it as a bug.** Creating that bucket is the single highest-value next
action if anyone wants to see a face in the app.

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

## Open follow-ups

| # | What | Why it was deferred |
|---|---|---|
| #452 | Dynamic Type at AX5 breaks the Social screen | Pre-existing (`social.tsx` shipped `ea0c05d0`); needs a row-layout redesign, not a patch |
| #453 | Lookup offers "Send request" to an existing friend | Harmless — the send is idempotent — but wrong-looking on the consent screen |
| #454 | Avatars unrendered on 4 list surfaces; `initials()` exists 5× with 2 algorithms | Small but touches several files, wants a screenshot pass |
| #455 | Deletion tests leak `retired_handles` rows | Randomised handles, so no flake risk; violates the idempotency standard |

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
  `CircleMember.avatar_url`, and one more) — nothing type-checks across the wire,
  and none of it fails loudly.
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
  wait for `gh pr checks` yourself.

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

Still true from before: migration 000055's comment is factually wrong
("pre-launch with one real account"; production has 18 user rows), and the widget
extension's `CFBundleVersion` is `1` while the app is `48`.
