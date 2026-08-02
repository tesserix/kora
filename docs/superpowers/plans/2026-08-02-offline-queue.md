# Offline Logging Queue (slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user log barcode, manual and previously-seen foods with no network, queue the writes durably, and drain them safely on reconnect without ever duplicating a meal.

**Architecture:** The client mints each log's UUID up front and sends it as the server id, so replaying a write whose response was lost is idempotent. Writes made offline go into an AsyncStorage-backed queue that drains sequentially on reconnect, foreground and cold start. A small LRU cache of foods the user has already used makes offline lookup possible, and the diary merges queued rows optimistically.

**Tech Stack:** Go 1.26 + GORM + PostgreSQL; React Native / Expo Router, TanStack React Query v5, AsyncStorage, `@react-native-community/netinfo`, `expo-crypto`.

**Spec:** `docs/superpowers/specs/2026-08-02-offline-queue-design.md`

## Global Constraints

- **Never duplicate a log.** A replayed `POST /v1/logs` carrying an id that already exists must return the existing row as success, never insert a second.
- **Cross-user safety:** on id conflict, only return the existing row if its `user_id` matches the caller. A mismatch is rejected without revealing that the id exists.
- **Pending counts toward the day total; failed does not.**
- Slice 1 is **offline writes only**. Do not implement deferred AI resolution of photo/voice — that is a separate spec.
- Do **not** extend `POST /v1/logs/batch`. It is all-or-nothing, carries one shared `logged_at`, hardcodes `Source: "memory"`, and accepts no `client_log_ms`/`input_phrase` (`api/internal/foodlog/service.go:290-364`). The queue replays per-item `POST /v1/logs`.
- No database migration. `food_logs.id` is already the PK with a `gen_random_uuid()` default; supplying a value skips the default.
- Commit messages: conventional prefix, **single line, no body, no trailers**.
- **Run all tests in the FOREGROUND.** Backgrounded runs stall in this environment.
- Go tests need Postgres: `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'`
- Mobile: `npx tsc --noEmit` and `npx jest --ci --forceExit` must both stay green (currently 99 suites / 580 tests).
- Install Expo deps with `npx expo install <pkg>`, never plain `npm install`, so versions match the SDK.

## File Structure

| File | Responsibility |
|---|---|
| `api/internal/foodlog/service.go` (modify) | Accept an optional client id on `LogRequest` |
| `api/internal/foodlog/repository.go` (modify) | Insert-or-return-existing, ownership-checked |
| `apps/mobile/src/offline/queue.ts` (create) | Durable queue of pending log writes |
| `apps/mobile/src/offline/foodCache.ts` (create) | LRU cache of foods the user has used |
| `apps/mobile/src/offline/connectivity.ts` (create) | netinfo → `onlineManager`, plus `isOnline()` |
| `apps/mobile/src/offline/useQueuedLogs.ts` (create) | Exposes queue state to the diary |
| `apps/mobile/src/api/hooks.ts` (modify) | `useCreateLog` mints ids and enqueues when offline |
| `apps/mobile/src/components/MealRow.tsx` (modify) | Badge slot for pending/failed |

---

### Task 1: Server accepts a client-supplied log id

**Files:**
- Modify: `api/internal/foodlog/service.go` (the `LogRequest` struct ~line 29, and `LogFood` ~line 100)
- Modify: `api/internal/foodlog/repository.go` (the `Create` method ~line 31)
- Test: `api/internal/foodlog/repository_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `POST /v1/logs` accepts an optional `"id"` (UUID string). Replaying the same id returns the same row. `Repository.CreateIdempotent(ctx, log) (FoodLog, error)`.

Detection of the conflict uses GORM's `clause.OnConflict{DoNothing: true}` and checks `RowsAffected`. Do **not** enable `gorm.Config.TranslateError` (it changes error behaviour service-wide) and do not add `pgconn` as a direct dependency to sniff SQLSTATE 23505.

- [ ] **Step 1: Write the failing tests**

Append to `api/internal/foodlog/repository_test.go`:

```go
// TestCreateIdempotentReplayReturnsExistingRow is the core safety property of
// the offline queue: a write whose response was lost must be replayable
// without creating a second meal. Duplication is worse than loss — a missing
// log is visible, a duplicated one silently inflates the day.
func TestCreateIdempotentReplayReturnsExistingRow(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	repo := NewRepository(tx)

	userID := uuid.New()
	id := uuid.New()
	log := FoodLog{ID: id, UserID: userID, LoggedAt: time.Now(), MealSlot: "lunch",
		Source: "manual", Description: "Test food", QuantityGrams: 100, Kcal: 200}

	first, err := repo.CreateIdempotent(context.Background(), log)
	require.NoError(t, err)
	require.Equal(t, id, first.ID)

	// Replay the identical write — as a queue drain would after a lost response.
	second, err := repo.CreateIdempotent(context.Background(), log)
	require.NoError(t, err)
	require.Equal(t, id, second.ID)

	var count int64
	require.NoError(t, tx.Model(&FoodLog{}).Where("id = ?", id).Count(&count).Error)
	require.Equal(t, int64(1), count, "replay must not create a second row")
}

// TestCreateIdempotentRejectsAnotherUsersID stops a client probing for, or
// colliding with, an id that belongs to somebody else. The error must not
// confirm that the id exists.
func TestCreateIdempotentRejectsAnotherUsersID(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	repo := NewRepository(tx)

	id := uuid.New()
	owner := FoodLog{ID: id, UserID: uuid.New(), LoggedAt: time.Now(), MealSlot: "lunch",
		Source: "manual", Description: "Owner food", QuantityGrams: 100, Kcal: 200}
	_, err := repo.CreateIdempotent(context.Background(), owner)
	require.NoError(t, err)

	intruder := owner
	intruder.UserID = uuid.New()
	intruder.Description = "Intruder food"
	_, err = repo.CreateIdempotent(context.Background(), intruder)
	require.Error(t, err)
	require.NotContains(t, err.Error(), id.String(), "must not disclose the id")

	var got FoodLog
	require.NoError(t, tx.First(&got, "id = ?", id).Error)
	require.Equal(t, "Owner food", got.Description, "the owner's row must be untouched")
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/foodlog/ -run 'CreateIdempotent' -v`

Expected: FAIL to compile — `repo.CreateIdempotent undefined`.

- [ ] **Step 3: Add the repository method**

In `api/internal/foodlog/repository.go`, add `"gorm.io/gorm/clause"` to the imports and add:

```go
// CreateIdempotent inserts log, or returns the already-stored row when its ID
// is taken. The offline queue replays writes whose response was lost, so a
// replay MUST be indistinguishable from a first delivery — otherwise a flaky
// reconnect duplicates the user's meal.
//
// ON CONFLICT DO NOTHING is used rather than catching a duplicate-key error:
// gorm.Config here has no TranslateError, so gorm.ErrDuplicatedKey is never
// returned, and sniffing SQLSTATE 23505 would make pgconn a direct dependency
// for one branch. RowsAffected == 0 means the row already existed.
func (r Repository) CreateIdempotent(ctx context.Context, log FoodLog) (FoodLog, error) {
	created := log
	res := r.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&created)
	if res.Error != nil {
		return FoodLog{}, fmt.Errorf("foodlog: create idempotent: %w", res.Error)
	}
	if res.RowsAffected > 0 {
		return created, nil
	}

	var existing FoodLog
	if err := r.db.WithContext(ctx).First(&existing, "id = ?", log.ID).Error; err != nil {
		return FoodLog{}, fmt.Errorf("foodlog: load existing: %w", err)
	}
	if existing.UserID != log.UserID {
		// Deliberately does not name the id: the caller must not learn that
		// somebody else's log has this id.
		return FoodLog{}, httpx.ValidationError{Message: "invalid id"}
	}
	return existing, nil
}
```

- [ ] **Step 4: Accept the id in the request**

In `api/internal/foodlog/service.go`, add to `LogRequest`:

```go
	// ID lets the client mint the log's identity before it has network, so a
	// queued write replayed after a lost response is idempotent. Optional:
	// when nil the column default generates one as before.
	ID *uuid.UUID `json:"id"`
```

In `LogFood`, leave the whole `log := FoodLog{...}` literal exactly as it is. Set the id **after** construction, then switch to the idempotent create. Replace the single final line:

```go
	return s.logs.Create(ctx, log)
```

with:

```go
	// Assigned after construction, not inside the literal: FoodLog.ID is a
	// value type, so writing uuid.Nil into it when the client sent no id
	// would defeat the column's gen_random_uuid() default.
	if req.ID != nil {
		log.ID = *req.ID
	}
	return s.logs.CreateIdempotent(ctx, log)
```

Confirm `github.com/google/uuid` is already imported in `service.go` (it is — `LogRequest.FoodItemID` is a `*uuid.UUID`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/foodlog/ -v`

Expected: PASS, including every pre-existing test.

- [ ] **Step 6: Verify the guard bites**

Temporarily change `CreateIdempotent` to call plain `Create` instead of the `OnConflict` clause. Re-run `-run 'CreateIdempotent'`.

Expected: **FAIL** on `TestCreateIdempotentReplayReturnsExistingRow`, on the `replay must not create a second row` assertion or on a duplicate-key error from the second insert. If it fails anywhere else, the test is not guarding what it claims. Restore afterwards and confirm `git diff` is clean of the mutation.

- [ ] **Step 7: Commit**

```bash
git add api/internal/foodlog/repository.go api/internal/foodlog/service.go api/internal/foodlog/repository_test.go
git commit -m "feat(api): accept a client-supplied log id so replays are idempotent"
```

---

### Task 2: The durable queue

**Files:**
- Create: `apps/mobile/src/offline/queue.ts`
- Test: `apps/mobile/src/offline/__tests__/queue.test.ts`

**Interfaces:**
- Consumes: nothing (pure module — the drain function is injected, so this task needs no API layer).
- Produces:
  - `type QueuedLog = { id: string; payload: CreateLogInput; status: "pending" | "failed"; attempts: number; lastError?: string; queuedAt: string }`
  - `append(payload: CreateLogInput, id: string): Promise<QueuedLog>`
  - `list(): Promise<QueuedLog[]>`
  - `retry(id: string): Promise<void>` — flips `failed` back to `pending`
  - `discard(id: string): Promise<void>`
  - `drain(send: (item: QueuedLog) => Promise<void>): Promise<{ sent: number; failed: number; deferred: number }>`

`drain` takes its sender as a parameter so the queue has no dependency on the API layer and is testable without mocking `fetch`.

- [ ] **Step 1: Install expo-crypto**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/apps/mobile && npx expo install expo-crypto`

This provides `Crypto.randomUUID()`. There is no UUID library in the project today and `uuid` would additionally need the `react-native-get-random-values` polyfill.

- [ ] **Step 2: Write the failing tests**

Create `apps/mobile/src/offline/__tests__/queue.test.ts`:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { append, list, retry, discard, drain, type QueuedLog } from "../queue";

const payload = {
  food_item_id: "f1", meal_slot: "lunch", source: "manual",
  quantity_grams: 100, logged_at: "2026-08-02T12:00:00.000Z",
};

beforeEach(async () => { await AsyncStorage.clear(); });

test("append persists an item as pending and list reads it back", async () => {
  await append(payload, "id-1");
  const items = await list();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: "id-1", status: "pending", attempts: 0 });
});

test("the queue survives a restart", async () => {
  await append(payload, "id-1");
  // A fresh read with no in-memory state is exactly what a cold start does.
  const items = await list();
  expect(items.map((i) => i.id)).toEqual(["id-1"]);
});

test("drain sends items oldest-first and removes those that succeed", async () => {
  await append(payload, "id-1");
  await append(payload, "id-2");
  const sent: string[] = [];
  const result = await drain(async (item) => { sent.push(item.id); });
  expect(sent).toEqual(["id-1", "id-2"]);
  expect(result.sent).toBe(2);
  expect(await list()).toHaveLength(0);
});

test("a permanent failure marks the item failed and stops auto-retrying", async () => {
  await append(payload, "id-1");
  const err = Object.assign(new Error("bad request"), { name: "ApiError", status: 400 });
  const first = await drain(async () => { throw err; });
  expect(first.failed).toBe(1);

  const items = await list();
  expect(items[0].status).toBe("failed");
  expect(items[0].lastError).toContain("bad request");

  // A failed item must not be picked up again by a later drain.
  let called = false;
  await drain(async () => { called = true; });
  expect(called).toBe(false);
});

test("a transient failure leaves the item pending for the next drain", async () => {
  await append(payload, "id-1");
  const err = Object.assign(new Error("offline"), { name: "NetworkError" });
  const result = await drain(async () => { throw err; });
  expect(result.deferred).toBe(1);

  const items = await list();
  expect(items[0].status).toBe("pending");
  expect(items[0].attempts).toBe(1);
});

// AuthTokenError must be treated as transient, not permanent. Per PR #77 it
// wraps getIdToken() rejecting, whose usual cause is a dropped connection
// rather than an unusable session — marking it failed would strand a
// perfectly good log behind a manual retry the user never asked for.
test("an auth-token failure is transient, not permanent", async () => {
  await append(payload, "id-1");
  const err = Object.assign(new Error("token unavailable"), { name: "AuthTokenError" });
  const result = await drain(async () => { throw err; });

  expect(result.deferred).toBe(1);
  expect(result.failed).toBe(0);
  expect((await list())[0].status).toBe("pending");
});

test("retry flips a failed item back to pending; discard removes it", async () => {
  await append(payload, "id-1");
  await append(payload, "id-2");
  const err = Object.assign(new Error("bad"), { name: "ApiError", status: 400 });
  await drain(async () => { throw err; });

  await retry("id-1");
  expect((await list()).find((i) => i.id === "id-1")!.status).toBe("pending");

  await discard("id-2");
  expect((await list()).map((i) => i.id)).toEqual(["id-1"]);
});

test("a corrupt stored value yields an empty queue instead of throwing", async () => {
  await AsyncStorage.setItem("kora.logQueue", "{not json");
  await expect(list()).resolves.toEqual([]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/apps/mobile && npx jest --ci --forceExit src/offline/__tests__/queue.test.ts`

Expected: FAIL — cannot resolve `../queue`.

- [ ] **Step 4: Write the implementation**

Create `apps/mobile/src/offline/queue.ts`:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { CreateLogInput } from "@/api/hooks";

const STORAGE_KEY = "kora.logQueue";

export type QueuedLog = {
  id: string;
  payload: CreateLogInput;
  status: "pending" | "failed";
  attempts: number;
  lastError?: string;
  queuedAt: string;
};

function isValid(v: unknown): v is QueuedLog {
  const q = v as QueuedLog;
  return (
    !!q && typeof q.id === "string" && typeof q.queuedAt === "string" &&
    (q.status === "pending" || q.status === "failed") &&
    typeof q.attempts === "number" && !!q.payload
  );
}

// list never throws: a corrupt or missing value yields an empty queue and any
// malformed entry is dropped, so one bad record can never wedge the drain.
// Mirrors loadCustom in src/reminders/customPrefs.ts.
export async function list(): Promise<QueuedLog[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValid);
  } catch {
    return [];
  }
}

async function save(items: QueuedLog[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

export async function append(payload: CreateLogInput, id: string): Promise<QueuedLog> {
  const item: QueuedLog = {
    id, payload, status: "pending", attempts: 0, queuedAt: new Date().toISOString(),
  };
  await save([...(await list()), item]);
  return item;
}

export async function retry(id: string): Promise<void> {
  const items = await list();
  await save(items.map((i) => (i.id === id ? { ...i, status: "pending", lastError: undefined } : i)));
}

export async function discard(id: string): Promise<void> {
  await save((await list()).filter((i) => i.id !== id));
}

// A 4xx will fail identically forever — replaying it just burns battery and
// keeps a row the user cannot resolve. Anything else (no network, a dropped
// token, a 5xx) is worth another attempt on the next drain.
function isPermanent(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

// drain sends pending items OLDEST FIRST and sequentially, so the diary fills
// in the order the food was eaten rather than by whichever request wins a
// race. `send` is injected so this module never imports the API layer.
export async function drain(
  send: (item: QueuedLog) => Promise<void>,
): Promise<{ sent: number; failed: number; deferred: number }> {
  let sent = 0, failed = 0, deferred = 0;

  for (const item of await list()) {
    if (item.status !== "pending") continue;
    try {
      await send(item);
      await discard(item.id);
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const permanent = isPermanent(err);
      permanent ? failed++ : deferred++;
      const items = await list();
      await save(items.map((i) => (i.id === item.id
        ? { ...i, attempts: i.attempts + 1, lastError: message, status: permanent ? "failed" : "pending" }
        : i)));
    }
  }
  return { sent, failed, deferred };
}
```

Export `CreateLogInput` from `apps/mobile/src/api/hooks.ts` by changing `type CreateLogInput = {` to `export type CreateLogInput = {`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/apps/mobile && npx jest --ci --forceExit src/offline/__tests__/queue.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 6: Verify the ordering guard bites**

Temporarily change the `for` loop to iterate `(await list()).reverse()`. Re-run.

Expected: **FAIL** on `drain sends items oldest-first`, with `sent` equal to `["id-2","id-1"]`. Restore and re-run to green.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/offline/queue.ts apps/mobile/src/offline/__tests__/queue.test.ts apps/mobile/src/api/hooks.ts apps/mobile/package.json apps/mobile/package-lock.json
git commit -m "feat(mobile): add a durable queue for offline log writes"
```

---

### Task 3: Connectivity

**Files:**
- Create: `apps/mobile/src/offline/connectivity.ts`
- Modify: `apps/mobile/app/_layout.tsx` (call the installer alongside the existing `QueryClientProvider` at line 21)
- Test: `apps/mobile/src/offline/__tests__/connectivity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `installConnectivity(): () => void` (returns an unsubscribe), `isOnline(): boolean`.

- [ ] **Step 1: Install netinfo**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/apps/mobile && npx expo install @react-native-community/netinfo`

- [ ] **Step 2: Write the failing test**

Create `apps/mobile/src/offline/__tests__/connectivity.test.ts`:

```ts
import NetInfo from "@react-native-community/netinfo";
import { onlineManager } from "@tanstack/react-query";
import { installConnectivity, isOnline } from "../connectivity";

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => jest.fn()) },
}));

test("installConnectivity mirrors netinfo state into react-query's onlineManager", () => {
  const unsubscribe = installConnectivity();
  const handler = (NetInfo.addEventListener as jest.Mock).mock.calls[0][0];

  handler({ isConnected: false, isInternetReachable: false });
  expect(onlineManager.isOnline()).toBe(false);
  expect(isOnline()).toBe(false);

  handler({ isConnected: true, isInternetReachable: true });
  expect(onlineManager.isOnline()).toBe(true);
  expect(isOnline()).toBe(true);

  unsubscribe();
});

test("a connected interface with unknown reachability counts as online", () => {
  installConnectivity();
  const handler = (NetInfo.addEventListener as jest.Mock).mock.calls.at(-1)![0];
  // isInternetReachable is null while netinfo is still probing. Treating that
  // as offline would wrongly queue writes that would have succeeded.
  handler({ isConnected: true, isInternetReachable: null });
  expect(isOnline()).toBe(true);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/apps/mobile && npx jest --ci --forceExit src/offline/__tests__/connectivity.test.ts`

Expected: FAIL — cannot resolve `../connectivity`.

- [ ] **Step 4: Write the implementation**

Create `apps/mobile/src/offline/connectivity.ts`:

```ts
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { onlineManager } from "@tanstack/react-query";

// Mirrors device connectivity into react-query's onlineManager so existing
// queries stop retrying pointlessly while offline, and exposes the same state
// synchronously for the write path to decide POST-vs-enqueue.
export function installConnectivity(): () => void {
  return NetInfo.addEventListener((state: NetInfoState) => {
    onlineManager.setOnline(reachable(state));
  });
}

// isInternetReachable is null while netinfo is still probing. Treat that as
// online: a false negative queues a write that would have succeeded, which
// costs the user a pending row for no reason.
function reachable(state: NetInfoState): boolean {
  return !!state.isConnected && state.isInternetReachable !== false;
}

export function isOnline(): boolean {
  return onlineManager.isOnline();
}
```

In `apps/mobile/app/_layout.tsx`, import `useEffect` from `react` if it is not already imported, import `installConnectivity` from `@/offline/connectivity`, and inside the root component add:

```tsx
  useEffect(() => installConnectivity(), []);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/apps/mobile && npx jest --ci --forceExit src/offline/__tests__/connectivity.test.ts && npx tsc --noEmit`

Expected: PASS, 2 tests; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/offline/connectivity.ts apps/mobile/src/offline/__tests__/connectivity.test.ts apps/mobile/app/_layout.tsx apps/mobile/package.json apps/mobile/package-lock.json
git commit -m "feat(mobile): mirror device connectivity into react-query"
```

---

### Task 4: Write path — enqueue when offline, drain when back

**Files:**
- Modify: `apps/mobile/src/api/hooks.ts` (`useCreateLog`, lines 82-92)
- Create: `apps/mobile/src/offline/drainLogs.ts`
- Test: `apps/mobile/src/offline/__tests__/drainLogs.test.ts`

**Interfaces:**
- Consumes: `append`, `drain`, `QueuedLog` (Task 2); `isOnline` (Task 3).
- Produces: `drainLogs(queryClient: QueryClient): Promise<void>`; `useCreateLog` now returns `Promise<FoodLog | QueuedLog>` and always attaches an `id`.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/offline/__tests__/drainLogs.test.ts`:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient } from "@tanstack/react-query";
import { append, list } from "../queue";
import { drainLogs } from "../drainLogs";
import { apiFetch } from "@/lib/api";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  ApiError: class ApiError extends Error {},
}));

const payload = {
  food_item_id: "f1", meal_slot: "lunch", source: "manual",
  quantity_grams: 100, logged_at: "2026-08-02T12:00:00.000Z",
};

beforeEach(async () => { await AsyncStorage.clear(); jest.clearAllMocks(); });

test("drainLogs POSTs each queued item with its id and clears the queue", async () => {
  (apiFetch as jest.Mock).mockResolvedValue({ id: "id-1" });
  await append(payload, "id-1");

  await drainLogs(new QueryClient());

  expect(apiFetch).toHaveBeenCalledWith("/v1/logs", expect.objectContaining({ method: "POST" }));
  const body = JSON.parse((apiFetch as jest.Mock).mock.calls[0][1].body);
  expect(body.id).toBe("id-1");
  expect(await list()).toHaveLength(0);
});

// The property the whole design turns on: the server applied the write but the
// response was lost, so the item is still queued. Replaying must converge on
// one row, and the client must treat the replay as success.
test("a replay after a lost response clears the queue rather than duplicating", async () => {
  (apiFetch as jest.Mock)
    .mockRejectedValueOnce(Object.assign(new Error("offline"), { name: "NetworkError" }))
    .mockResolvedValueOnce({ id: "id-1" });

  await append(payload, "id-1");

  await drainLogs(new QueryClient());
  expect(await list()).toHaveLength(1); // deferred, still pending

  await drainLogs(new QueryClient());
  expect(await list()).toHaveLength(0);

  const bodies = (apiFetch as jest.Mock).mock.calls.map((c) => JSON.parse(c[1].body));
  expect(bodies.every((b) => b.id === "id-1")).toBe(true);
});

test("drainLogs invalidates logs and dashboard after sending", async () => {
  (apiFetch as jest.Mock).mockResolvedValue({ id: "id-1" });
  await append(payload, "id-1");

  const qc = new QueryClient();
  const spy = jest.spyOn(qc, "invalidateQueries");
  await drainLogs(qc);

  expect(spy).toHaveBeenCalledWith({ queryKey: ["logs"] });
  expect(spy).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
});

test("drainLogs does not invalidate when nothing was sent", async () => {
  const qc = new QueryClient();
  const spy = jest.spyOn(qc, "invalidateQueries");
  await drainLogs(qc);
  expect(spy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/apps/mobile && npx jest --ci --forceExit src/offline/__tests__/drainLogs.test.ts`

Expected: FAIL — cannot resolve `../drainLogs`.

- [ ] **Step 3: Write drainLogs**

Create `apps/mobile/src/offline/drainLogs.ts`:

```ts
import type { QueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { drain } from "./queue";

// Sends every pending queued log, then refreshes the views that show them.
// The id travels in the body so a replay of a write whose response was lost
// resolves to the same server row instead of a duplicate.
export async function drainLogs(queryClient: QueryClient): Promise<void> {
  const result = await drain(async (item) => {
    await apiFetch("/v1/logs", {
      method: "POST",
      body: JSON.stringify({ ...item.payload, id: item.id }),
    });
  });

  if (result.sent > 0) {
    queryClient.invalidateQueries({ queryKey: ["logs"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }
}
```

- [ ] **Step 4: Wire the write path**

In `apps/mobile/src/api/hooks.ts`, replace `useCreateLog` (lines 82-92) with:

```ts
export function useCreateLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateLogInput) => {
      // The id is minted client-side for EVERY log, online or not, so the
      // server row and any queued copy share one identity and a replay is
      // idempotent (see api/internal/foodlog CreateIdempotent).
      const id = Crypto.randomUUID();
      if (!isOnline()) return append(input, id);
      return apiFetch("/v1/logs", {
        method: "POST",
        body: JSON.stringify({ ...input, id }),
      }) as Promise<FoodLog>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
```

Add at the top of the file: `import * as Crypto from "expo-crypto";`, `import { append } from "@/offline/queue";`, `import { isOnline } from "@/offline/connectivity";`.

- [ ] **Step 5: Trigger drains**

In `apps/mobile/app/_layout.tsx`, alongside the `installConnectivity` effect from Task 3, add:

```tsx
  useEffect(() => {
    // Cold start.
    drainLogs(queryClient);
    // Reconnect.
    const unsubscribe = onlineManager.subscribe((online) => {
      if (online) drainLogs(queryClient);
    });
    // Return to foreground — a drain may have been interrupted by a swipe-away.
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") drainLogs(queryClient);
    });
    return () => { unsubscribe(); sub.remove(); };
  }, []);
```

Import `AppState` from `react-native`, `onlineManager` from `@tanstack/react-query`, `drainLogs` from `@/offline/drainLogs`, and `queryClient` from `@/lib/queryClient`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/apps/mobile && npx jest --ci --forceExit && npx tsc --noEmit`

Expected: PASS, full suite green; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/offline/drainLogs.ts apps/mobile/src/offline/__tests__/drainLogs.test.ts apps/mobile/src/api/hooks.ts apps/mobile/app/_layout.tsx
git commit -m "feat(mobile): queue log writes when offline and drain them on reconnect"
```

---

### Task 5: Offline food cache

**Files:**
- Create: `apps/mobile/src/offline/foodCache.ts`
- Modify: `apps/mobile/src/api/hooks.ts` (`useDayLogs`, `usePins`, `useSavedMeals` — add cache population)
- Test: `apps/mobile/src/offline/__tests__/foodCache.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `upsertFoods(items: FoodItem[]): Promise<void>`, `getFoodById(id: string): Promise<FoodItem | null>`, `getFoodByBarcode(barcode: string): Promise<FoodItem | null>`, `searchCachedFoods(q: string): Promise<FoodItem[]>`, and the exported constant `FOOD_CACHE_LIMIT = 300`.

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/offline/__tests__/foodCache.test.ts`:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { upsertFoods, getFoodById, getFoodByBarcode, searchCachedFoods, FOOD_CACHE_LIMIT } from "../foodCache";
import type { FoodItem } from "@/api/types";

function food(id: string, name: string, barcode?: string): FoodItem {
  return {
    id, name, brand: "", provenance: "usda", serving_desc: "100 g", serving_grams: 100,
    kcal_per_100g: 100, protein_per_100g: 1, carbs_per_100g: 1, fat_per_100g: 1,
    ...(barcode ? { barcode } : {}),
  } as FoodItem;
}

beforeEach(async () => { await AsyncStorage.clear(); });

test("upsert then look up by id", async () => {
  await upsertFoods([food("f1", "Greek yogurt")]);
  expect((await getFoodById("f1"))?.name).toBe("Greek yogurt");
  expect(await getFoodById("nope")).toBeNull();
});

test("look up by barcode — a repeat scan works offline", async () => {
  await upsertFoods([food("f1", "Greek yogurt", "12345")]);
  expect((await getFoodByBarcode("12345"))?.id).toBe("f1");
  expect(await getFoodByBarcode("99999")).toBeNull();
});

test("search matches on a name substring, case-insensitively", async () => {
  await upsertFoods([food("f1", "Greek yogurt"), food("f2", "Cheddar cheese")]);
  expect((await searchCachedFoods("yog")).map((f) => f.id)).toEqual(["f1"]);
  expect((await searchCachedFoods("CHEESE")).map((f) => f.id)).toEqual(["f2"]);
  expect(await searchCachedFoods("sushi")).toEqual([]);
});

test("upserting the same id updates rather than duplicating", async () => {
  await upsertFoods([food("f1", "Old name")]);
  await upsertFoods([food("f1", "New name")]);
  expect((await getFoodById("f1"))?.name).toBe("New name");
  expect(await searchCachedFoods("name")).toHaveLength(1);
});

test("the cache evicts least-recently-used entries at the cap", async () => {
  const many = Array.from({ length: FOOD_CACHE_LIMIT + 10 }, (_, i) => food(`f${i}`, `Food ${i}`));
  await upsertFoods(many);
  // The 10 oldest are gone, the newest survive, and the cap holds.
  expect(await getFoodById("f0")).toBeNull();
  expect(await getFoodById(`f${FOOD_CACHE_LIMIT + 9}`)).not.toBeNull();
  expect(await searchCachedFoods("Food")).toHaveLength(FOOD_CACHE_LIMIT);
});

test("a corrupt stored value yields an empty cache instead of throwing", async () => {
  await AsyncStorage.setItem("kora.foodCache", "{not json");
  await expect(getFoodById("f1")).resolves.toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/apps/mobile && npx jest --ci --forceExit src/offline/__tests__/foodCache.test.ts`

Expected: FAIL — cannot resolve `../foodCache`.

- [ ] **Step 3: Add the missing `barcode` field to the TypeScript type**

`FoodItem` in `apps/mobile/src/api/types.ts:15-26` has no `barcode`, even though the server sends one (`api/internal/foodlog/../nutrition/model.go:44` — `Barcode *string \`json:"barcode,omitempty"\``). Without this, `getFoodByBarcode` will not compile. Add to the type:

```ts
  /** Present on barcode-sourced foods; enables an offline repeat scan. */
  barcode?: string;
```

- [ ] **Step 4: Write the implementation**

Create `apps/mobile/src/offline/foodCache.ts`:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { FoodItem } from "@/api/types";

const STORAGE_KEY = "kora.foodCache";

// A person's food vocabulary is small and highly repetitive, so a few hundred
// entries covers the overwhelming majority of repeat logging at trivial cost
// (~100KB). This is deliberately NOT a mirror of the 7,848-row server index:
// a food the device has never seen still needs network, and the UI says so.
export const FOOD_CACHE_LIMIT = 300;

type Entry = { item: FoodItem; lastUsedAt: number };

async function load(): Promise<Entry[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && e.item && typeof e.item.id === "string");
  } catch {
    return [];
  }
}

// upsertFoods is called from query onSuccess handlers, so it is a by-product
// of normal use — no sync job, no index versioning, nothing to go stale.
export async function upsertFoods(items: FoodItem[]): Promise<void> {
  if (items.length === 0) return;
  const byId = new Map((await load()).map((e) => [e.item.id, e]));
  const now = Date.now();
  items.forEach((item, i) => byId.set(item.id, { item, lastUsedAt: now + i }));

  const trimmed = [...byId.values()]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, FOOD_CACHE_LIMIT);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
}

export async function getFoodById(id: string): Promise<FoodItem | null> {
  return (await load()).find((e) => e.item.id === id)?.item ?? null;
}

export async function getFoodByBarcode(barcode: string): Promise<FoodItem | null> {
  return (await load()).find((e) => e.item.barcode === barcode)?.item ?? null;
}

export async function searchCachedFoods(q: string): Promise<FoodItem[]> {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return (await load())
    .filter((e) => e.item.name.toLowerCase().includes(needle))
    .map((e) => e.item);
}
```

- [ ] **Step 5: Populate the cache from existing queries**

In `apps/mobile/src/api/hooks.ts`, import `upsertFoods` from `@/offline/foodCache`, and in `useDayLogs` add a `select` that harvests food items as they arrive. `FoodLog` carries no nested item, so populate from the endpoints that do return `FoodItem`s — `usePins` and `useSavedMeals`. For each, add to the `useQuery` options:

```ts
    select: (data) => {
      void upsertFoods(extractFoods(data));
      return data;
    },
```

and define once near the top of the file:

```ts
// Harvests FoodItems out of a response so the offline cache fills from normal
// use. Deliberately tolerant: shapes differ per endpoint and a miss here must
// never break the query it is piggybacking on.
function extractFoods(data: unknown): FoodItem[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((d) => (d as { item?: FoodItem }).item ?? (d as FoodItem))
    .filter((f): f is FoodItem => !!f && typeof (f as FoodItem).id === "string" && typeof (f as FoodItem).name === "string");
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/apps/mobile && npx jest --ci --forceExit && npx tsc --noEmit`

Expected: PASS, full suite; tsc clean.

- [ ] **Step 7: Verify the eviction guard bites**

Temporarily remove the `.slice(0, FOOD_CACHE_LIMIT)`. Re-run the foodCache tests.

Expected: **FAIL** on `the cache evicts least-recently-used entries at the cap`, reporting 310 entries rather than 300. Restore and re-run to green.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/offline/foodCache.ts apps/mobile/src/offline/__tests__/foodCache.test.ts apps/mobile/src/api/hooks.ts apps/mobile/src/api/types.ts
git commit -m "feat(mobile): cache foods the user has used for offline lookup"
```

---

### Task 6: Diary shows pending and failed rows

**Files:**
- Create: `apps/mobile/src/offline/useQueuedLogs.ts`
- Modify: `apps/mobile/src/components/MealRow.tsx` (props at lines 9-21; the `Numeral` at line 36)
- Modify: `apps/mobile/app/(tabs)/diary.tsx` (the group render at lines 296-320)
- Test: `apps/mobile/src/offline/__tests__/useQueuedLogs.test.ts`

**Interfaces:**
- Consumes: `list`, `retry`, `discard`, `QueuedLog` (Task 2); `getFoodById` (Task 5).
- Produces: `useQueuedLogs(date: string)` returning `{ rows: QueuedRow[]; retryRow: (id) => Promise<void>; discardRow: (id) => Promise<void> }` where `QueuedRow = { id: string; description: string; kcal: number; mealSlot: string; status: "pending" | "failed" }`.

`MealRow` gains two optional props: `badge?: ReactNode` and `dimmed?: boolean`.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/offline/__tests__/useQueuedLogs.test.ts`:

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { renderHook, waitFor, act } from "@testing-library/react-native";
import { append } from "../queue";
import { upsertFoods } from "../foodCache";
import { useQueuedLogs } from "../useQueuedLogs";
import type { FoodItem } from "@/api/types";

const item = {
  id: "f1", name: "Greek yogurt", brand: "", provenance: "usda", serving_desc: "100 g",
  serving_grams: 100, kcal_per_100g: 100, protein_per_100g: 1, carbs_per_100g: 1, fat_per_100g: 1,
} as FoodItem;

const payloadOn = (iso: string) => ({
  food_item_id: "f1", meal_slot: "lunch", source: "manual",
  quantity_grams: 200, logged_at: iso,
});

beforeEach(async () => { await AsyncStorage.clear(); await upsertFoods([item]); });

test("returns queued rows for the requested day, with kcal from the cached food", async () => {
  await append(payloadOn("2026-08-02T12:00:00.000Z"), "q1");
  const { result } = renderHook(() => useQueuedLogs("2026-08-02"));

  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  expect(result.current.rows[0]).toMatchObject({
    id: "q1", description: "Greek yogurt", status: "pending", mealSlot: "lunch",
  });
  // 200 g of a 100 kcal/100 g food.
  expect(result.current.rows[0].kcal).toBe(200);
});

test("excludes queued rows belonging to another day", async () => {
  await append(payloadOn("2026-08-01T12:00:00.000Z"), "q1");
  const { result } = renderHook(() => useQueuedLogs("2026-08-02"));
  await waitFor(() => expect(result.current.rows).toEqual([]));
});

test("discardRow removes the row", async () => {
  await append(payloadOn("2026-08-02T12:00:00.000Z"), "q1");
  const { result } = renderHook(() => useQueuedLogs("2026-08-02"));
  await waitFor(() => expect(result.current.rows).toHaveLength(1));

  await act(async () => { await result.current.discardRow("q1"); });
  await waitFor(() => expect(result.current.rows).toHaveLength(0));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/apps/mobile && npx jest --ci --forceExit src/offline/__tests__/useQueuedLogs.test.ts`

Expected: FAIL — cannot resolve `../useQueuedLogs`.

- [ ] **Step 3: Write the hook**

Create `apps/mobile/src/offline/useQueuedLogs.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import { list, retry, discard, type QueuedLog } from "./queue";
import { getFoodById } from "./foodCache";

export type QueuedRow = {
  id: string;
  description: string;
  kcal: number;
  mealSlot: string;
  status: "pending" | "failed";
};

async function toRow(q: QueuedLog): Promise<QueuedRow> {
  const food = await getFoodById(q.payload.food_item_id);
  return {
    id: q.id,
    // A cached food is the normal case — it is how the item got logged
    // offline at all. The fallback only shows if the cache was evicted
    // between queueing and draining.
    description: food?.name ?? "Queued item",
    kcal: food ? (food.kcal_per_100g * q.payload.quantity_grams) / 100 : 0,
    mealSlot: q.payload.meal_slot,
    status: q.status,
  };
}

// Surfaces queued writes for `date` so the diary can show them before the
// server has them. This is the app's first optimistic rendering path.
export function useQueuedLogs(date: string) {
  const [rows, setRows] = useState<QueuedRow[]>([]);

  const refresh = useCallback(async () => {
    const items = await list();
    const forDay = items.filter((q) => q.payload.logged_at.slice(0, 10) === date);
    setRows(await Promise.all(forDay.map(toRow)));
  }, [date]);

  useEffect(() => { void refresh(); }, [refresh]);

  const retryRow = useCallback(async (id: string) => { await retry(id); await refresh(); }, [refresh]);
  const discardRow = useCallback(async (id: string) => { await discard(id); await refresh(); }, [refresh]);

  return { rows, retryRow, discardRow };
}
```

- [ ] **Step 4: Add the badge slot to MealRow**

In `apps/mobile/src/components/MealRow.tsx`, add `badge?: ReactNode;` and `dimmed?: boolean;` to `Props`, add them to the destructured parameters, import `type ReactNode` from `react`, and replace the `Numeral` line:

```tsx
      <Numeral size={17}>{`${Math.round(kcal)} kcal`}</Numeral>
```

with:

```tsx
      {badge}
      <View style={{ opacity: dimmed ? 0.5 : 1 }}>
        <Numeral size={17}>{`${Math.round(kcal)} kcal`}</Numeral>
      </View>
```

- [ ] **Step 5: Render queued rows in the diary**

In `apps/mobile/app/(tabs)/diary.tsx`, call `useQueuedLogs(date)` alongside `useDayLogs(date)`, and render the queued rows for each slot above that slot's server rows:

```tsx
{queued.rows.filter((r) => r.mealSlot.toLowerCase() === group.slot.toLowerCase()).map((r) => (
  <MealRow
    key={r.id}
    name={r.description}
    slot={r.status === "failed" ? "Couldn't sync" : "Waiting to sync"}
    kcal={r.kcal}
    dimmed={r.status === "failed"}
    badge={<Badge variant="neutral">{r.status === "failed" ? "Failed" : "Pending"}</Badge>}
    accessibilityLabel={`${r.description}, ${r.status === "failed" ? "failed to sync" : "waiting to sync"}`}
    onPress={r.status === "failed" ? () => setFailedRowId(r.id) : undefined}
  />
))}
```

Import `Badge` from `@/components/Badge`, add `const [failedRowId, setFailedRowId] = useState<string | null>(null)`, and render a sheet when `failedRowId` is set offering **Retry** (`queued.retryRow`) and **Discard** (`queued.discardRow`), following the existing sheet usage in this file.

Add pending kcal to the day total where the diary sums server logs — **pending only**:

```tsx
const queuedKcal = queued.rows
  .filter((r) => r.status === "pending")
  .reduce((sum, r) => sum + r.kcal, 0);
```

A pending item is a real food with known nutrition whose upload is merely outstanding, so excluding it would make remaining-calories wrong exactly when the user is relying on it. A failed item is never landing, so counting it would overstate the day indefinitely.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/apps/mobile && npx jest --ci --forceExit && npx tsc --noEmit`

Expected: PASS, full suite; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/offline/useQueuedLogs.ts apps/mobile/src/offline/__tests__/useQueuedLogs.test.ts apps/mobile/src/components/MealRow.tsx "apps/mobile/app/(tabs)/diary.tsx"
git commit -m "feat(mobile): show queued logs in the diary with pending and failed states"
```

---

### Task 7: Fix the dead offline-copy branch

**Files:**
- Modify: `apps/mobile/src/lib/apiErrorMessage.ts:36`
- Test: `apps/mobile/src/lib/__tests__/apiErrorMessage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing new.

`apiErrorMessage` returns its offline copy for `error instanceof TypeError`. PR #77 wrapped transport failures in `NetworkError`, which extends `Error`, not `TypeError` — so that branch no longer fires and offline failures fall through to the generic server message. This module is deliberately duck-typed to avoid importing `api.ts`, so match on the error's shape rather than adding that import.

- [ ] **Step 1: Write the failing test**

Append to `apps/mobile/src/lib/__tests__/apiErrorMessage.test.ts` (create it following the neighbouring test files' style if it does not exist):

```ts
test("a NetworkError gets the offline message, not the generic server one", () => {
  const err = Object.assign(new Error("fetch failed"), { name: "NetworkError" });
  expect(apiErrorMessage(err)).toBe("Couldn't reach Kora. Check your connection.");
});

test("a bare TypeError still gets the offline message", () => {
  expect(apiErrorMessage(new TypeError("Network request failed")))
    .toBe("Couldn't reach Kora. Check your connection.");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/apps/mobile && npx jest --ci --forceExit src/lib/__tests__/apiErrorMessage.test.ts`

Expected: FAIL on the `NetworkError` case — it returns the generic server message.

- [ ] **Step 3: Fix the branch**

In `apps/mobile/src/lib/apiErrorMessage.ts`, replace:

```ts
  // fetch rejects with a TypeError when the request never reached a server.
  if (error instanceof TypeError) return OFFLINE;
```

with:

```ts
  // fetch rejects with a TypeError when the request never reached a server,
  // and api.ts wraps that in a NetworkError (which extends Error, NOT
  // TypeError). Matched by name rather than by importing api.ts — this module
  // is deliberately duck-typed so it stays free of that dependency.
  if (error instanceof TypeError || (error as Error)?.name === "NetworkError") return OFFLINE;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora/apps/mobile && npx jest --ci --forceExit && npx tsc --noEmit`

Expected: PASS, full suite; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/apiErrorMessage.ts apps/mobile/src/lib/__tests__/apiErrorMessage.test.ts
git commit -m "fix(mobile): restore the offline message for wrapped network errors"
```

---

## Out of scope, deliberately

- **Deferred AI resolution** of photo/voice captures — slice 2, its own spec. Adds local media storage, a resolve-on-reconnect pipeline, and the capture-day-vs-resolve-day conflict #22 flags as unresolved.
- **Extending `POST /v1/logs/batch`** — it cannot represent per-item capture times or sources.
- **Offline free-text search over the full index** — the cache covers foods the device has seen; a genuinely new food still needs network.
- **`useInstantLog`'s silent failure** (`src/api/useInstantLog.ts` has no `onError`). It inherits queueing via `useCreateLog`, but its missing error surface is a separate bug.
