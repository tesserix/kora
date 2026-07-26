# Kora Phase 10 — OS Push (E2b): design spec

**Date:** 2026-07-27
**Branch:** `phase-10-push` (off `main` @ 6b2fce7)
**Status:** design approved; spec under review before planning.

## Context

The social stack A→E2a is shipped and live-verified. Notifications exist as an
**in-app feed** (E1) plus **time-triggered rows** written by the E2a scheduler.
Every notification row — regardless of source — is created through
`notifications.Repository.Create`.

E2b is the last notifications slice: **OS push**. Its *live* half (real device
delivery) is blocked on the user supplying an EAS project (`eas init` →
`projectId` in `app.json`), Apple APNs credentials, and a physical device (the
iOS simulator cannot receive push). This phase builds the **ready-but-inert
plumbing** so the whole path flips live the moment those credentials exist —
with zero further code changes beyond configuration.

## Goals

- A durable, retriable server path that turns any new notification row into an
  OS push, covering **both** E1 action-triggered rows and E2a scheduler rows.
- Device-token registration/de-registration endpoints and storage.
- Mobile registration + permission + foreground/deep-link wiring that compiles
  and unit-tests now and activates once EAS is configured.
- Everything **off by default**; no behavior change to the existing app until
  `PUSH_ENABLED=true` + credentials are added.

## Non-goals (YAGNI)

- Provisioning the EAS project / APNs credentials / physical-device delivery
  (the user's step, out of scope here).
- Rich notification categories/actions, badge-count sync, local/scheduled
  notifications, per-type user preferences or muting.
- Android FCM specifics beyond the Expo push abstraction.

## Locked decisions (from brainstorm)

1. **Send trigger = push outbox ticker.** A `push_sent_at` marker column on
   `notifications` + a dispatcher ticker that scans unsent rows, sends, marks.
   Mirrors the proven E2a scheduler notify-then-mark idempotency. Covers both
   notification sources because both go through `Repository.Create`.
2. **Gate = `PUSH_ENABLED` flag (default false); registration always mounted.**
   The flag gates only the dispatcher ticker + Expo send. The device-token
   registration endpoints mount regardless, so tokens accumulate harmlessly now
   and start receiving push the moment push is enabled.
3. **Stale-push guard = freshness window.** The dispatcher only sends rows whose
   `created_at` is within a recent window (`PUSH_FRESHNESS`, default 15m). Older
   unsent rows are marked sent-skipped without pushing → no stampede on first
   enable or after downtime.
4. **Token lifecycle = register on sign-in + de-register on sign-out.** Upsert
   on sign-in; `DELETE` on sign-out so a shared device stops receiving the
   previous user's push. Prune tokens Expo reports as `DeviceNotRegistered`.
5. **Mobile scope = full plumbing, gracefully inert.** Install
   `expo-notifications`/`expo-device`, wire the registration hook + foreground
   handler, guard on `projectId` (absent → skip token fetch silently). Requires
   a native dev-build rebuild (controller runs it).

## Architecture — push outbox

```
notification row created (E1 action-trigger OR E2a scheduler)
        │  (push_sent_at = NULL)
        ▼
push dispatcher tick (every PUSH_INTERVAL, only when PUSH_ENABLED)
  1. skip stale:  UPDATE notifications SET push_sent_at=now()
                  WHERE push_sent_at IS NULL AND created_at <= now()-freshness
  2. send fresh:  SELECT unsent rows in window (join users for actor_name)
                  → for each recipient: list device_tokens
                  → Expo Push API (batch ≤100)
                  → MarkPushSent(row)         [notify-then-mark]
     send-fail  → row stays NULL → retried next tick until it ages out (bounded)
     receipt DeviceNotRegistered → prune that device_token row
```

The dispatcher is a separate goroutine started in `main.go` alongside (and
independent of) the E2a scheduler. It never touches the HTTP request path. Tick
errors are logged and the loop continues (never crashes the API).

## Data model — migration 000015

**`device_tokens`**
| column      | type        | notes                                   |
|-------------|-------------|-----------------------------------------|
| id          | uuid pk     | `gen_random_uuid()`                     |
| user_id     | uuid        | FK → users(id) ON DELETE CASCADE        |
| token       | text        | **UNIQUE** (Expo push token string)     |
| platform    | text        | `ios` \| `android`                      |
| created_at  | timestamptz | `autoCreateTime`                        |
| updated_at  | timestamptz | `autoUpdateTime`                        |

Index on `user_id` for the dispatcher's per-recipient lookup. Upsert:
`ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id,
platform = EXCLUDED.platform, updated_at = now()` — a shared device that a new
user signs into is reassigned to that user.

**`notifications.push_sent_at`** — `TIMESTAMPTZ NULL`. GORM: `*time.Time`,
`gorm:"column:push_sent_at"`, `json:"-"`, **no** autoCreateTime (set explicitly,
like the E2a `*_notified_at` columns). Reversible down migration drops the
column and the `device_tokens` table.

## Backend components

### `internal/devices`
- `DeviceToken` model (table `device_tokens`, autoCreate/autoUpdate tags).
- `Repository`: `Upsert(ctx, userID, token, platform) error`,
  `DeleteByToken(ctx, userID, token) error` (scoped to caller — a user may only
  delete their own token binding), `ListForUser(ctx, userID) ([]DeviceToken, error)`.
- `Handler` (thin): `POST /v1/devices {token, platform}` → upsert for caller
  (401 no auth, 400 blank token / platform not in `{ios, android}`, **200** ok
  — idempotent upsert, not create-once); `DELETE /v1/devices/:token` → delete
  for caller (200, idempotent — deleting an absent/other-user token is a no-op
  200, never leaks existence). Routes mounted under the authed `/v1` group
  **always** (independent of `PUSH_ENABLED`).

### `internal/notifications` (additions)
- `SkipStalePush(ctx, cutoff time.Time) (int, error)` — bulk mark old unsent.
- `ListPendingPush(ctx, since time.Time, limit int) ([]PendingPush, error)` —
  unsent rows with `created_at > since`, joined to `users` for `actor_name`;
  returns `PendingPush{ID, UserID, Type, ActorName, EntityID, CreatedAt}`.
- `MarkPushSent(ctx, id uuid.UUID) error`.

### `internal/push`
- `Sender` interface: `Send(ctx, messages []Message) ([]Receipt, error)` where
  `Message{To, Title, Body, Data map[string]any}` and a `Receipt` carries per-
  token status incl. a `DeviceNotRegistered` signal.
- `ExpoSender` — HTTP `POST https://exp.host/--/api/v2/push/send`, batches ≤100
  messages/request, optional `Authorization: Bearer EXPO_ACCESS_TOKEN`, parses
  tickets, surfaces `DeviceNotRegistered` for pruning. Never panics; transport/
  decode errors returned.
- `NoopSender` — for tests / disabled path (records or drops).
- `Dispatcher` with ports:
  - `pendingStore` (`SkipStalePush`, `ListPendingPush`, `MarkPushSent`),
  - `tokenLister` (`ListForUser`), plus `pruneToken`,
  - `Sender`.
  - `Tick(ctx, now)`: skip-stale → list-fresh → per row build message(s) from
    type + actor_name (copy table below) → send → `MarkPushSent`; prune tokens
    on `DeviceNotRegistered`. A recipient with no tokens → still mark sent.
  - `Run(ctx)`: ticker loop (E2a pattern), logs tick error and continues,
    returns on `ctx.Done`.

### Push copy (server-built from type + actor_name)
Title `"Kora"`; `data: {type, entity_id}` for deep-link.

| type               | body                                   |
|--------------------|----------------------------------------|
| friend_request     | `{actor} sent you a friend request`    |
| friend_accept      | `{actor} accepted your friend request` |
| group_invite       | `{actor} added you to a group`         |
| challenge_created  | `{actor} created a challenge`          |
| challenge_started  | `A challenge you joined has started`   |
| challenge_ended    | `{actor} won a challenge`              |
| challenge_passed   | `{actor} passed you in a challenge`    |

(These are server-generated for push; the in-app feed keeps its own
`message()` copy in `notifications.tsx`. Minor intentional duplication — push
strings live server-side because the row is the source of truth for a push.)

### Config (`internal/config`)
- `PushEnabled bool` ← `PUSH_ENABLED == "true"` (default false).
- `PushInterval time.Duration` ← `getdur("PUSH_INTERVAL", 30s)` (used only when enabled).
- `PushFreshness time.Duration` ← `getdur("PUSH_FRESHNESS", 15m)`.
- `ExpoAccessToken string` ← `os.Getenv("EXPO_ACCESS_TOKEN")` (optional).

### `main.go` wiring
After the scheduler block: if `cfg.PushEnabled`, construct
`devices.NewRepository(db)`, `notifications.NewRepository(db)` (own instance),
`push.NewExpoSender(cfg.ExpoAccessToken)`, `push.New(...)` and
`go dispatcher.Run(pushCtx)` with its own cancel called before `srv.Shutdown`.
Registration routes are mounted via `server.Deps` regardless of the flag.

## Mobile components (gracefully inert until `eas init`)

- **Deps**: `expo-notifications`, `expo-device` (via `expo install`), add the
  `expo-notifications` config plugin to `app.json` plugins. Native module →
  requires a dev-build rebuild (controller runs `expo run:ios`).
- **`src/api`**: `registerDevice(token, platform)` → `POST /v1/devices`;
  `unregisterDevice(token)` → `DELETE /v1/devices/:token`.
- **`usePushRegistration` hook**: on signed-in auth state →
  guard `Constants.expoConfig?.extra?.eas?.projectId` (absent → return silently,
  no crash) → request notification permission (denied → return) →
  `getExpoPushTokenAsync({ projectId })` → `registerDevice(token, Platform.OS)`;
  cache the token (AsyncStorage) so sign-out can `unregisterDevice`. Wired into
  `_layout` / the auth flow; the More-screen "Sign out" calls `unregisterDevice`
  before `signOut`.
- **Foreground + deep-link**: `Notifications.setNotificationHandler` (show
  foreground notifications) + a `addNotificationResponseReceivedListener` that
  deep-links using `data.type` / `data.entity_id`, reusing the `targetFor`
  mapping already in `app/notifications.tsx` (extract it to a shared helper if
  needed so both the inbox and the push responder use one source of truth).

## Error handling & invariants

- **Never crashes the API.** Dispatcher tick errors logged + loop continues;
  per-row/per-token send errors logged + row left for bounded retry.
- **Best-effort.** Push failure never affects the in-app feed (already working)
  or any HTTP request. The feed remains the durable record; push is additive.
- **Bounded retry.** A row that keeps failing to send ages out of the freshness
  window and is skipped — no infinite rescanning, no runaway Expo calls.
- **No stampede.** Freshness window is the single guard; enabling push after
  downtime never blasts historical rows.
- **User isolation.** Registration/deletion scoped to the caller; upsert
  reassigns a shared device; token FK cascades on user deletion.
- **No secrets in code.** `EXPO_ACCESS_TOKEN` via env only.
- **Inert by default.** `PUSH_ENABLED=false` → no dispatcher, no Expo calls;
  mobile guards on `projectId` → no token fetch. Zero behavior change until the
  user opts in.

## Testing

**Backend**
- Migration/repo DB tests: `device_tokens` upsert (reassign on conflict),
  user cascade, `ListForUser`; notifications `SkipStalePush` vs
  `ListPendingPush` freshness boundary, `MarkPushSent`.
- `Dispatcher.Tick` stub unit tests (fake `Sender` + in-memory stores):
  freshness boundary (in-window sends, out-window skipped-not-sent), recipient
  with no tokens (marked sent, no send), send-fail → not marked → retried,
  `DeviceNotRegistered` → token pruned.
- `devices.Handler` tests: register 200/400/401, delete 200/401.
- Config tests: defaults (disabled, 30s/15m) + overrides.

**Mobile**
- `usePushRegistration` tests: `projectId` absent → no-op (no token fetch, no
  POST), permission denied → no-op, happy path → POST `/v1/devices` with token +
  platform, sign-out → DELETE.
- Deep-link mapping test for the notification-response handler (per-type target).
- `tsc --noEmit` + `npm test -- --ci` green.

## Task breakdown (~6, finalized in planning)

1. **T1** migration 000015 (`device_tokens` + `notifications.push_sent_at`) +
   models (`DeviceToken`, `Notification.PushSentAt`) + `devices.Repository` +
   notifications outbox repo methods. DB tests.
2. **T2** `internal/push`: `Sender`/`ExpoSender`/`NoopSender` + `Dispatcher`
   (ports, `Tick`, `Run`). Stub unit tests.
3. **T3** `devices.Handler` + routes + config (`PUSH_*`, `EXPO_ACCESS_TOKEN`) +
   `main.go` dispatcher wiring (started only when `PUSH_ENABLED`). Handler +
   config tests.
4. **T4** mobile deps (`expo-notifications`/`expo-device`) + `app.json` plugin +
   jest mocks (dev-build; controller rebuilds).
5. **T5** mobile `registerDevice`/`unregisterDevice` + `usePushRegistration`
   hook + wiring into `_layout`/auth + sign-out unregister. Hook tests.
6. **T6** mobile foreground handler + notification-response deep-link (reuse
   `targetFor`). Tests.

## Post-phase (user-owned, to flip live)

1. `eas init` in `apps/mobile` → `projectId` lands in `app.json`.
2. Configure Apple APNs credentials (EAS credentials) + a physical iOS device.
3. Set `PUSH_ENABLED=true` (+ optional `EXPO_ACCESS_TOKEN`) in the API env.
4. Rebuild the dev client and sign in on the device → token registers → the
   dispatcher delivers real OS pushes.
