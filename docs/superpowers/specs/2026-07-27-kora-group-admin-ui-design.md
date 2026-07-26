# Kora — Group admin mobile UI (rename + friend-invite): design spec

**Date:** 2026-07-27
**Branch:** `group-admin-ui` (off `main` @ e16983b)
**Status:** design approved; proceeding to plan.

## Context

Groups (Social C) shipped with two owner capabilities whose **backend exists and
is tested** but whose **mobile UI was deferred**:
- **Rename** — `PATCH /v1/groups/:id` body `{name}` → `{renamed:true}`. Owner-only.
- **Direct friend-invite** — `POST /v1/groups/:id/invite` body `{user_id}` →
  `{invited:true}`. Owner-only; the `user_id` must be an **accepted friend**
  (the service enforces `AreFriends`); adds them to the group directly.

This spec finishes the mobile half: two hooks + two owner-only sheets wired into
the existing group detail screen (`app/group/[id].tsx`).

## Goals

- An owner can rename their group from the group detail screen.
- An owner can invite one of their friends into the group directly.
- No change to non-owner experience; no backend changes.

## Non-goals (YAGNI)

- Bulk invite / multi-select; invite-by-search or invite-by-email (invite is
  from the owner's existing friends list only).
- Inline header rename (a sheet is enough).
- Un-invite (that is remove-member, which already exists).
- Any change to join-by-code, roster, leaderboard, or challenges sections.

## Decisions (approved)

- Two separate owner-only actions, each opening its own **conditional-mount**
  sheet (the established pattern — `CreateChallengeSheet` is mounted only when
  open so existing group-detail test mocks stay untouched).
- **RenameGroupSheet** is prefilled with the current group name.
- **InviteFriendSheet** lists the owner's friends **minus current group
  members**; tapping a friend invites them.

## Components

### Hooks (`src/api/hooks.ts`)
- `useRenameGroup()` — `mutationFn ({groupId, name}: {groupId: string; name: string}) => apiFetch(`/v1/groups/${groupId}`, {method:"PATCH", body: JSON.stringify({name})})`; `onSuccess (_d,{groupId}) →` invalidate `["groups"]` and `["group", groupId]`.
- `useInviteToGroup()` — `mutationFn ({groupId, userId}: {groupId: string; userId: string}) => apiFetch(`/v1/groups/${groupId}/invite`, {method:"POST", body: JSON.stringify({user_id: userId})})`; `onSuccess (_d,{groupId}) →` invalidate `["group", groupId]` and `["group-progress", groupId]` (roster + leaderboard refresh).

### `RenameGroupSheet` (`src/components/social/RenameGroupSheet.tsx`)
Mirrors `CreateGroupSheet`: `Sheet` + `Overline "Rename group"` + `TextInput`
(seeded with `currentName`, `autoCapitalize="words"`) + `Button "Save"`.
- Props: `{ visible: boolean; groupId: string; currentName: string; onClose: () => void }`.
- Blank trimmed name → inline error, no mutation.
- Success → `onClose()`. Error → inline "Couldn't rename. Try again."
- `Save` disabled while pending.
- Seeds the input from `currentName` when opened (a `useEffect` on
  `[visible, currentName]`, matching how `WeightLogSheet` syncs on open) so a
  reopen reflects the latest name.

### `InviteFriendSheet` (`src/components/social/InviteFriendSheet.tsx`)
`Sheet` + `Overline "Invite a friend"` + a list of eligible friends as
`Pressable` rows (name), each invoking the invite.
- Props: `{ visible: boolean; groupId: string; memberIds: string[]; onClose: () => void }`.
- Data: `useFriends()` → `Friend[]`; eligible = friends whose `id` is NOT in
  `memberIds`.
- Empty state (no eligible friends) → muted "No friends to invite. Everyone's
  already in, or add friends first."
- Tap a friend → `useInviteToGroup().mutate({groupId, userId: friend.id})`;
  success → `onClose()`; error → inline "Couldn't invite. Try again."
- Rows disabled while a mutation is pending (no double-invite).

### Wiring (`app/group/[id].tsx`)
- Add two owner-only actions. Place a small owner-controls row (or two ghost
  actions) so that when `isOwner`:
  - a "Rename group" action opens `RenameGroupSheet` (with `currentName={d.name}`).
  - an "Invite a friend" action opens `InviteFriendSheet` (with
    `memberIds={(d?.members ?? []).map(m => m.id)}`).
- Two independent `useState` booleans for the two sheets; both mounted
  conditionally (`{renameOpen ? <RenameGroupSheet .../> : null}` etc.), like the
  existing `CreateChallengeSheet` mount at the bottom of the screen.
- The existing Delete/Leave, roster, leaderboard, and challenges sections are
  unchanged.

## Error handling

- Both sheets surface backend failures inline (never silent); mutations
  disabled while pending.
- Owner-only guard is UI + server (`InviteFriend`/`Rename` are owner-gated in
  the service; the UI only shows the actions when `isOwner`).
- Invite requires an accepted friendship (server-enforced); the sheet only
  offers the owner's existing friends, so the common path never hits that error.

## Testing

- Hook tests (`src/api/__tests__/hooks.test.tsx`): `useRenameGroup` PATCHes
  `/v1/groups/:id` with `{name}`; `useInviteToGroup` POSTs
  `/v1/groups/:id/invite` with `{user_id}`.
- `RenameGroupSheet` test: seeded value; blank → no mutate + inline error;
  valid → mutate with `{groupId, name}`.
- `InviteFriendSheet` test: eligible list excludes current members; tap →
  mutate with `{groupId, userId}`; empty-eligible → empty state, no rows.
- `tsc --noEmit` + `npm test -- --ci` green (existing group-detail tests must
  still pass — conditional mount keeps their mocks valid).

## Tasks (~3)

1. `useRenameGroup` + `useInviteToGroup` hooks + hook tests.
2. `RenameGroupSheet` + owner "Rename group" action wired into `group/[id].tsx` + test.
3. `InviteFriendSheet` (friends minus members) + owner "Invite a friend" action wired in + test.
