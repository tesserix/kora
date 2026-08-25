# Handoff — Kora, R5 is shipped except identity; #449 is scoped and waiting

You are picking up **Kora** (`/Users/Mahesh.Sangawar/personal/tesserix-new/kora`),
a nutrition-tracking iOS app: Go API + Expo/React Native, pre-launch.

`main` is at `14973e03`. Two TestFlight builds shipped today (`ae7aaad3`,
`ea0c05d0`), both verified through to "uploaded to App Store Connect" with
Sentry source-map bundles confirmed — not inferred from a green tick.

**The repo is PUBLIC.** Never put a real weight, measurement or intake value in a
commit, comment, test fixture, issue or PR. Describe results as counts.

## The single most important thing

**R5 is done except #449.** #326's permission model now has a complete interface,
both directions, and both halves are verified on a device against a real API.

Closed today: **#437** (Circles UI), **#438** (body read path), **#440**
(member-side read path — `leave` is finally reachable), **#441** (friend body
view), **#443** (four on-device defects), **#444** (Social consolidation),
**#446** (44pt targets). **#153** closed as *not planned*.

**#449 — handles and profile pictures — is the only R5 issue open**, and it is
already designed. Spec:
`docs/superpowers/specs/2026-08-25-identity-handle-and-avatar-design.md`,
approved, on PR **#450** (docs only). The next step is an implementation plan,
not more design.

## Decisions already made — do not relitigate

- **Kora will not collect phone numbers.** This is what closed #153: the issue
  was written about phone digest matching, and without a phone column that
  feature cannot exist. It also removes an SMS provider, an OTP flow, a
  brute-forceable digest table and a disclosure obligation. Email-only matching
  was rejected too — permanently blind to `@privaterelay.appleid.com`, and it
  makes people findable *without a deliberate act*.
- **Handles are exact-match only.** No prefix search, no listing, no directory.
  Being findable in a weight app is health-adjacent information; a searchable
  directory tells anyone who cares who uses Kora.
- **Confusables fold for uniqueness AND for lookup.** `ada_l` and `ada_1` can
  never coexist, so folding on lookup is unambiguous. The failure this prevents
  is not a missed lookup — it is friending a stranger and then sharing body
  metrics with them.
- **Retired handles never return to the pool.** Otherwise anyone who wrote down
  `@ada` sends requests to whoever claims it next.
- **The handle is the consent boundary**, which is why the avatar appears at
  lookup rather than after friendship. Deferring it would not solve the problem
  avatars exist for.
- **`MembershipView` carries no circle name.** Circle names are the owner's
  private labels; showing a member which bucket they were filed under exposes a
  judgement the owner never chose to share. `ListForMember` is a separate query
  from `ListForOwner` on purpose — one query serving both is how that leaks.
- **Revoking a category is never gated by a confirmation.** Granting `body` asks
  and names the people by name; revoking is immediate. A surface that makes
  stopping harder than starting works against the person it exists for.
- **A hero mono numeral that can legitimately be zero never renders "0"** — it
  says it in words. This fixed two defects at once and is a house rule now.
- **`/share/memberships` is deliberately NOT in `crossUserPaths`.** It serves no
  grant-gated data, so it would pass that test vacuously. The reasoning is
  recorded in `enforcement_test.go`.

## Repo traps

Everything in the previous handoff still applies (Go module root is `api/`; CI's
npm is 10.9.9; `build-image` needs the aggregate `CI gate`; gopls lies; test
Postgres on 5433 with `-p 1`). New and expensive:

- **`localhost:5432` is the NATIVE Homebrew postgres, not Docker's.** A brew
  `postgres` binds `127.0.0.1:5432`, Docker's `dev-postgres-1` binds `*:5432`,
  and the native one wins for `localhost` — which is what `api/.env` points at.
  `docker exec dev-postgres-1 psql -U kora -d kora` fails with
  `role "kora" does not exist` and reads as a broken database; it is the wrong
  server. Use `/opt/homebrew/opt/postgresql@18/bin/psql -h 127.0.0.1 -U kora -d kora`.
  Confirm the API agrees via `/ready` (which touches the DB; `/health` does not).
- **A dev client that launches, bundles, then exits = stale `Podfile.lock`.**
  Metro reports a clean bundle, there is no crash report, and the app is just
  back on the home screen. Both `simctl launch` and the `expo-development-client`
  deep link fail identically — that is the tell that it is the binary.
  `rm -rf ios/Pods ios/Podfile.lock && npx pod-install`, then
  `npx expo run:ios --device "iPhone 17 Pro Max"`. `ios/` is gitignored.
- **An RN `Switch` does not respond to `idb ui tap`.** Nothing happens: no value
  change, no error, identical screenshot, no row written. Use
  `idb ui swipe --duration 0.5 --delta 4 <x-12> <y> <x+18> <y>`. Buttons tap fine.
- **`pkill -f "go run"` kills the wrapper, not the `api` binary it spawned.** The
  old listener survives on :8080 and serves stale routes, so a new endpoint reads
  as "route not found". Find it with `lsof -nP -iTCP:8080 -sTCP:LISTEN` and kill
  that pid.
- **An iOS Alert is invisible to `idb ui describe-all`** (separate process). A
  blank accessibility tree on a screen that was working means a modal is up —
  screenshot before concluding the companion went stale.
- **Never `git checkout <file>` to undo a mutation-test edit** on a file with
  uncommitted new code — it reverts to HEAD and deletes the new type. Copy the
  file to `/tmp` first and restore from there.
- **`jest.mock` factories cannot reference out-of-scope variables** unless the
  name is prefixed `mock`. Rename to `mockCircles` etc. or the suite fails to
  parse with a confusing babel error.

## Working practices the user expects

- **Mutation-check every test that guards something.** Make the change that
  should break it, watch it fail, restore. This found **five tests passing
  against broken implementations** today: a window test exercising only one
  bound, a leak assertion with nothing seeded, a case-sensitivity fixture that
  sorted identically under both rules, a confirmation test that never asserted
  the sheet was *absent* first, and a touch-target test.
- **Verify on the simulator, not only in tests.** The device found four defects
  no test could: a pending fetch rendering as a factual claim about someone's
  data, a 200-with-empty reading identically to a 404, a blank `display_name`
  above a sentence saying that person can see your body metrics, and a
  confirmation panel whose reflow pushed a destructive button under the user's
  thumb. Neither technique catches the other's findings.
- **Verify an issue's premises before planning off it.** #437's fourth screen
  turned out to be unbuildable (nothing listed circles you were a member of),
  which became #440.
- **Say what is not verified**, on every PR, in its own section.
- **Read every CI step, not the job's colour.**

## What is open and unverified

- **#449** is the only open R5 issue. Its two stated gaps are real work, not
  polish: there is **no rate limiting anywhere in the API**
  (`internal/guardrails` is the protective-user policy module, not a limiter),
  and **there is no moderation** — a user-supplied image shown to anyone holding
  a handle is defensible at 18 users and not at public launch.
- **Kora stores no user images today.** Meal photos go to the vision provider as
  base64 and are never persisted. #449 gives that posture up deliberately, and
  needs a bucket (`kora-prod-assets-in`, asia-south1, matching sibling
  convention — none exists yet).
- **`golang.org/x/image/draw` is a genuine new dependency** for #449.
  `internal/bodyread/downscale.go` uses nearest-neighbour deliberately for UI
  screenshots and says a real photo would need x/image "as a new dependency
  then". Avatars are that caller.
- **Never verified on any new surface**: dark mode, Dynamic Type at accessibility
  sizes, iPhone SE width, the confirmation sheet's real pan-dismiss, VoiceOver
  focus placement when it opens.
- **#420's premise is still unconfirmed.** Nobody has observed whether a locked
  device is what blanks the widget. Catch it blank and note how long it stays
  that way **without opening the app**.
- **The widget extension's `CFBundleVersion` is `1` while the app is `48`.**
  Xcode warns these must match; App Store Connect accepted it anyway. Worth
  looking at before it becomes a rejection. Probably the widget target not
  picking up `autoIncrement`.
- **Migration 000055's comment is still factually wrong** ("pre-launch with one
  real account"; production has 18 user rows). Correct before R6 onboards
  testers.
- **PR #309** (offline barcode queue) is open and untouched by any of this.

## Session state left running

Deliberately not cleaned up, so the next session can keep poking:

- Metro on `:8081`, local Go API on `:8080`.
- Dev DB seeded: three throwaway friends (`tw-*@kora.test`), accepted
  friendships, weigh-ins for two accounts, a circle each way so both the
  audit and "Shared with you" have data.
- **A real throwaway Firebase identity** `tw-ada@kora.test` exists in
  `kora-app-e6d38` (created to mint a token for verifying the cross-user read).
  It needs deleting separately from the DB rows.

```
pkill -f "expo start"; lsof -nP -iTCP:8080 -sTCP:LISTEN   # then kill that pid
psql -h 127.0.0.1 -U kora -d kora -c "DELETE FROM users WHERE email LIKE 'tw-%@kora.test'"
```

## R6 is scoped and waiting

Six issues (#430–#435) implement the Product Admin Integration Contract so the
console can manage Kora: registration, `/admin/audit-logs` (which today shows
**mark8ly's** rows under Kora's name), `/admin/inbox`, `/admin/entities/{type}`,
`/admin/health`, `/admin/kpis`. AI usage needs no work.
