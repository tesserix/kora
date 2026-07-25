# Design — Competitions (Social sub-project D)

**Date:** 2026-07-26
**Branch:** `phase-7-competitions` (new, off `main` HEAD `b35b8bf`)
**Type:** Full-stack feature — builds on Friends (A) + Compare (B) + Groups (C)

## Context

Fourth and (before Notifications) final social slice. Competitions are **time-boxed group
challenges**: a group member creates a challenge with a metric and a duration; members opt in;
everyone who joined is ranked on a windowed score; when the window closes, the top standing is the
winner. Challenges live **inside a group** — there are no friend-level or global challenges.

The one genuinely new idea is a **windowed score over an arbitrary date range**, which reuses B's
`foodlog.DailyKcal` exactly like `progress.Compute` does — no new SQL, no new kcal source. The hard
invariant (no fabricated nutrition; every kcal is row-sourced) is inherited for free because scoring
reads only `DailyKcal` aggregates.

### Consent model (important — differs from B/C)
- B's friends leaderboard and C's group leaderboard are gated by the always-on `share_progress`
  opt-in (via the single gate `compare.ProgressForMembers`).
- **A challenge is opt-in per challenge, and joining IS the consent.** A participant chose to be in
  this challenge, so their challenge score is shown to other participants — *regardless of their
  global `share_progress` flag*. Challenge standings therefore do **not** go through
  `compare.ProgressForMembers`; they compute every participant's `WindowScore` directly. A group
  member who did not join a challenge never appears in its standings.

Reuse points:
- `foodlog.DailyKcal(ctx, userID, from, to, loc)` — local-day kcal buckets (`to` exclusive).
- `progress.LogSource` interface (already exposes `DailyKcal`) — `WindowScore` takes the same
  interface, so it is stub-testable with no DB (mirrors `progress.Compute`).
- `groups.Repository.IsMember` / `RoleOf` — membership gate + owner check, identical to C's handlers.
- `user.IDFromContext` / `LocFromContext`, `httpx.OK` / `Error`, the `{data}` envelope.
- The `groups` package layout (model / repository / service / handler / errors) is the template.

### Product decisions (locked during brainstorming — user approved)
- **Metric: creator picks per challenge.** `on_target` = days in the window within ±10% of the
  participant's `target_kcal`. `logged` = distinct days logged in the window.
- **Participation: opt-in join; joining IS consent** (see above). **Creator auto-joins on create.**
- **Create permission: any group member** (not owner-only).
- **Placement:** a "Challenges" section in the **group detail screen** + a new **challenge detail
  screen** (`app/challenge/[id].tsx`). The More tab needs no change — challenges live inside groups.
- **Duration: presets, not a native date picker.** `1w` / `2w` / `1mo` → `start_date = today`,
  `end_date = today + {7,14,30} days`. Avoids adding a date-picker native dependency.

## 1. Data model (migration `000012_challenges`)

- **`challenges`**: `id uuid pk`, `group_id uuid not null references groups(id) on delete cascade`,
  `creator_id uuid not null references users(id) on delete cascade`, `title text not null`,
  `metric text not null` (`on_target`|`logged`), `start_date date not null`,
  `end_date date not null`, `created_at timestamptz not null default now()`. Index on `group_id`
  (list a group's challenges).
- **`challenge_participants`**: `challenge_id uuid not null references challenges(id) on delete
  cascade`, `user_id uuid not null references users(id) on delete cascade`,
  `joined_at timestamptz not null default now()`, **primary key `(challenge_id, user_id)`**. Index
  on `user_id` is not required (all reads are challenge-scoped).
- `.down.sql` drops both tables (`challenge_participants` first).
- **Dates are `date`, not `timestamptz`** — a challenge day is a calendar day, resolved against the
  viewer's `loc` at scoring time. Storing `date` keeps the window boundaries timezone-neutral.
- **GORM zero-time gotcha (bit us on Groups):** `joined_at` and `created_at` are bare `time.Time`
  fields → tag them `gorm:"autoCreateTime"` so GORM does not insert the Go zero time and override the
  SQL `DEFAULT now()`.

## 2. Backend

### 2a. `progress.WindowScore` (new, alongside `progress.Compute`)

```go
// WindowScore counts, over the inclusive local-day window [from, to], either
// on-target days (kcal within ±10% of targetKcal) or distinct logged days.
func WindowScore(ctx context.Context, logs LogSource, userID uuid.UUID,
    metric string, targetKcal float64, from, to time.Time, loc *time.Location) (int, error)
```

- Resolve `start` = `from` at 00:00 in `loc`; `end` = `to` at 00:00 in `loc`.
- One call: `kcalByDay, err := logs.DailyKcal(ctx, userID, start, end.AddDate(0,0,1), loc)` — the
  `+1 day` makes `end` inclusive (DailyKcal's `to` is exclusive). All returned keys fall inside the
  window because `DailyKcal` filters by range and `GROUP BY day` yields one row per day that has logs.
- `metric == "logged"` → `len(kcalByDay)` (distinct logged days in window).
- `metric == "on_target"` → iterate `d` from `start` to `end` inclusive; when `targetKcal > 0` and
  `math.Abs(kcalByDay[key] - targetKcal) <= 0.10 * targetKcal`, count it. (`targetKcal == 0` → 0,
  matching `Compute`'s adherence guard.) Reuse `adherenceBand` const.
- Unknown metric → return an error (validated earlier at the service, defensive here).
- Pure over the `LogSource` interface → unit-tested with the same stub style as `progress_test.go`
  (seed a fake `DailyKcal` map; assert counts for both metrics, the ±10% inclusive boundary, and the
  `target==0` case). No DB.

Add a `Metric` string type + `MetricOnTarget`/`MetricLogged` consts in the `challenges` package (the
metric is a challenge concept); `WindowScore` takes a bare `string` to avoid `progress → challenges`
coupling.

### 2b. New `internal/challenges` package (model / repository / service / handler / errors)

Layered like `groups`. Sentinel errors mapped to HTTP.

#### Types
- `Challenge{ID, GroupID, CreatorID uuid.UUID; Title string; Metric Metric; StartDate, EndDate
  time.Time; CreatedAt time.Time}`. `Metric` const (`MetricOnTarget = "on_target"`,
  `MetricLogged = "logged"`); `ValidMetric(string) bool`.
- `ChallengeParticipant{ChallengeID, UserID uuid.UUID; JoinedAt time.Time}`.
- Status is **computed, never stored**: `Status(now) → "upcoming"` (now < start) / `"active"`
  (start ≤ now ≤ end) / `"ended"` (now > end). Compare on local calendar day (the viewer's `loc`).
- Views:
  - `ChallengeSummary{ID, Title string; Metric Metric; Status string; StartDate, EndDate time.Time;
    ParticipantCount int; Joined bool}` (list within a group).
  - `Standing{UserID uuid.UUID; DisplayName string; Score int}`.
  - `ChallengeDetail{ID uuid.UUID; Title string; Metric Metric; Status string; StartDate, EndDate
    time.Time; Joined bool; CanDelete bool; Standings []Standing; Winner *Standing}` — `Winner` set
    only when `Status == "ended"` and there is ≥1 participant (top standing).

#### Repository
- `Create(ctx, groupID, creatorID uuid.UUID, title string, metric Metric, start, end time.Time)
  (Challenge, error)` — **transaction**: insert challenge + creator `challenge_participants` row.
- `FindByID(ctx, id) (*Challenge, error)` (nil,nil when absent).
- `ListForGroup(ctx, groupID, viewerID) ([]ChallengeSummary, error)` — join participant count; left
  join for the viewer's `joined`. (Status computed in the service/handler from the dates, not SQL.)
- `AddParticipant(ctx, challengeID, userID) error` — idempotent (`clause.OnConflict{DoNothing}`, like
  `groups.AddMember`).
- `RemoveParticipant(ctx, challengeID, userID) error`.
- `IsParticipant(ctx, challengeID, userID) (bool, error)`.
- `ListParticipantsForScoring(ctx, challengeID) ([]ScoringRow, error)` where
  `ScoringRow{ID uuid.UUID; DisplayName string; TargetKcal float64}` — every participant (join
  `users`), no `share_progress` filter (opt-in already consented).
- `Delete(ctx, challengeID) error`.

#### Service (guards enforced here)
Holds `challenges.Repository`, a `memberChecker` (interface over `groups.Repository.IsMember` /
`RoleOf` — decouples `challenges` from `groups`, mirroring `groups`' `friendChecker`), and a
`progress.LogSource`.

- `Create(ctx, userID, groupID, title string, metric Metric, duration string, today time.Time)` →
  **any group member** (`IsMember` → else `ErrForbidden`); validate `title != ""`
  (`ErrBadInput`), `ValidMetric` (`ErrBadInput`), duration ∈ {`1w`,`2w`,`1mo`} → `start = today`,
  `end = today + {7,14,30}` (`ErrBadInput` otherwise); `repo.Create` (auto-joins creator). Returns the
  challenge. (`today` passed in from the handler as the local calendar day, tz-correct.)
- `List(ctx, userID, groupID, now)` → **member-only** (`IsMember` → else `ErrForbidden`);
  `repo.ListForGroup`; fill each summary's `Status` from its dates vs `now` (viewer-local).
- `Join(ctx, userID, challengeID)` / `Leave(ctx, userID, challengeID)` → resolve challenge (404),
  gate on **group membership** of the challenge's `group_id` (`ErrForbidden` if not a member — can't
  join a challenge in a group you're not in); `AddParticipant` / `RemoveParticipant` (idempotent).
- `Detail(ctx, userID, challengeID, now, loc)` → resolve challenge (404); **member-only** on the
  challenge's group (`ErrForbidden`); compute `Status`; `ListParticipantsForScoring` →
  `progress.WindowScore` per participant (metric, their `TargetKcal`, `StartDate`, `EndDate`, `loc`)
  → `[]Standing` sorted **score desc, then DisplayName asc** (stable, deterministic tiebreak);
  `Joined` = `IsParticipant`; `CanDelete` = `userID == CreatorID || RoleOf(group)==owner`;
  `Winner` = `&Standings[0]` when `Status=="ended" && len(Standings)>0` else nil.
- `Delete(ctx, userID, challengeID)` → resolve challenge (404); allowed if **creator** OR **group
  owner** (`RoleOf`), else `ErrForbidden`; `repo.Delete` (cascades participants).

Errors: `ErrBadInput` (400), `ErrNotFound` (404), `ErrForbidden` (403).

#### Handlers + routes (authed `/v1`, all membership-gated inside the service)
- `POST /groups/:id/challenges {title, metric, duration}` → 201 challenge. (`duration` one of
  `1w`/`2w`/`1mo`; handler passes `today` = `time.Now()` in `LocFromContext` truncated to the day.)
- `GET /groups/:id/challenges` → `[]ChallengeSummary`. 403 if not a member.
- `POST /challenges/:cid/join` → 200 `{joined:true}`. 403 non-member, 404 unknown.
- `DELETE /challenges/:cid/join` → 200 `{left:true}`.
- `GET /challenges/:cid` → `ChallengeDetail`. 403 non-member, 404 unknown.
- `DELETE /challenges/:cid` → creator or group owner. 200 `{deleted:true}`. 403 otherwise.
- Error map: 400 bad-input, 403 forbidden, 404 not-found (mirror `groups.mapErr`).

`main.go` wires a `challenges.Handler` (needs `challenges.Repository`, `groups.Repository` as the
`memberChecker`, and the `foodlog.Repository` as the `LogSource`) and registers the six routes in the
authed `/v1` group next to the groups routes.

## 3. Mobile

### Types + hooks (`src/api/types.ts`, `hooks.ts`)
- Types: `Metric = "on_target" | "logged"`; `ChallengeStatus = "upcoming" | "active" | "ended"`;
  `ChallengeSummary` (`id,title,metric,status,start_date,end_date,participant_count,joined`);
  `ChallengeStanding` (`user_id,display_name,score`); `ChallengeDetail`
  (`id,title,metric,status,start_date,end_date,joined,can_delete,standings,winner?`).
- Hooks:
  - `useGroupChallenges(groupId)` — `["group-challenges", groupId]`, `enabled: !!groupId`.
  - `useChallenge(cid)` — `["challenge", cid]`, `enabled: !!cid`.
  - `useCreateChallenge()` — `POST /groups/:id/challenges`; invalidate `["group-challenges", groupId]`.
  - `useJoinChallenge()` / `useLeaveChallenge()` — invalidate `["challenge", cid]` +
    `["group-challenges", groupId]`.
  - `useDeleteChallenge()` — invalidate `["group-challenges", groupId]`.
- The create/join/leave/delete hooks take `{ groupId }` alongside their path arg so they can
  invalidate the parent list key.

### Screens
- **`app/group/[id].tsx`** (edit the existing Groups detail): add a **"Challenges" section** below the
  leaderboard/roster — a list of `ChallengeSummary` rows (title + status pill + metric label +
  participant count; tap → `router.push("/challenge/<id>")`), a **"New challenge"** action opening
  `CreateChallengeSheet`, and an empty state. Existing leaderboard/roster/owner-controls untouched.
- **`CreateChallengeSheet`** (new component): title input + a **metric toggle** (On-target / Logged)
  + a **duration preset** selector (1 week / 2 weeks / 1 month) → `useCreateChallenge` →
  `router.push` to the new challenge. Empty title → inline error, no mutate. `onError` inline.
- **`app/challenge/[id].tsx`** (new screen): header (title + status pill + metric + date range);
  **standings** list (rank + display name + score, from `useChallenge`); **Join / Leave** button
  driven by `joined`; a **winner banner** when `status === "ended"` (🏆 + winner name); **Delete**
  (confirm Alert) shown only when `can_delete`; back on success. Reuse the dark/editorial tokens and
  primitives already in the app (`ScreenHeader`, `Card`, `Badge`/pill, `Button`).
- **More tab: no change** — challenges are reached through Groups.

## 4. Privacy, edges, testing
- **Membership gates every challenge read/write** — you must be a member of the challenge's group to
  list/create/join/leave/view; 403 otherwise (same server-side gate as C, verified before any
  payload).
- **Opt-in = consent:** standings show every *participant's* score; a group member who did not join
  never appears; a participant's global `share_progress` is irrelevant (do NOT route through
  `compare.ProgressForMembers`). Non-participants are not scored.
- **No fabricated nutrition:** `WindowScore` reads only `DailyKcal` aggregates → invariant inherited
  (no LLM/derived number). Assert in a test that the score equals the count derived from a known
  seeded `DailyKcal` map.
- Status/winner are **computed from dates at read time**, never stored → no drift, no cron. Winner
  only when `ended` and ≥1 participant.
- Idempotent join (join-twice, leave-when-absent are safe). Delete cascades participants.
- Duration is preset-only; `start=today`, `end=today+N` in the creator's `loc`.
- **Backend tests:**
  - `progress.WindowScore` (stub `LogSource`): `logged` counts distinct days; `on_target` counts
    ±10%-inclusive days; `target==0 → 0`; boundary (target 2200: 2200 in, 2420 in, 2421 out);
    window edges inclusive of both `start` and `end`.
  - `challenges` service (stub repo + stub `memberChecker` + stub `LogSource`): create auto-joins
    creator; create rejected for non-member (403) / blank title / bad metric / bad duration;
    join/leave gated on group membership + idempotent; detail member-only; standings sorted
    score-desc/name-asc; winner nil when not ended, set when ended; delete allowed for creator and
    for group owner, 403 for a plain member.
  - `challenges` repository (DB, `kora_test`): create tx auto-joins creator + sets `joined_at` (not
    zero-time — regression for the GORM gotcha); `ListForGroup` participant_count + viewer `joined`;
    `ListParticipantsForScoring` returns all participants with `target_kcal`; delete cascades.
  - `challenges` handler: `POST /groups/:id/challenges` 201 + non-member 403; `GET /challenges/:cid`
    403 for non-member; `DELETE /challenges/:cid` 403 for plain member.
  - Migration `000012` up/down applies cleanly to `kora_test` (`go run ./cmd/migrate` first).
- **Mobile tests:** each hook (URL/body/invalidation key incl. parent list); group-detail Challenges
  section renders + "New challenge" opens the sheet; `CreateChallengeSheet` (blank-title guard,
  metric toggle, duration preset, success navigates); challenge detail renders standings, Join/Leave
  by `joined`, winner banner when ended, Delete visible only when `can_delete`.

## Out of scope (YAGNI — later / deferred)
- Custom date ranges / native date picker (presets only).
- Recurring / seasonal challenges, prizes, badges.
- Challenge **editing** (create + delete only).
- Notifications (challenge start/end, "you've been passed") — sub-project **E**.
- Friend-level or global challenges (group-scoped only).

## Task decomposition (for the plan) — ~8 tasks
1. Migration `000012` (challenges + challenge_participants) + `challenges` model + repository (tx
   create auto-joins creator; list-for-group; participants-for-scoring; join/leave/delete).
2. `progress.WindowScore` (both metrics, stub-tested) + `challenges` `Metric` type/consts.
3. `challenges` service (create/list/join/leave/detail/delete) + errors + membership/owner guards +
   standings sort + status/winner computation.
4. `challenges` handlers + routes + `main.go` wiring (six `/v1` endpoints, membership-gated).
5. Mobile types + all challenge hooks.
6. Challenges section in `app/group/[id].tsx` + `CreateChallengeSheet`.
7. `app/challenge/[id].tsx` (standings + status + join/leave + winner banner + delete).
8. Final consolidated review pass (whole-branch opus) — no new-surface task; fold Minor fixes.
