# Design — Friends foundation (Social sub-project A)

**Date:** 2026-07-25
**Branch:** `phase-4-social` (new, off `phase-2-nutrition-engine` HEAD `0981262`)
**Type:** Full-stack feature — new backend `social` domain + mobile Friends UI

## Context

Kora is gaining a social/competitive domain (compare progress with friends, groups that
compete). That domain decomposes into independent sub-projects: **A. Friends (social graph)**,
B. Compare progress, C. Groups, D. Competitions, E. Notifications. This spec covers **A only** —
the foundation everything else builds on. The app currently has **no social scaffolding**.

Users already have: `id uuid`, `email`, `display_name`, `firebase_uid` (`api/internal/user/model.go`).

### Product decisions (locked during brainstorming)
- **Discovery: both** a per-user **share code/link** and **add-by-email**.
- **Connection model: mutual request → accept** (both must consent — required because sub-project
  B will share health data on top of an accepted friendship).
- **Placement:** a **Friends** entry under the existing **More** tab (not a new bottom tab yet).
- **Foundation shares NO health data** — only `display_name` + `id`. Consent to share stats is a
  later sub-project gated on an accepted friendship.

## 1. Data model (backend)

### Migration `000009_friendships`
- Table `friendships`:
  - `id uuid primary key default gen_random_uuid()`
  - `requester_id uuid not null references users(id) on delete cascade`
  - `addressee_id uuid not null references users(id) on delete cascade`
  - `status text not null` — one of `pending`, `accepted`
  - `created_at timestamptz not null default now()`
  - `updated_at timestamptz not null default now()`
  - **Unique functional index** `ux_friendships_pair` on
    `(LEAST(requester_id,addressee_id), GREATEST(requester_id,addressee_id))` — prevents both
    A→B and B→A existing at once.
  - Index `ix_friendships_addressee` on `addressee_id` (incoming-request lookups).
  - `CHECK (requester_id <> addressee_id)` — no self-friendship at the DB level.
- Reversible `.down.sql` drops the table.

### Migration `000009` also adds `friend_code` to `users`
- Column `friend_code text` with a unique index (nullable). A short opaque code (8 chars,
  Crockford base32, no ambiguous chars) generated lazily the first time the user requests it.
  (Kept in the same migration number as a single logical "friends" schema change; the app uses
  golang-migrate — one paired up/down.)

## 2. Backend — `internal/social` package

Layered like the other domains (model / repository / service / handler), wired into the authed
`/v1` group in `internal/server/router.go`.

### Types (`model.go`)
- `Friendship` — GORM struct mapping the table.
- `FriendStatus` string const type: `FriendStatusPending`, `FriendStatusAccepted`.
- `FriendView { ID uuid.UUID; DisplayName string }` — public projection (never exposes email).
- `RequestView { ID uuid.UUID; User FriendView }` — a pending request + the *other* user.

### Repository (`repository.go`)
- `Create(ctx, Friendship) (Friendship, error)`
- `FindByPair(ctx, a, b uuid.UUID) (*Friendship, error)` — direction-agnostic (matches either order).
- `FindByID(ctx, id) (*Friendship, error)`
- `ListAccepted(ctx, userID) ([]FriendView, error)` — the *other* user of each accepted row, joined to `users`.
- `ListPending(ctx, userID) (incoming []RequestView, outgoing []RequestView, error)`.
- `UpdateStatus(ctx, id, status) error`
- `Delete(ctx, id) error`
- User-code helpers on the user repo (or a small query here): `FindUserByEmail`, `FindUserByCode`,
  `SetFriendCode`.

### Service (`service.go`)
- `SendRequest(ctx, requesterID uuid.UUID, byEmail, byCode string) (Friendship, error)`:
  1. Resolve the target user (by email OR by code — exactly one provided).
  2. Reject self (`ErrSelfFriend`) and missing target (`ErrUserNotFound`).
  3. Look up any existing pair:
     - none → create `pending` (requester→addressee).
     - existing `accepted` → return it (idempotent, `ErrAlreadyFriends` treated as success-ish 200).
     - existing `pending` **from the other direction** → set `accepted` (mutual → friends).
     - existing `pending` **same direction** → idempotent, return as-is.
- `Accept(ctx, addresseeID, requestID)`: load row, verify caller is the addressee and status is
  pending, set `accepted`. `ErrNotFound` / `ErrForbidden` otherwise.
- `Decline(ctx, addresseeID, requestID)`: same auth, then delete the row (re-requestable).
- `Unfriend(ctx, userID, otherID)`: find accepted pair, delete.
- `MyCode(ctx, userID) (code, link string)`: lazily generate + persist `friend_code` if unset;
  `link = "mobile://friend/" + code`.
- Errors are the package's sentinel errors, mapped to HTTP in the handler.

### Handler + routes (`handler.go`, wired in `router.go`)
All under the authed `/v1` group; caller id comes from the existing auth middleware (`user.*`
context helper already used by other handlers).
- `GET  /v1/friends` → `httpx.OK([]FriendView)`
- `GET  /v1/friends/requests` → `httpx.OK({ incoming: []RequestView, outgoing: []RequestView })`
- `POST /v1/friends/requests` → body `{ "email"?: string, "code"?: string }` (exactly one).
  201 with the friendship; 400 malformed / both-or-neither; 404 user-not-found; 409 self-friend.
- `POST /v1/friends/requests/:id/accept` → 200; 403 not-addressee; 404 no such pending row.
- `POST /v1/friends/requests/:id/decline` → 200 `{ declined: true }`; same auth codes.
- `DELETE /v1/friends/:userId` → 200 `{ removed: true }`; 404 if not currently friends.
- `GET  /v1/friends/code` → `httpx.OK({ code, link })`.

## 3. Mobile

### Types (`apps/mobile/src/api/types.ts`)
```ts
export interface Friend { id: string; display_name: string }
export interface FriendRequest { id: string; user: Friend }
export interface FriendRequests { incoming: FriendRequest[]; outgoing: FriendRequest[] }
export interface MyFriendCode { code: string; link: string }
```

### Hooks (`apps/mobile/src/api/hooks.ts`)
- `useFriends()` — `GET /v1/friends`, key `["friends"]`.
- `useFriendRequests()` — `GET /v1/friends/requests`, key `["friend-requests"]`.
- `useSendFriendRequest()` — `POST /v1/friends/requests` body `{email}` or `{code}`; invalidates
  `["friend-requests"]` (+ `["friends"]` in case of auto-accept).
- `useAcceptRequest()` — `POST /v1/friends/requests/:id/accept`; invalidates both keys.
- `useDeclineRequest()` — `POST /v1/friends/requests/:id/decline`; invalidates `["friend-requests"]`.
- `useUnfriend()` — `DELETE /v1/friends/:userId`; invalidates `["friends"]`.
- `useMyFriendCode()` — `GET /v1/friends/code`, key `["friend-code"]`.

### Screens
- **`apps/mobile/app/friends.tsx`** (pushed from More):
  - **Incoming requests** section (only when non-empty): each row = name + Accept / Decline.
  - **Friends** list: each row = display name + an unfriend action (confirm `Alert`).
  - **"Add friend"** button → opens `AddFriendSheet`.
  - Empty state when no friends/requests.
- **`apps/mobile/src/components/social/AddFriendSheet.tsx`** (shared `Sheet`):
  - Segmented **By code / By email** toggle + a text input + Submit → `useSendFriendRequest`.
  - **"Your code"** block showing `useMyFriendCode().code` with a Copy button and a native
    **Share** (`react-native` `Share.share({ message: link })`).
  - Success closes the sheet; errors surface inline (e.g. "No Kora account uses that email.",
    "That's your own code.").

### More screen wiring (`apps/mobile/app/(tabs)/more.tsx`)
- Add a real, navigating **"Friends"** row (`icon: "users"`) that `router.push("/friends")`. Register
  the `users` glyph in `Icon.tsx` (lucide `Users`) — unknown names silently fall back to `Circle`.
  (The existing More rows are currently dead; this makes the Friends one live.)

## 4. Privacy, errors, edge cases

- Foundation exposes only `display_name` + `id` — **no health data**. Accepting a friend is the
  consent gate sub-project B's stat-sharing will require.
- **Add-by-email reveals account existence** via a distinct "No Kora account uses that email"
  error. Conscious MVP tradeoff for usable UX; flagged for a later neutral-response hardening.
- Only existing Kora accounts can be added — no email-invite-to-join in this slice.
- Self-request rejected; duplicate/again requests are idempotent; a reverse-pending request
  auto-accepts into a friendship.
- Decline **deletes** the row (re-requestable). Block/report deferred.
- Every mobile failure path is visible (inline `AppText`); no silent catches; each mutation
  invalidates its queries.

## 5. Testing

### Backend (vs `kora_test`, `-race -p1 -count=1`)
- Service: self-friend rejected; user-not-found (email + code); create pending; duplicate
  same-direction idempotent; **reverse-pending auto-accept**; accept by addressee; accept by
  non-addressee → forbidden; decline deletes; unfriend removes accepted; code generate is stable
  (second call returns the same code); code resolve finds the user.
- Handler: `POST /friends/requests` 201 / 400 (both-or-neither) / 404 / 409; accept 200 / 403;
  decline 200; `DELETE /friends/:userId` 200 / 404; `GET /friends` and `/friends/requests` shapes;
  `GET /friends/code` returns code+link.
- Migration applies and reverts cleanly; unique-pair index rejects a reverse duplicate insert.

### Mobile (`npx tsc --noEmit` + `npm test -- --ci`)
- Each hook: correct URL/method/body + invalidation.
- Friends screen: renders friends + incoming requests; Accept calls the hook with the request id;
  unfriend confirms then calls the hook.
- AddFriendSheet: code vs email submit sends the right body; error surface renders; "Your code"
  shows the code and Share is wired.

## Out of scope (YAGNI — later sub-projects or deferred)
- Comparing/sharing any stats (sub-project B), groups (C), competitions (D), notifications (E).
- Email-invite-to-join for non-users; block/report; deep-link *handling* (the link is shareable
  text — tap-to-resolve is a follow-up); avatars/photo upload; neutral email-enumeration response.

## Task decomposition (for the plan)
1. Migration `000009` + `Friendship` model + repository (+ user code columns/queries).
2. `social` service (request/accept/decline/unfriend/code) with sentinel errors.
3. Handlers + routes wired into `/v1`.
4. Mobile types + the seven hooks.
5. Friends screen + `AddFriendSheet` + register `users` glyph.
6. More-screen "Friends" row wiring.
