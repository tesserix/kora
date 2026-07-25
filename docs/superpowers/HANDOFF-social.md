# Handoff — Kora social domain (after Groups merged to main)

**Date:** 2026-07-26. Written to continue in a fresh session.

## Authoritative state (READ FIRST, in order)
1. **Progress ledger:** `.superpowers/sdd/progress.md` (gitignored) — every phase/task/feature, commits, reviews, deferred minors, the whole social run. Trust it + `git log` over recollection.
2. This file.
3. Specs/plans for the social domain: `docs/superpowers/specs/` + `docs/superpowers/plans/` (dated `2026-07-25`): `kora-friends-foundation`, `kora-compare-progress`, `kora-groups`, plus the earlier nutrition/mobile features.
4. Prior handoffs: `docs/superpowers/HANDOFF-phase3plus.md`, `HANDOFF-phase3.md` for pre-social context.

## Branch / merge state
- **`main` = `a44c6a8`** (pushed). It now contains the full chain: phase-1a→1b→1c→phase-2 (nutrition engine) → **Friends (A)** → **Compare (B)** → **Groups (C)**. Everything below is merged to main.
- Feature branches (all pushed, all fast-forward-merged into main): `phase-4-social` (Friends), `phase-5-compare` (Compare), `phase-6-groups` (Groups). Each was FF-merged to main in turn.
- **Merge pattern used** (user-confirmed each time): `git checkout main && git reset --hard origin/main && git merge --ff-only <branch> && git push origin main`. Each social branch was a strict linear descendant of main → clean FF, zero conflicts.
- Migrations applied to `kora_test` through **000011** (groups). Dev DB `kora` is NOT necessarily migrated past what live-smoke needed — migrate it before on-device testing.

## Social domain progress
- ✅ **A. Friends foundation** — friendships graph, request/accept (code + email), share code, Friends screen under More. On main.
- ✅ **B. Compare progress** — `share_progress` opt-in (default off), `progress.Compute` (streak + ±10%/7-day adherence), consent-gated `GET /v1/friends/progress`, FriendsLeaderboard. On main.
- ✅ **C. Groups** — groups/group_members, owner-admin, join by code + owner-invites-friend, group leaderboard reusing the SINGLE consent gate `compare.ProgressForMembers`, groups list + group detail screens, Groups row under More. On main.
- ⏳ **D. Competitions** — **DESIGNED, NOT BUILT** (decisions locked in brainstorm — see below). This is the immediate next move.
- ⬜ **E. Notifications** — not started (invites, "you've been passed", challenge start/end).

Test status at handoff: backend whole suite green vs `kora_test` (`-race -p1`); mobile **172/172 + tsc clean**. CI red = pre-existing GitHub Free Actions billing, not code. **NONE of the social stack (A/B/C) has been live-smoked on device** — that gap is open.

## D. Competitions — locked design decisions (ready for spec → plan → build)
Brainstormed with the user; all four gates answered:
- **Metric:** creator picks per challenge — `on_target` (days within ±10% of target in window) OR `logged` (distinct days logged in window).
- **Participation:** opt-in join; **joining IS the consent** to show your challenge score (separate from the always-on `share_progress` board — a group member who didn't join a challenge never appears in it). Creator auto-joins on create.
- **Create permission:** any group member.
- **Placement:** a "Challenges" section in the group detail screen + a new challenge detail screen (`app/challenge/[id].tsx`).

Design shape presented (user said "continue" ⇒ treat as approved; write the spec):
- **Migration `000012`:** `challenges` (id, group_id→groups cascade, creator_id, title, metric `on_target|logged`, start_date date, end_date date, created_at) + `challenge_participants` (challenge_id→cascade, user_id→cascade, joined_at, PK (challenge_id,user_id)).
- **Status + winner computed, not stored:** status = `upcoming`(now<start) / `active`(start≤now≤end) / `ended`(now>end); winner = top standing when ended.
- **Windowed scoring:** new `progress.WindowScore(ctx, logs, userID, metric, targetKcal, from, to, loc) (int, error)` reusing `foodlog.DailyKcal(from,to)` — `on_target` = days in [start,end] within ±10% of target; `logged` = distinct days with a log. (The existing `progress.Compute` is fixed 7-day; add the windowed helper alongside it, unit-testable with the same stub `LogSource`.)
- **New `internal/challenges` package** (model/repo/service/handler, mirrors `groups`). Endpoints under authed `/v1`, all **group-membership-gated**:
  - `POST /groups/:id/challenges {title, metric, start_date, end_date}` → create (any member, creator auto-joins) 201.
  - `GET /groups/:id/challenges` → list (title, metric, status, dates, participant_count, `joined`).
  - `POST /challenges/:cid/join` / `DELETE /challenges/:cid/join` → opt-in / leave.
  - `GET /challenges/:cid` → detail: standings (participants ranked by score desc, tiebreak name), status, winner (when ended).
  - `DELETE /challenges/:cid` → creator (or group owner) deletes.
- **Mobile:** types (Challenge/ChallengeSummary/ChallengeStanding/ChallengeDetail/Metric); hooks (`useGroupChallenges`, `useChallenge`, `useCreateChallenge`, `useJoinChallenge`, `useLeaveChallenge`, `useDeleteChallenge`); a "Challenges" section + "New challenge" in group detail; `CreateChallengeSheet` (title + metric toggle + **duration preset** 1w/2w/1mo → start=today, end=today+N, to avoid a native date-picker dep); `app/challenge/[id].tsx` (standings + status + join/leave + winner banner).
- **Scope (YAGNI):** no custom date ranges (presets only), no recurring/seasonal, no prizes/badges, no challenge editing (create+delete only), no notifications (E), no friend-level (group-only) challenges.
- Roughly **8 tasks**: migration+repo → `progress.WindowScore` → challenges service → handlers+routes → mobile hooks → challenges-in-group-detail → challenge detail screen → CreateChallengeSheet. (More-tab needs no change — challenges live inside groups.)

## Working agreements (this project — unchanged, followed all session)
- Flow: `superpowers:brainstorming` → `superpowers:writing-plans` → **`superpowers:subagent-driven-development`** (fresh implementer + spec/quality reviewer per task on **sonnet**; fix Critical/Important before moving on; **final whole-branch review on opus**). Use the ledger + `scripts/task-brief`/`review-package`. **Always subagent-driven, never ask inline** (user global pref).
- Each social sub-project = its own branch off `main` (e.g. next: `phase-7-competitions`), spec+plan committed, executed subagent-driven, then FF-merged to main when the user says so.
- Base for a task's review-package = the commit **before that task** (NOT `HEAD~1`).
- Backend DB tests: `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1` (Postgres = docker `infra-postgres-1`). After adding a migration, apply to kora_test first: `cd api && TEST_DATABASE_URL=…/kora_test go run ./cmd/migrate`.
- Tell implementer subagents to run tests **FOREGROUND**. **Stale RED LSP diagnostics after a test-before-impl Go task are normal — verify with `go build ./...`/`go test`, not the LSP** (bit us repeatedly; always stale, never real).
- Mobile: `npx tsc --noEmit` + `npm test -- --ci`; jest.mock factories reference only `mock`-prefixed vars; `Button` variants `primary|secondary|ghost`; `router.push(path as Href)` for dynamic routes; conditional-mount sheets to avoid touching sibling test mocks.
- Conventional single-line commits, no signature. **Push/merge is outward-facing — the user has directed every push/merge**; confirm unless explicitly told.

## Reusable primitives (lean on these for D)
- `progress.Compute` + `progress.LogSource` interface (stub-testable, no DB); `foodlog.DailyKcal(from,to)` + `foodlog.LoggedDaysDesc`. `LogFood` sets `Kcal = KcalPer100g * (grams/100)` → deterministic test seeding.
- **The consent gate lives in ONE place: `compare.ProgressForMembers`** (`compare.Member{ID,DisplayName,ShareProgress,TargetKcal}`). For D, challenge standings are participant-only (opt-in = consent), so they do NOT go through share_progress — they compute every participant's score directly.
- `groups.Repository` (`IsMember`, `RoleOf`, `ListMembers`), `social.Repository.AreFriends`. `user.IDFromContext`/`LocFromContext`, `httpx.OK`/`Error`, the `{data}` envelope (`apiFetch` unwraps `body.data ?? body`).
- **GORM gotcha (bit us):** a bare `time.Time` field with no gorm tag inserts the Go zero time and OVERRIDES a SQL `DEFAULT now()` — tag join/created timestamps `gorm:"autoCreateTime"`. (Cost an Important review finding on groups.)
- Migration unique index on a nullable "code" column: fine as plain UNIQUE. Unique index on a column GORM fills with `''` (zero value) collides on the 2nd row → use a PARTIAL index `WHERE col <> ''` (the friend_code Critical from Friends).

## Deferred backlog (not blocking D)
- **Groups:** rename + direct friend-invite MOBILE UI (backend endpoints `PATCH /groups/:id`, `POST /groups/:id/invite` + hooks exist/tested — only the UI + `useRenameGroup`/`useInviteToGroup` hooks are deferred). Cosmetic: Friends+Groups share the `users` icon; `Create` group handler uses raw `c.JSON` not `httpx.OK`; `ListForUser` member_count correlated subquery; invite-code collision has no regen retry; `useCreateGroup`/`useJoinGroup` typed `GroupSummary` but backend returns full `Group` (only `.id` consumed).
- **Whole social stack NOT live-smoked** — Friends/Compare/Groups never driven on the simulator. Worth one pass (flaky dev rig; see HANDOFF-phase3plus for the reinstall/relaunch dance; restart `go run ./cmd/api` after route changes; migrate dev `kora` DB to 000011).
- **E. Notifications** — the last social slice.

## Likely next moves (pick with the user)
1. **Build D (Competitions)** — design is locked; go straight to writing the spec on `phase-7-competitions`, then plan → subagent-driven. The natural continuation.
2. Live-smoke the social stack (A/B/C) on device — closes the standing verification gap.
3. Build the deferred group rename/friend-invite mobile UI (small, backend-ready).
4. Build E (Notifications).
5. Close the old GitHub PRs (#5 etc.) now that their commits are in main.
