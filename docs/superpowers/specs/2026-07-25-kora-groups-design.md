# Design — Groups (Social sub-project C)

**Date:** 2026-07-25
**Branch:** `phase-6-groups` (new, off `main` HEAD `aa48011`)
**Type:** Full-stack feature — builds on Friends (A) + Compare (B)

## Context

Third social slice. Groups let users form a named set of people and see a shared-progress
leaderboard scoped to that set. Membership graph is new; the leaderboard **reuses B's metric
computation and consent gate verbatim** — no new place where a non-sharing user's numbers could
leak. Time-boxed challenges/winners are **D** (out of scope here).

Reuse points:
- `progress.Compute` + `progress.LogSource` (from B) — habit metrics.
- `compare` package's consent gate — to be generalized so friends AND groups share one path.
- The friend-code/link pattern (`social` package) — mirrored for group invite codes.

### Product decisions (locked during brainstorming)
- **Join: both** a group **invite code/link** and **owner-invites-a-friend** (direct add).
- **Roles: owner + member.** Owner: rename, remove members, delete, invite friends. Any member:
  view/share the code, leave. One privileged role (no admin tier, no owner transfer).
- **Roster shows a leaderboard now** (reuse B), respecting each member's `share_progress`.
- **Placement:** a "Groups" row under the More tab → groups list → group detail. Mirrors Friends.

## 1. Data model (migration `000011_groups`)

- **`groups`**: `id uuid pk`, `name text not null`, `owner_id uuid not null references users(id) on
  delete cascade`, `invite_code text not null unique`, `created_at`, `updated_at`.
- **`group_members`**: `group_id uuid not null references groups(id) on delete cascade`,
  `user_id uuid not null references users(id) on delete cascade`, `role text not null`
  (`owner`|`member`), `joined_at timestamptz not null default now()`,
  **primary key `(group_id, user_id)`**. Index on `user_id` (list my groups).
- `.down.sql` drops both tables (group_members first).
- `invite_code`: 8-char Crockford base32, generated at creation (reuse the friend-code generator
  approach; non-empty + unique so a plain unique index is fine here).

Note: `groups` is a valid Postgres table identifier. GORM pluralizes `Group` → `groups`.

## 2. Backend — new `internal/groups` package

Layered like `social` (model / repository / service / handler). Sentinel errors mapped to HTTP.

### Types
- `Group{ID, Name, OwnerID uuid.UUID; InviteCode string; …}`, `GroupMember{GroupID, UserID uuid.UUID;
  Role Role; JoinedAt time.Time}`, `Role` const (`RoleOwner`, `RoleMember`).
- Views: `GroupSummary{ID, Name, MemberCount int, Role Role}` (list), `MemberView{ID, DisplayName,
  Role}` (roster), `GroupDetail{ID, Name, InviteCode?, MyRole, Members []MemberView}`.

### Repository
- `CreateGroup(ctx, ownerID, name, code) (Group, error)` — **transaction**: insert group + owner
  `group_members` row (`role=owner`).
- `FindByID`, `FindByInviteCode`, `ListForUser(userID) ([]GroupSummary)` (join membership; member
  count; my role), `AddMember(groupID,userID,role)`, `RemoveMember(groupID,userID)`,
  `IsMember(groupID,userID) bool`, `RoleOf(groupID,userID) (Role,bool)`, `ListMembers(groupID)
  ([]MemberView)`, `Rename(groupID,name)`, `DeleteGroup(groupID)`, and
  `ListMembersForProgress(groupID) ([]MemberProgressRow)` where `MemberProgressRow{ID, DisplayName,
  ShareProgress, TargetKcal}` is a groups-local type (the handler maps it to `compare.Member` —
  keeps the repo decoupled from the `compare` package).

### Service (guards enforced here)
- `Create(ownerID, name)` → generate code, `CreateGroup`. Returns the group.
- `JoinByCode(userID, code)` → resolve group by code (404 if none); add member idempotently
  (already a member → no-op success).
- `InviteFriend(ownerID, groupID, friendUserID)` → **owner-only**; the invitee must be an accepted
  friend of the owner (else 403/400); direct-add as member (idempotent). (They can leave.)
- `Leave(userID, groupID)` → remove own membership; **owner cannot leave** while others remain
  (must delete) → `ErrOwnerCannotLeave`.
- `RemoveMember(ownerID, groupID, memberID)` → owner-only; can't remove the owner.
- `Rename(ownerID, groupID, name)` / `Delete(ownerID, groupID)` → owner-only.
- `ListGroups(userID)`; `Detail(userID, groupID)` → **member-only** (403 otherwise); includes
  `invite_code` only for members.

### Consent-gate reuse (generalize `compare`)
- Extract the per-row computation into `compare.Service.ProgressForMembers(ctx, day, loc,
  []compare.Member) []compare.FriendProgress`, where `compare.Member{ID, DisplayName, ShareProgress,
  TargetKcal}`. This is the single place the consent gate lives.
- Refactor `compare.Service.Compare` (friends) to build `[]Member` from `ListAcceptedForCompare` and
  call `ProgressForMembers` — behavior unchanged, tests stay green.
- The group-progress handler builds `[]Member` from `groups.Repository.ListMembersForProgress` and
  calls the same `ProgressForMembers` — one gate, two callers.

### Handlers + routes (authed `/v1`)
- `POST /groups {name}` → 201 group.
- `GET /groups` → `[]GroupSummary`.
- `POST /groups/join {code}` → 200 the joined group summary; 404 bad code.
- `GET /groups/:id` → `GroupDetail`; 403 if not a member.
- `GET /groups/:id/code` → `{code, link}` (`mobile://group/<code>`); member-only.
- `GET /groups/:id/progress` → `{members: []FriendProgress}`; member-only; consent-gated.
- `POST /groups/:id/invite {user_id}` → owner-only; 200.
- `DELETE /groups/:id/members/:userId` → leave (self) or owner-remove; owner-can't-be-removed.
- `PATCH /groups/:id {name}` → owner-only rename.
- `DELETE /groups/:id` → owner-only delete (cascades members).
- Error map: not-found 404, forbidden 403, bad-input 400, owner-cannot-leave 409.

## 3. Mobile

### Types + hooks (`src/api/types.ts`, `hooks.ts`)
- Types: `GroupSummary`, `GroupMemberView`, `GroupDetail`, `GroupProgress` (`{members:
  FriendProgress[]}` — reuse `FriendProgress` from B), `GroupCode`.
- Hooks: `useGroups()` (`["groups"]`), `useGroup(id)` (`["group", id]`), `useGroupProgress(id)`
  (`["group-progress", id]`), `useCreateGroup()`, `useJoinGroup()`, `useLeaveGroup()`,
  `useGroupCode(id)`, `useInviteToGroup()`, `useRemoveMember()`, `useRenameGroup()`,
  `useDeleteGroup()`. Mutations invalidate the relevant `["groups"]`/`["group", id]` keys.

### Screens
- **`app/groups.tsx`** (from More): my-groups list (name + member count + role badge, tap → detail),
  a **Create group** action (name sheet → `useCreateGroup` → navigate to the new group), and a
  **Join by code** action (code sheet → `useJoinGroup`).
- **`app/group/[id].tsx`**: group detail —
  - a leaderboard (reuse `FriendsLeaderboard`'s shape, fed by `useGroupProgress`),
  - the member **roster** (`useGroup`) with role labels,
  - **Share code** (from `useGroupCode`),
  - **owner controls** shown only when `myRole==='owner'`: rename, remove a member, delete group
    (confirm),
  - **Leave group** for non-owners.
- **More screen:** a "Groups" row (`icon: "users"` or a distinct glyph) → `router.push("/groups")`.

## 4. Privacy, edges, testing
- Membership gates every group read (detail, code, progress) — 403 for non-members.
- Leaderboard reuses B's **airtight** consent gate — a non-sharing member shows no metrics.
- Owner can't be removed / can't leave while others remain (must delete); delete cascades
  memberships; join-twice and leave-when-absent are idempotent-safe; invite requires an accepted
  friendship.
- **Backend tests:** create auto-joins owner; join-by-code adds membership (+ idempotent); detail
  403 for non-member; owner-only mutations 403 for members; invite requires friendship; remove/leave;
  owner-cannot-leave 409; delete cascades; `ProgressForMembers` consent gate (sharing member shows
  metrics, non-sharing hides — same assertion style as B); friends `Compare` still green after the
  refactor.
- **Mobile tests:** each hook (URL/body/invalidation); groups list + create/join; group detail
  roster + leaderboard render; owner controls visible only to owner; leave hidden for owner.

## Out of scope (YAGNI — later / deferred)
- Admin tier / owner transfer / pending group-invite-accept (direct add for owner-invite).
- Time-boxed challenges, winners, seasons (sub-project D).
- Group avatars, descriptions, per-group settings, notifications (E).

## Task decomposition (for the plan)
1. Migration `000011` + `groups` models + repository (groups + group_members, tx create).
2. `groups` service (create/join/invite/leave/remove/rename/delete/list/detail) + errors.
3. Generalize `compare` → `ProgressForMembers`; refactor friends `Compare` to use it.
4. `groups` handlers + routes (incl. `GET /groups/:id/progress` via `ProgressForMembers`).
5. Mobile types + all group hooks.
6. `app/groups.tsx` (list + create + join).
7. `app/group/[id].tsx` (roster + leaderboard + owner controls + leave).
8. More-tab "Groups" row.
