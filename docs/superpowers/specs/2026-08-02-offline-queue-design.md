# Design — offline logging queue, slice 1: offline writes (#22)

**Date:** 2026-08-02
**Issue:** [#22](https://github.com/tesserix/kora/issues/22) — offline logging queue
**Milestone:** R1
**Refs:** `docs/OPEN_QUESTIONS.md` §3 Offline & Failure Behaviour

## Problem

Camera, voice and chat all need network and AI. People most want to log in
exactly the low-signal moments — a restaurant, a basement gym, a plane. Today
there is no offline path at all: a failed write is dropped, and in
`src/api/useInstantLog.ts` it is dropped *silently* (no `onError` handler).

## The finding that shapes this design

**There is no idempotency, and an offline queue is a replay machine.**

`LogRequest` (`api/internal/foodlog/service.go:29-38`) has no id field;
`FoodLog.ID` is `gorm:"default:gen_random_uuid();primaryKey"`
(`model.go:11`). There is no idempotency-key handling anywhere in `api/`, and
`food_logs` has no unique constraint beyond the PK. **A replayed POST creates a
duplicate row.**

This is not theoretical. During this session's simulator pass the device log
recorded a resolve returning **HTTP 200 in 3.3s while the app displayed an
error** — the request succeeded and the response was lost. Under a naive queue
that is precisely the shape that silently duplicates someone's dinner.

Duplication is worse than loss: a missing log is visible, a duplicated one
quietly inflates the day.

Two things already work in our favour and need no change:

- `logged_at` is client-supplied and honoured (`service.go:119-122`), so
  capture time survives a delayed upload
- `created_at` records upload time separately (`model.go:31`), so
  capture-vs-upload is already distinguishable

## Scope

**Slice 1 (this spec): offline writes.** Barcode, manual, and previously-seen
foods log fully offline; queued writes drain on reconnect.

**Slice 2 (separate spec): deferred AI resolution.** Photo/voice captures queue
locally and resolve when back online. Deferred deliberately — it adds local
media storage, a resolve-on-reconnect pipeline, and the capture-day-vs-
resolve-day conflict the issue itself flags as unresolved. Those decisions are
better made after slice 1 exists.

**Not achievable as literally written:** #22's criterion "barcode + manual
logging succeed" with network off cannot hold for a food the device has never
seen — barcode lookup calls Open Food Facts and manual search hits the
7,848-row server index. Offline covers what the device already knows; the UI
must say so plainly rather than failing opaquely.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Replay safety | Client generates the log id; server accepts it; PK conflict = already applied | The queue needs a stable local id anyway. Making it the server id means replay is idempotent with no extra table, column, or migration |
| Conflict response | Return the existing row with a success status | A lost response must be safely retryable; the client must not be able to distinguish first delivery from replay |
| Cross-user collision | Reject without revealing the id exists | Otherwise a client could probe for or collide with another user's log id |
| Slice boundary | Offline writes now, AI capture queue separately | Different sizes of job; the AI half depends on decisions slice 1 will teach us |
| Offline coverage | Cache what the user has actually used | A food vocabulary is small and repetitive: high hit rate, negligible storage, self-maintaining from normal use, no sync job |
| Queue mechanism | Purpose-built module + netinfo→`onlineManager` | #22 requires per-item pending/failed state with retry and discard; React Query's paused mutations do not expose that, and persisting them needs `setMutationDefaults` re-hydration |
| Pending rows in the day total | Pending counts; failed does not | A pending item is a real food with known nutrition whose upload is outstanding — excluding it makes remaining-calories wrong when it matters. A permanently-failed item is never landing, so counting it would overstate the day indefinitely |
| Editing a pending row | Not allowed | Editing something mid-flight invites a class of conflict that buys nothing |

## Server — `api/internal/foodlog`

1. `LogRequest` gains `ID *uuid.UUID \`json:"id"\``. When present, `LogFood`
   uses it instead of the column default.
2. On primary-key conflict, load the existing row. If its `user_id` matches the
   caller, return it with the normal create success status. If it does not,
   reject without disclosing that the id exists.
3. No migration: `food_logs.id` is already the PK with a default, so supplying
   a value simply skips the default.

`POST /v1/logs/batch` is **not** extended. It is all-or-nothing in one
transaction, carries one shared `logged_at`, hardcodes `Source: "memory"`, and
accepts no `client_log_ms` or `input_phrase` (`service.go:290-364`) — it cannot
represent a queue of independently-captured items. The queue replays per-item
`POST /v1/logs`, which `capture.tsx` already does today.

## Mobile — `apps/mobile/src/offline/`

### `queue.ts`

AsyncStorage-backed under a single key, following the
`src/reminders/customPrefs.ts` precedent (JSON blob, defensive parse).

```
{ id: uuid, payload: CreateLogInput, status: "pending" | "failed",
  attempts: number, lastError?: string, queuedAt: string }
```

`id` is both the queue key and the server log id — one identity end to end.

**Drain** runs on reconnect, on app foreground, and on cold start, processing
**sequentially** so the diary fills in the order things were eaten rather than
by race. Outcomes:

| result | action |
|---|---|
| success, or replay resolved as already-applied | drop from queue; invalidate `["logs"]` and `["dashboard"]` |
| `NetworkError` | leave `pending`; retry on the next drain |
| `ApiError` 4xx | mark `failed`, stop auto-retrying — user-actionable, not transient |
| `AuthTokenError` | leave `pending` — per #77 this usually means a dropped connection, not a dead session |

Exposes `append`, `list`, `retry(id)`, `discard(id)`, `drain()`.

### `foodCache.ts`

Whole `FoodItem` records the user has already encountered, keyed by id, with
`lastUsedAt` for LRU eviction and a cap of **300** entries (well under 100KB).

Populated as a by-product of normal use — on successful `useDayLogs`,
`usePins` and `useSavedMeals`, upsert the food items those responses already
carry. No new endpoints, no index versioning, no staleness problem.

Three lookups: **by id** (re-log, pin), **by barcode** (a repeat scan of a usual
product works offline), **by name substring** (manual search falls back to the
cache when offline).

### Connectivity

`@react-native-community/netinfo` (new dependency — neither it nor
`expo-network` is currently present) wired into React Query's `onlineManager`
in `app/_layout.tsx`, so existing queries also stop retrying pointlessly while
offline.

### Write path

`useCreateLog` mints the id and, when offline, enqueues instead of POSTing,
returning the id either way so callers are unchanged in shape.

## Diary integration

`useDayLogs` merges the queue's items for that day into its result.

- pending rows carry a **pending** chip via the existing `Badge` (`neutral`
  variant) and **count** toward the day total
- failed rows keep their kcal visible but greyed and **excluded** from the
  total; tapping opens a small sheet offering **Retry** and **Discard**
- `MealRow` (`src/components/MealRow.tsx:9-21`) needs a badge slot added — it
  currently renders an unconditional kcal `Numeral` with no trailing
  affordance

## Testing

**Queue module:** append; each drain outcome; ordering; survival across a
simulated restart.

**Cache:** LRU eviction at the cap; all three lookups; miss behaviour.

**Server — the two that carry the design:**
- a duplicate id returns the existing row and creates **no** second row
- a duplicate id owned by **another user** is rejected

**The lost-response test — the one that guards the actual risk:** simulate the
server applying a write while the client sees a failure, replay from the queue,
and assert exactly one row exists. This is the scenario observed live today,
and it is what turns "no data loss" into "no data loss *and* no duplication".

**#22's acceptance criteria, as explicit tests:** with network off, barcode +
manual + previously-seen logging succeed and appear in the diary; nothing is
lost across app restart while items are queued.

Every assertion must fail if the behaviour it names breaks. This codebase has
produced five assertions that passed while verifying nothing (see
`kora-vacuous-guard-trap`); mutation-check the load-bearing ones.

## Risks accepted

- **The app's first optimistic update.** `onMutate` appears nowhere today, so
  rendering a log before the server has it is new behaviour. The merge in
  `useDayLogs` is where the bugs will be.
- **Offline coverage is partial by construction.** A food the device has never
  seen still needs network. The cache makes the common case work; the UI must
  not imply more.
- **Small fix in the path:** `src/lib/apiErrorMessage.ts:36` branches on
  `error instanceof TypeError` for offline copy, but #77 wrapped those in
  `NetworkError` (which extends `Error`, not `TypeError`), so the branch no
  longer fires and callers fall through to the generic server message. Note
  this module is deliberately duck-typed to avoid importing `api.ts`, so the
  fix should test the error's shape rather than add that import.
