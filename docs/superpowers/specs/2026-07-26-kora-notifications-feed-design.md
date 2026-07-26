# Design — Notification Feed (Social sub-project E1)

**Date:** 2026-07-26
**Branch:** `phase-8-notifications` (new, off `main` HEAD `e359a97`)
**Type:** Full-stack feature — builds on Friends (A) + Groups (C) + Competitions (D)

## Context

First half of **E. Notifications**, sequenced **feed first, then push** (E2). E1 is a purely
in-app notification feed: a `notifications` table, rows written cheaply in the same request that
triggers them (no scheduler), read/unread endpoints, a mobile inbox screen, and an unread badge.
**No device tokens, no FCM, no OS permissions, no cron, no cost** — it works in the current dev
build immediately.

E2 (a later sub-project) layers OS push on the *same* notification records and adds a scheduler for
the **time-triggered** events (challenge started / ended / "you've been passed"). Those are
explicitly **out of scope here** — E1 covers only the four action-triggered events, each written
synchronously by the service that performs the action.

Reuse points:
- The `internal/social`, `internal/groups`, `internal/challenges` services — E1 wires a best-effort
  notifier into their existing state-change branches.
- `groups.Repository.ListMembers` — the challenge fan-out lists members through it.
- `user.IDFromContext`, `httpx.OK`/`Error`, the `{data}` envelope, the More-tab row + floating-tab
  pattern from Friends/Groups, `slog.WarnContext` best-effort logging (as in `foodlog.EditLog`).

### Product decisions (locked during brainstorming — user approved)
- **Delivery:** in-app feed now; OS push is E2.
- **Events (all four action-triggered):** friend request received, friend request accepted, added to
  a group, new challenge in your group.
- **Placement:** a "Notifications" row under the More tab **plus** an unread-count badge dot on the
  More tab icon in the floating tab bar (ambiently visible from anywhere).
- **Read behavior:** the badge shows the unread count; opening the inbox marks all read → badge → 0;
  rows still render unread styling from the fetch taken *before* the mark.

## 1. Data model (migration `000013_notifications`)

- **`notifications`**: `id uuid pk`, `user_id uuid not null references users(id) on delete cascade`
  (recipient), `type text not null` (`friend_request｜friend_accept｜group_invite｜challenge_created`),
  `actor_id uuid not null references users(id) on delete cascade` (who caused it),
  `entity_id uuid null` (deep-link target — group id or challenge id; null for friend events),
  `read_at timestamptz null`, `created_at timestamptz not null default now()`.
- Indexes: `ix_notifications_user_created` on `(user_id, created_at DESC)` (the feed);
  `ix_notifications_unread` partial `(user_id) WHERE read_at IS NULL` (the unread count).
- `.down.sql` drops the table.
- The actor's `display_name` is **joined at read time** (not denormalized) so renames stay correct —
  same convention as group rosters. `created_at` is a bare `time.Time` tagged
  `gorm:"autoCreateTime"` (the GORM zero-time gotcha).

## 2. Backend — new `internal/notifications` package

Layered like `groups` (model / errors / repository / service / handler).

### Types
- `Notification{ID, UserID, ActorID uuid.UUID; Type string; EntityID *uuid.UUID; ReadAt *time.Time;
  CreatedAt time.Time}`. `Type` consts `TypeFriendRequest`/`TypeFriendAccept`/`TypeGroupInvite`/
  `TypeChallengeCreated`.
- View: `NotificationView{ID uuid.UUID; Type string; ActorID uuid.UUID; ActorName string; EntityID
  *uuid.UUID; Read bool; CreatedAt time.Time}` (`Read = ReadAt != nil`; serialized `json:"read"`).

### Repository
- `Create(ctx, n Notification) error` (single) — sets a fresh id, best-effort insert.
- `ListForUser(ctx, userID uuid.UUID, limit int) ([]NotificationView, error)` — join `users` for
  `actor_name`, order `created_at DESC`, cap `limit` (50).
- `UnreadCount(ctx, userID uuid.UUID) (int, error)` — `count(*) WHERE user_id=? AND read_at IS NULL`.
- `MarkAllRead(ctx, userID uuid.UUID) (int, error)` — `UPDATE … SET read_at = now() WHERE user_id=?
  AND read_at IS NULL`, returns rows affected.

### Service (implements the notifier interfaces + owns fan-out)
`notifications.Service` holds the `Repository` and a `memberLister` (`groups.Repository` satisfies it,
importing `internal/groups` for `groups.MemberView` — one-way, no cycle). It exposes:
- `FriendRequested(ctx, recipientID, actorID uuid.UUID) error` → one row `friend_request`, entity nil.
- `FriendAccepted(ctx, recipientID, actorID uuid.UUID) error` → one row `friend_accept`, entity nil.
- `AddedToGroup(ctx, recipientID, actorID, groupID uuid.UUID) error` → one row `group_invite`,
  entity = groupID.
- `ChallengeCreated(ctx, groupID, actorID, challengeID uuid.UUID) error` → **fan-out**: list group
  members, write one `challenge_created` row per member `≠ actorID`, entity = challengeID. (A
  per-member Create failure is logged and does not abort the rest.)
- Plus the read-side pass-throughs the handler needs (`List`, `UnreadCount`, `MarkAllRead`).

```go
type memberLister interface {
    ListMembers(ctx context.Context, groupID uuid.UUID) ([]groups.MemberView, error)
}
```

### Best-effort, nil-safe wiring into the triggering services
Each triggering service gains an **optional** notifier via a `WithNotifier` setter (returns a new
`Service` value — keeps every existing `NewService(...)` call and test unchanged; an unset notifier
is a no-op). Notifier failures are logged with `slog.WarnContext` and **never fail the action**.

Per-service notifier interface (only the methods that service needs):
- `social.Service` → `interface { FriendRequested(ctx, recipient, actor) error; FriendAccepted(ctx,
  recipient, actor) error }`. Call sites (exact branches):
  - `SendRequest`: **new-request** branch (after `repo.Create` of a pending friendship) →
    `FriendRequested(target.ID, requesterID)`.
  - `SendRequest`: **reverse-pending auto-accept** branch (after `UpdateStatus … Accepted`) →
    `FriendAccepted(existing.RequesterID, requesterID)` (the original requester is the one whose
    request just got accepted). The idempotent no-op branch (already accepted / same-direction
    pending) notifies **nothing**.
  - `Accept`: after `UpdateStatus … Accepted` → `FriendAccepted(f.RequesterID, addresseeID)`.
- `groups.Service` → `interface { AddedToGroup(ctx, recipient, actor, groupID) error }`. Call site:
  `InviteFriend`, after `repo.AddMember` succeeds → `AddedToGroup(friendID, ownerID, groupID)`.
- `challenges.Service` → `interface { ChallengeCreated(ctx, groupID, actor, challengeID) error }`.
  Call site: `Create`, after `repo.Create` succeeds → `ChallengeCreated(groupID, userID, ch.ID)`.

### Handlers + routes (authed `/v1`)
- `GET /notifications` → `[]NotificationView` (last 50, desc).
- `GET /notifications/unread-count` → `{count}`.
- `POST /notifications/read` → mark all read → `{marked}`.
- Wired in `router.go`: build `notificationsRepo` + `notificationsSvc` (with `groupsRepo` as the
  `memberLister`), attach it to the three services via `.WithNotifier(notificationsSvc)`, and mount
  the three routes.

## 3. Mobile

### Types + hooks (`src/api/types.ts`, `hooks.ts`)
- `NotificationType = "friend_request"｜"friend_accept"｜"group_invite"｜"challenge_created"`;
  `AppNotification { id; type: NotificationType; actor_id; actor_name; entity_id?: string; read:
  boolean; created_at: string }`.
- `useNotifications()` — `["notifications"]` → `AppNotification[]`.
- `useUnreadCount()` — `["notifications","unread"]` → `{count:number}`, with a `refetchInterval`
  (~60s) so the badge stays fresh.
- `useMarkAllRead()` — `POST /v1/notifications/read`; invalidates `["notifications"]` +
  `["notifications","unread"]`.

### Screens
- **`app/notifications.tsx`** (from the More row): inbox list — each row shows the actor name + a
  per-type message (e.g. *"{name} sent you a friend request"* / *"{name} accepted your request"* /
  *"{name} added you to a group"* / *"{name} started a challenge"*) + relative time; an unread dot
  from the pre-mark `read` flag. Tap **deep-links**: friend events → `/friends`; `group_invite` →
  `/group/${entity_id}`; `challenge_created` → `/challenge/${entity_id}` (all `as Href`). On mount →
  `useMarkAllRead()` (badge clears). Empty state when the list is empty. Reuses `ScreenHeader`,
  `AppText`, theme tokens.
- **More screen:** a "Notifications" row (with the unread count) → `router.push("/notifications")`,
  placed with the Friends/Groups rows.
- **Floating tab bar:** a small unread **badge dot on the More tab icon**, driven by
  `useUnreadCount()` (hidden when count is 0).

## 4. Privacy, edges, testing
- Every notification is **user-scoped**: list/unread/mark-all filter `user_id = caller`; no cross-user
  read. `actor_id`/`actor_name` are the only other-user data exposed (display name only — same as
  rosters; never email).
- **Best-effort:** a notifier failure is logged and never fails the friend-request / accept / invite /
  challenge-create action. An unwired notifier is a no-op (existing tests stay green).
- Challenge fan-out excludes the creator; a per-member insert failure doesn't abort the others.
- The reverse-pending auto-accept edge fires `friend_accept` (not `friend_request`); idempotent
  re-sends fire nothing.
- Actor deletion cascades notifications (FK `on delete cascade`).
- **Backend tests:**
  - `notifications` repository (DB, `kora_test`): create + `ListForUser` (desc, actor_name joined,
    limit); `UnreadCount`; `MarkAllRead` (returns count, second call returns 0); user-scoping (one
    user's rows invisible to another).
  - `notifications` service: `ChallengeCreated` fan-out writes one row per member ≠ creator (stub
    `memberLister`); the 1:1 methods write exactly one row of the right type/entity.
  - Integration (best-effort): `social.SendRequest` with a wired notifier writes a `friend_request`
    row to the addressee; the auto-accept edge writes `friend_accept` to the original requester;
    `social.Accept` writes `friend_accept` to the requester; `groups.InviteFriend` writes
    `group_invite`; `challenges.Create` writes `challenge_created` to each other member. A notifier
    that errors does **not** fail the action (assert the action still succeeds).
  - Handler: `GET /notifications` / `unread-count` / `POST read` return the caller's data; 401 without
    a user.
  - Migration `000013` up/down applies cleanly to `kora_test`.
- **Mobile tests:** each hook (URL/key/invalidation); notifications screen renders rows + per-type
  message + deep-link targets + mark-all-on-mount; More row shows the unread count; tab badge shows
  when count > 0 and hides at 0.

## Out of scope (YAGNI — E2 / later)
- OS push (device tokens, FCM, permissions) — **E2**.
- The scheduler + time-triggered events (challenge started / ended, "you've been passed") — **E2**.
- Per-item read, notification preferences/settings, grouping/collapsing, pagination beyond last-50,
  real-time delivery (poll only), notification deletion.

## Task decomposition (for the plan) — ~7 tasks
1. Migration `000013` + `notifications` model + errors + repository (create / list-with-actor-join /
   unread-count / mark-all-read).
2. `notifications` service — the four notifier methods (incl. challenge fan-out via `memberLister`)
   + read-side pass-throughs, unit-tested with a stub member lister.
3. `notifications` handlers + routes.
4. Wire the notifier into `social` / `groups` / `challenges` via `WithNotifier` (best-effort, exact
   call sites incl. the auto-accept edge) + integration tests; mount everything in `router.go`.
5. Mobile types + hooks (`useNotifications` / `useUnreadCount` / `useMarkAllRead`).
6. `app/notifications.tsx` (inbox + per-type messages + deep-links + mark-all-on-mount) + More row.
7. Floating-tab-bar unread badge on the More icon.
