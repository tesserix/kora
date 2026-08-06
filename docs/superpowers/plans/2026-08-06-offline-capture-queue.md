# Offline Capture Queue Implementation Plan (#22 slice 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Photo and voice captures taken offline are queued durably and resolve automatically when connectivity returns, landing in the diary at the time they were captured.

**Architecture:** A second queue (`captureQueue`) beside slice 1's log queue, with its own AsyncStorage key and lock. Its drain does exactly one thing — media → resolved capture — then **hands off** to the existing log queue, which delivers to `/v1/logs` unchanged. Slice 1 is not modified.

**Tech Stack:** React Native / Expo SDK 57, TypeScript, `@tanstack/react-query`, `@react-native-async-storage/async-storage`, `expo-file-system` 57.0.1, Jest.

**Spec:** `docs/superpowers/specs/2026-08-06-offline-capture-queue-design.md`. Read it before Task 1.

## Global Constraints

- **Expo APIs must not be guessed.** `apps/mobile/AGENTS.md`: *"Expo HAS CHANGED. Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code."* The `expo-file-system` signatures in this plan were read from `node_modules/expo-file-system/build/internal/NativeFileSystem.types.d.ts` at 57.0.1 and are correct for that version; confirm before deviating.
- **Offline tests must run offline.** Slice 1 shipped fourteen green offline tests that every one ran with `onlineManager` reporting **online**. A test asserting offline behaviour while online is a failing test.
- **The resolve transport is NOT mocked.** #82 shipped broken because its tests mocked `apiFetchMultipart`, so `FormData.append` never ran.
- **Mutation-verify every assertion.** Break the behaviour the test names, confirm it fails *on that test's own assertion*, revert, confirm `git diff` is clean. Reason backward from "what implementation would make this pass while broken?"
- Install deps with `npx expo install <pkg>`, never plain `npm install`.
- `npx expo lint` regenerates `apps/mobile/eslint.config.js`, which is untracked on purpose. **Never commit it** — check `git status` before staging.
- Commits: conventional prefix, **single line**, no body, no trailers, no signature.
- Tests run in the **foreground**: `cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit`. Currently 108 suites / 710 tests green — must stay green.
- All work on branch `feat/offline-capture-queue`, already created off `main`.
- **Test fixtures must be timezone-safe.** `localDay` derives a calendar day from
  a UTC instant, so a literal like `"2026-08-06T09:00:00.000Z"` is a DIFFERENT
  day depending on where the suite runs. Use the existing convention from
  `src/offline/__tests__/useQueuedLogs.test.tsx`:
  ```ts
  const atLocalNoon = (y: number, m: number, d: number) =>
    new Date(y, m - 1, d, 12).toISOString();
  ```
- **There is no shared react-query test wrapper.** Each test file defines its own,
  copied from `useQueuedLogs.test.tsx`:
  ```ts
  const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (client: QueryClient) =>
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    };
  ```
  `retry: false` so a throwing `queryFn` surfaces immediately instead of stalling
  behind react-query's backoff.

## File Structure

| File | Responsibility |
|---|---|
| `src/offline/captureMedia.ts` (create) | Copy media into `documentDirectory`, delete it, sweep orphans. Filesystem only — no queue knowledge. |
| `src/offline/captureQueue.ts` (create) | Persist `QueuedCapture`. Own key + lock. Storage only — no network. |
| `src/offline/drainCaptures.ts` (create) | media → resolved capture, routed by tier. Never calls `/v1/logs`. |
| `src/offline/useQueuedCaptures.ts` (create) | Diary rows for pending / review / failed captures. |
| `src/components/ResolutionResult.tsx` (create) | The confirm/correct/follow-up UI, extracted from `capture.tsx`. |
| `app/capture.tsx` (modify) | Enqueue instead of failing when offline; consume the extracted component. |
| `src/offline/drainTriggers.ts` (modify) | Also fire `drainCaptures`; sweep orphans on install. |
| `app/(tabs)/diary.tsx` (modify) | Render capture rows alongside queued log rows. |

---

### Task 1: Durable media storage

**Files:**
- Create: `apps/mobile/src/offline/captureMedia.ts`
- Test: `apps/mobile/src/offline/__tests__/captureMedia.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `copyIntoQueue(sourceUri: string, id: string, fileName: string): Promise<string>` → returns the stored **file name** (not a full URI).
  - `queuedMediaUri(storedName: string): string` → absolute `file://` URI.
  - `deleteQueuedMedia(storedName: string): Promise<void>` — never throws.
  - `mediaExists(storedName: string): boolean`
  - `sweepOrphans(keepNames: string[]): Promise<number>` → count deleted.

**Why a stored NAME rather than a URI:** the absolute path of `documentDirectory` is not stable across iOS app updates — a persisted absolute URI can dangle after an upgrade. Storing the bare filename and rebuilding the URI on read keeps the queue valid across updates.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/src/offline/__tests__/captureMedia.test.ts
import { Directory, File, Paths } from "expo-file-system";
import {
  copyIntoQueue, deleteQueuedMedia, mediaExists, queuedMediaUri, sweepOrphans,
} from "../captureMedia";

function makeSourceFile(name: string, contents = "meal-bytes"): string {
  const f = new File(Paths.cache, name);
  f.create({ overwrite: true });
  f.write(contents);
  return f.uri;
}

describe("captureMedia", () => {
  afterEach(async () => { await sweepOrphans([]); });

  it("copies a cache-directory file into the document directory", async () => {
    const src = makeSourceFile("src-1.jpg");
    const stored = await copyIntoQueue(src, "cap-1", "meal.jpg");

    expect(mediaExists(stored)).toBe(true);
    // The stored copy must live under documentDirectory, NOT cache — iOS purges
    // cache under storage pressure and the capture would vanish (#22: no data
    // loss across app restart).
    expect(queuedMediaUri(stored)).toContain(Paths.document.uri);
    expect(queuedMediaUri(stored)).not.toContain(Paths.cache.uri);
  });

  it("survives deletion of the original cache file", async () => {
    const src = makeSourceFile("src-2.jpg");
    const stored = await copyIntoQueue(src, "cap-2", "meal.jpg");

    new File(src).delete();

    expect(mediaExists(stored)).toBe(true);
    expect(new File(queuedMediaUri(stored)).textSync()).toBe("meal-bytes");
  });

  it("gives each capture a distinct file even for identical file names", async () => {
    const a = await copyIntoQueue(makeSourceFile("s-a.jpg", "A"), "cap-a", "meal.jpg");
    const b = await copyIntoQueue(makeSourceFile("s-b.jpg", "B"), "cap-b", "meal.jpg");

    expect(a).not.toBe(b);
    expect(new File(queuedMediaUri(a)).textSync()).toBe("A");
    expect(new File(queuedMediaUri(b)).textSync()).toBe("B");
  });

  it("deleteQueuedMedia removes the file and never throws on a missing one", async () => {
    const stored = await copyIntoQueue(makeSourceFile("src-3.jpg"), "cap-3", "meal.jpg");
    await deleteQueuedMedia(stored);
    expect(mediaExists(stored)).toBe(false);
    await expect(deleteQueuedMedia(stored)).resolves.toBeUndefined();
    await expect(deleteQueuedMedia("never-existed.jpg")).resolves.toBeUndefined();
  });

  // Without this, every crash between "file written" and "row appended" leaks
  // megabytes permanently — the app has no other way to reclaim them.
  it("sweepOrphans deletes unreferenced files and keeps referenced ones", async () => {
    const keep = await copyIntoQueue(makeSourceFile("k.jpg"), "cap-keep", "meal.jpg");
    const orphan = await copyIntoQueue(makeSourceFile("o.jpg"), "cap-orphan", "meal.jpg");

    const deleted = await sweepOrphans([keep]);

    expect(deleted).toBe(1);
    expect(mediaExists(keep)).toBe(true);
    expect(mediaExists(orphan)).toBe(false);
  });

  it("sweepOrphans on an absent directory is a no-op, not a crash", async () => {
    const dir = new Directory(Paths.document, "captures");
    if (dir.exists) dir.delete();
    await expect(sweepOrphans([])).resolves.toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and confirm it FAILS**

Run: `cd apps/mobile && npx jest src/offline/__tests__/captureMedia.test.ts --ci --forceExit`
Expected: FAIL — `Cannot find module '../captureMedia'`.

- [ ] **Step 3: Implement**

```ts
// apps/mobile/src/offline/captureMedia.ts
import { Directory, File, Paths } from "expo-file-system";

// Queued media lives in documentDirectory, NOT cache. expo-image-picker hands
// back a cache-directory URI and iOS purges that directory under storage
// pressure, so a capture left there can disappear between queueing and
// draining — #22's "no data loss across app restart" would be false in exactly
// the low-storage conditions where it matters.
const DIR_NAME = "captures";

function dir(): Directory {
  return new Directory(Paths.document, DIR_NAME);
}

function ensureDir(): Directory {
  const d = dir();
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

// The stored NAME is persisted, never an absolute URI: documentDirectory's
// absolute path is not stable across iOS app updates, so a persisted URI can
// dangle after an upgrade while the file is still there.
function storedNameFor(id: string, fileName: string): string {
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : "";
  return `${id}${ext}`;
}

export function queuedMediaUri(storedName: string): string {
  return new File(dir(), storedName).uri;
}

export function mediaExists(storedName: string): boolean {
  return new File(dir(), storedName).exists;
}

export async function copyIntoQueue(
  sourceUri: string,
  id: string,
  fileName: string,
): Promise<string> {
  const target = ensureDir();
  const storedName = storedNameFor(id, fileName);
  const destination = new File(target, storedName);
  if (destination.exists) destination.delete();
  await new File(sourceUri).copy(destination);
  return storedName;
}

// Never throws. A delete failure must not abort a drain that has already
// delivered the log — the file is at worst a leak the orphan sweep reclaims.
export async function deleteQueuedMedia(storedName: string): Promise<void> {
  try {
    const f = new File(dir(), storedName);
    if (f.exists) f.delete();
  } catch {
    // Reclaimed by sweepOrphans on the next launch.
  }
}

// Deletes every file in the capture directory not named in keepNames.
export async function sweepOrphans(keepNames: string[]): Promise<number> {
  const d = dir();
  if (!d.exists) return 0;
  const keep = new Set(keepNames);
  let deleted = 0;
  for (const entry of d.list()) {
    if (entry instanceof Directory) continue;
    if (keep.has(entry.name)) continue;
    try {
      entry.delete();
      deleted++;
    } catch {
      // Skip; the next sweep retries.
    }
  }
  return deleted;
}
```

- [ ] **Step 4: Run the test and confirm it PASSES**

Run: `cd apps/mobile && npx jest src/offline/__tests__/captureMedia.test.ts --ci --forceExit`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation-verify each guarantee, one at a time**

For each, apply the mutation, run the test file, confirm the **named** test fails, then revert and confirm `git diff` is clean.

| Mutation | Test that must fail |
|---|---|
| `new Directory(Paths.cache, DIR_NAME)` instead of `Paths.document` | "copies a cache-directory file into the document directory" |
| `storedNameFor` returns `fileName` (drops the id) | "gives each capture a distinct file even for identical file names" |
| `sweepOrphans` deletes everything (drop the `keep.has` check) | "sweepOrphans deletes unreferenced files and keeps referenced ones" |
| `deleteQueuedMedia` drops its `try/catch` | "deleteQueuedMedia removes the file and never throws on a missing one" |
| `sweepOrphans` drops the `if (!d.exists) return 0` guard | "sweepOrphans on an absent directory is a no-op, not a crash" |

- [ ] **Step 6: Typecheck and commit**

```bash
cd apps/mobile && npx tsc --noEmit
git add src/offline/captureMedia.ts src/offline/__tests__/captureMedia.test.ts
git commit -m "feat(mobile): durable media storage for queued captures"
```

---

### Task 2: The capture queue

**Files:**
- Create: `apps/mobile/src/offline/captureQueue.ts`
- Test: `apps/mobile/src/offline/__tests__/captureQueue.test.ts`

**Interfaces:**
- Consumes: `createLock` from `./lock`.
- Produces:
  - `type QueuedCapture` (below), `MAX_CAPTURES = 20`, `MAX_RESOLVE_ATTEMPTS = 5`
  - `list(): Promise<QueuedCapture[]>`
  - `append(input: AppendCaptureInput): Promise<QueuedCapture>` — throws `CaptureQueueFullError` past the cap
  - `markReview(id: string, resolution: Resolution): Promise<void>`
  - `markFailed(id: string, reason: string): Promise<void>`
  - `recordAttempt(id: string, message: string, counts: boolean): Promise<void>`
  - `retry(id: string): Promise<void>`, `discard(id: string): Promise<void>`

```ts
export type QueuedCapture = {
  id: string;
  kind: "photo" | "voice";
  storedName: string;   // from captureMedia.copyIntoQueue
  fileName: string;
  mimeType: string;
  capturedAt: string;   // ISO — becomes the log's logged_at
  mealSlot?: string;
  status: "pending" | "review" | "failed";
  attempts: number;
  lastError?: string;
  resolution?: Resolution;
  ownerId: string;      // REQUIRED, unlike slice 1's optional field
  queuedAt: string;
};
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/src/offline/__tests__/captureQueue.test.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  CaptureQueueFullError, MAX_CAPTURES, append, discard, list, markFailed,
  markReview, recordAttempt, retry,
} from "../captureQueue";
import type { Resolution } from "@/api/types";

const RESOLUTION = { tier: "confirm", candidates: [] } as unknown as Resolution;

function input(id: string, over: Partial<Parameters<typeof append>[0]> = {}) {
  return {
    id, kind: "photo" as const, storedName: `${id}.jpg`, fileName: "meal.jpg",
    mimeType: "image/jpeg", capturedAt: atLocalNoon(2026, 8, 6),
    ownerId: "uid-1", ...over,
  };
}

beforeEach(async () => { await AsyncStorage.clear(); });

describe("captureQueue", () => {
  it("appends and reads back a pending capture", async () => {
    await append(input("c1"));
    const [item] = await list();
    expect(item).toMatchObject({ id: "c1", status: "pending", attempts: 0, ownerId: "uid-1" });
  });

  // One bad record must never wedge the whole queue — mirrors queue.ts's list().
  it("drops malformed entries instead of throwing", async () => {
    await AsyncStorage.setItem("kora.captureQueue", JSON.stringify([{ nope: true }, null, 7]));
    await expect(list()).resolves.toEqual([]);
  });

  it("returns an empty queue for corrupt JSON", async () => {
    await AsyncStorage.setItem("kora.captureQueue", "{not json");
    await expect(list()).resolves.toEqual([]);
  });

  // Concurrent read-modify-writes over one JSON blob drop each other's changes
  // without the lock — for this queue that is a meal the user was told was saved.
  it("serialises concurrent appends so none is lost", async () => {
    await Promise.all([append(input("a")), append(input("b")), append(input("c"))]);
    expect((await list()).map((i) => i.id).sort()).toEqual(["a", "b", "c"]);
  });

  // Refuse rather than evict: silently dropping the oldest discards a meal the
  // user believes is saved, which is the exact failure this feature prevents.
  it("refuses a capture past the cap instead of evicting the oldest", async () => {
    for (let i = 0; i < MAX_CAPTURES; i++) await append(input(`c${i}`));
    await expect(append(input("overflow"))).rejects.toBeInstanceOf(CaptureQueueFullError);
    const items = await list();
    expect(items).toHaveLength(MAX_CAPTURES);
    expect(items.map((i) => i.id)).toContain("c0");
  });

  it("markReview stores the resolution and flips status", async () => {
    await append(input("c1"));
    await markReview("c1", RESOLUTION);
    const [item] = await list();
    expect(item.status).toBe("review");
    expect(item.resolution).toEqual(RESOLUTION);
  });

  it("markFailed records a reason", async () => {
    await append(input("c1"));
    await markFailed("c1", "I couldn't identify that");
    const [item] = await list();
    expect(item).toMatchObject({ status: "failed", lastError: "I couldn't identify that" });
  });

  // counts=false is the offline case: the request never got a verdict, so the
  // item is WAITING, not being refused, and must not age toward the ceiling.
  it("recordAttempt only increments when the failure carried a verdict", async () => {
    await append(input("c1"));
    await recordAttempt("c1", "network down", false);
    expect((await list())[0]).toMatchObject({ attempts: 0, status: "pending" });
    await recordAttempt("c1", "server said 500", true);
    expect((await list())[0]).toMatchObject({ attempts: 1, status: "pending" });
  });

  it("retry resets attempts and clears the error", async () => {
    await append(input("c1"));
    await markFailed("c1", "boom");
    await recordAttempt("c1", "boom", true);
    await retry("c1");
    expect((await list())[0]).toMatchObject({ status: "pending", attempts: 0, lastError: undefined });
  });

  it("discard removes the row", async () => {
    await append(input("c1"));
    await discard("c1");
    await expect(list()).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm FAIL**

Run: `cd apps/mobile && npx jest src/offline/__tests__/captureQueue.test.ts --ci --forceExit`
Expected: FAIL — `Cannot find module '../captureQueue'`.

- [ ] **Step 3: Implement**

```ts
// apps/mobile/src/offline/captureQueue.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Resolution } from "@/api/types";
import { createLock } from "./lock";

const STORAGE_KEY = "kora.captureQueue";

// Its own lock, not the log queue's. The two queues have no ordering
// relationship, and sharing a chain would make a slow capture write delay a
// log drain for no reason (see lock.ts).
const withCaptureLock = createLock();

// A photo at quality 0.7 is roughly 1-3 MB, so this bounds queued media at
// well under 100 MB worst case.
export const MAX_CAPTURES = 20;

// Same ceiling and the same reasoning as the log queue's
// MAX_DELIVERY_ATTEMPTS: without one, a capture the server will never accept
// replays on every reconnect forever and the user cannot resolve it.
export const MAX_RESOLVE_ATTEMPTS = 5;

export class CaptureQueueFullError extends Error {
  constructor() {
    super("There are too many captures waiting to be identified. Connect to the internet, or remove one first.");
    this.name = "CaptureQueueFullError";
  }
}

export type QueuedCapture = {
  id: string;
  kind: "photo" | "voice";
  storedName: string;
  fileName: string;
  mimeType: string;
  capturedAt: string;
  mealSlot?: string;
  status: "pending" | "review" | "failed";
  attempts: number;
  lastError?: string;
  resolution?: Resolution;
  ownerId: string;
  queuedAt: string;
};

export type AppendCaptureInput = Pick<
  QueuedCapture,
  "id" | "kind" | "storedName" | "fileName" | "mimeType" | "capturedAt" | "ownerId"
> & { mealSlot?: string };

function isValid(v: unknown): v is QueuedCapture {
  const q = v as QueuedCapture;
  return (
    !!q && typeof q.id === "string" && typeof q.storedName === "string" &&
    typeof q.capturedAt === "string" && typeof q.queuedAt === "string" &&
    (q.kind === "photo" || q.kind === "voice") &&
    (q.status === "pending" || q.status === "review" || q.status === "failed") &&
    typeof q.attempts === "number" && typeof q.ownerId === "string"
  );
}

export async function list(): Promise<QueuedCapture[]> {
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

function update(fn: (items: QueuedCapture[]) => QueuedCapture[]): Promise<void> {
  return withCaptureLock(async () => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(fn(await list())));
  });
}

export async function append(input: AppendCaptureInput): Promise<QueuedCapture> {
  const item: QueuedCapture = {
    ...input, status: "pending", attempts: 0, queuedAt: new Date().toISOString(),
  };
  let full = false;
  await withCaptureLock(async () => {
    const items = await list();
    if (items.length >= MAX_CAPTURES) { full = true; return; }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...items, item]));
  });
  if (full) throw new CaptureQueueFullError();
  return item;
}

export async function markReview(id: string, resolution: Resolution): Promise<void> {
  await update((items) => items.map((i) =>
    i.id === id ? { ...i, status: "review", resolution, lastError: undefined } : i));
}

export async function markFailed(id: string, reason: string): Promise<void> {
  await update((items) => items.map((i) =>
    i.id === id ? { ...i, status: "failed", lastError: reason } : i));
}

// `counts` comes from the caller's verdict classifier, not from this module:
// storage does not know what an HTTP status means. attempts is read INSIDE the
// callback, not from a caller's stale snapshot, so a concurrent retry() reset
// cannot be clobbered (slice 1 review, #85).
export async function recordAttempt(id: string, message: string, counts: boolean): Promise<void> {
  await update((items) => items.map((i) => {
    if (i.id !== id) return i;
    const attempts = i.attempts + (counts ? 1 : 0);
    const done = attempts >= MAX_RESOLVE_ATTEMPTS;
    return { ...i, attempts, lastError: message, status: done ? "failed" : "pending" };
  }));
}

export async function retry(id: string): Promise<void> {
  await update((items) => items.map((i) =>
    i.id === id ? { ...i, status: "pending", attempts: 0, lastError: undefined } : i));
}

export async function discard(id: string): Promise<void> {
  await update((items) => items.filter((i) => i.id !== id));
}
```

- [ ] **Step 4: Run and confirm PASS**

Run: `cd apps/mobile && npx jest src/offline/__tests__/captureQueue.test.ts --ci --forceExit`
Expected: PASS, 10 tests.

- [ ] **Step 5: Mutation-verify**

| Mutation | Test that must fail |
|---|---|
| `append` evicts the oldest instead of throwing | "refuses a capture past the cap instead of evicting the oldest" |
| `update` drops `withCaptureLock` (plain load/save) | "serialises concurrent appends so none is lost" |
| `list` drops `.filter(isValid)` | "drops malformed entries instead of throwing" |
| `recordAttempt` always increments (ignore `counts`) | "recordAttempt only increments when the failure carried a verdict" |
| `retry` keeps `attempts` instead of resetting | "retry resets attempts and clears the error" |

- [ ] **Step 6: Typecheck and commit**

```bash
cd apps/mobile && npx tsc --noEmit
git add src/offline/captureQueue.ts src/offline/__tests__/captureQueue.test.ts
git commit -m "feat(mobile): persistence for the offline capture queue"
```

---

### Task 3: The capture drain

**Files:**
- Create: `apps/mobile/src/offline/drainCaptures.ts`
- Test: `apps/mobile/src/offline/__tests__/drainCaptures.test.ts`

**Interfaces:**
- Consumes: `captureQueue.*` (Task 2), `captureMedia.mediaExists`/`queuedMediaUri`/`deleteQueuedMedia` (Task 1), `queue.append` from slice 1, `Resolution` from `@/api/types`.
- Produces:
  - `drainCaptureQueue(deps: DrainDeps): Promise<{ logged: number; review: number; failed: number; deferred: number }>` — pure core, all I/O injected, so tests need no network.
  - `drainCaptures(queryClient: QueryClient): Promise<void>` — the app-facing wrapper with the in-flight guard.
  - `CaptureUnidentifiedError`

**Tier routing (from `api/internal/ai/types.go`):** `auto` ≥ 0.90 → log; `confirm` 0.70–0.90 → review; `follow_up` < 0.70 → review.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/src/offline/__tests__/drainCaptures.test.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { append as appendCapture, list as listCaptures } from "../captureQueue";
import { list as listLogs } from "../queue";
import { CaptureUnidentifiedError, drainCaptureQueue } from "../drainCaptures";
import type { Resolution } from "@/api/types";

const OWNER = "uid-1";

function res(tier: "auto" | "confirm" | "follow_up"): Resolution {
  return {
    tier,
    candidates: [{ item: { id: "food-1", name: "Oats", kcal_per_100g: 389 }, quantity_grams: 100 }],
  } as unknown as Resolution;
}

async function seed(id: string, over: Record<string, unknown> = {}) {
  return appendCapture({
    id, kind: "photo", storedName: `${id}.jpg`, fileName: "meal.jpg",
    mimeType: "image/jpeg", capturedAt: atLocalNoon(2026, 8, 6),
    ownerId: OWNER, ...over,
  } as Parameters<typeof appendCapture>[0]);
}

function deps(over: Partial<Parameters<typeof drainCaptureQueue>[0]> = {}) {
  return {
    ownerId: OWNER,
    resolve: jest.fn(async () => res("auto")),
    mediaExists: () => true,
    deleteMedia: jest.fn(async () => {}),
    ...over,
  } as Parameters<typeof drainCaptureQueue>[0];
}

beforeEach(async () => { await AsyncStorage.clear(); });

describe("drainCaptureQueue", () => {
  // tier "auto" hands off to the LOG queue — this drain never calls /v1/logs.
  it("hands an auto-tier capture to the log queue at its CAPTURE time", async () => {
    await seed("c1");
    const d = deps();

    const result = await drainCaptureQueue(d);

    expect(result.logged).toBe(1);
    const logs = await listLogs();
    expect(logs).toHaveLength(1);
    // Decision 2: the log is stamped when the photo was TAKEN, not when it resolved.
    expect(logs[0].payload.logged_at).toBe(atLocalNoon(2026, 8, 6));
    expect(await listCaptures()).toEqual([]);
    expect(d.deleteMedia).toHaveBeenCalledWith("c1.jpg");
  });

  it("routes confirm and follow_up to review, keeping the media", async () => {
    await seed("c1");
    await seed("c2");
    const d = deps({
      resolve: jest.fn(async (c: { id: string }) => (c.id === "c1" ? res("confirm") : res("follow_up"))),
    });

    const result = await drainCaptureQueue(d);

    expect(result.review).toBe(2);
    expect(result.logged).toBe(0);
    expect(await listLogs()).toEqual([]);
    expect((await listCaptures()).map((c) => c.status)).toEqual(["review", "review"]);
    expect(d.deleteMedia).not.toHaveBeenCalled();
  });

  // "The AI could not identify it" is a SUCCESSFUL resolve with no result.
  // Retrying it burns real Gemini budget against a photo of a wall forever.
  it("treats an unidentifiable capture as terminal, not retryable", async () => {
    await seed("c1");

    await drainCaptureQueue(deps({
      resolve: jest.fn(async () => { throw new CaptureUnidentifiedError(); }),
    }));

    const [item] = await listCaptures();
    expect(item.status).toBe("failed");
    expect(item.attempts).toBe(0);
  });

  // A failure with no HTTP status never got a verdict — offline is the NORMAL
  // state here, and counting it would fail a good meal after five launches.
  it("does not age a capture on a verdict-less failure", async () => {
    await seed("c1");

    const result = await drainCaptureQueue(deps({
      resolve: jest.fn(async () => { throw new Error("Network request failed"); }),
    }));

    expect(result.deferred).toBe(1);
    expect((await listCaptures())[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("fails a capture permanently on a 4xx", async () => {
    await seed("c1");

    await drainCaptureQueue(deps({
      resolve: jest.fn(async () => { throw Object.assign(new Error("bad"), { status: 400 }); }),
    }));

    expect((await listCaptures())[0].status).toBe("failed");
  });

  it("keeps a 401 retryable — it means 'not authenticated YET'", async () => {
    await seed("c1");

    await drainCaptureQueue(deps({
      resolve: jest.fn(async () => { throw Object.assign(new Error("unauth"), { status: 401 }); }),
    }));

    expect((await listCaptures())[0]).toMatchObject({ status: "pending", attempts: 1 });
  });

  // An unhandled throw here strands every OTHER queued capture in the pass.
  it("fails a capture whose media has vanished, without throwing", async () => {
    await seed("c1");
    await seed("c2");
    const d = deps({ mediaExists: (name: string) => name !== "c1.jpg" });

    await expect(drainCaptureQueue(d)).resolves.toBeDefined();

    const items = await listCaptures();
    expect(items.find((i) => i.id === "c1")?.status).toBe("failed");
    expect(items.find((i) => i.id === "c2")).toBeUndefined(); // c2 still drained
  });

  it("never drains another user's capture", async () => {
    await seed("mine");
    await seed("theirs", { ownerId: "uid-2" });
    const d = deps();

    await drainCaptureQueue(d);

    expect(d.resolve).toHaveBeenCalledTimes(1);
    expect((await listCaptures()).map((c) => c.id)).toEqual(["theirs"]);
  });

  it("skips rows already in review or failed", async () => {
    await seed("c1");
    const d = deps({ resolve: jest.fn(async () => res("confirm")) });
    await drainCaptureQueue(d);
    await drainCaptureQueue(d);
    expect(d.resolve).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run and confirm FAIL**

Run: `cd apps/mobile && npx jest src/offline/__tests__/drainCaptures.test.ts --ci --forceExit`
Expected: FAIL — `Cannot find module '../drainCaptures'`.

- [ ] **Step 3: Implement**

```ts
// apps/mobile/src/offline/drainCaptures.ts
import type { QueryClient } from "@tanstack/react-query";
import type { Resolution } from "@/api/types";
import { apiFetchMultipart, currentUserId } from "@/lib/api";
import { deleteQueuedMedia, mediaExists, queuedMediaUri } from "./captureMedia";
import {
  discard, list, markFailed, markReview, recordAttempt, type QueuedCapture,
} from "./captureQueue";
import { append as appendLog } from "./queue";
import { QUEUED_CAPTURES_KEY, QUEUED_LOGS_KEY } from "./queryKeys";

// A resolve that SUCCEEDED but produced no usable food. Distinct from a
// transport failure: retrying will produce the same nothing, so it is terminal.
export class CaptureUnidentifiedError extends Error {
  constructor() {
    super("I couldn't identify this one.");
    this.name = "CaptureUnidentifiedError";
  }
}

export type DrainDeps = {
  ownerId: string;
  resolve: (capture: QueuedCapture) => Promise<Resolution>;
  mediaExists: (storedName: string) => boolean;
  deleteMedia: (storedName: string) => Promise<void>;
};

// Same classifier as the log queue, for the same reasons (see queue.ts).
function statusOf(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status;
}
function isPermanent(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 401) return false;
  return typeof status === "number" && status >= 400 && status < 500;
}
function countsAsAttempt(err: unknown): boolean {
  return typeof statusOf(err) === "number";
}

function firstCandidate(resolution: Resolution) {
  return resolution.candidates?.[0];
}

export async function drainCaptureQueue(deps: DrainDeps) {
  let logged = 0, review = 0, failed = 0, deferred = 0;

  for (const item of await list()) {
    if (item.status !== "pending") continue;
    if (item.ownerId !== deps.ownerId) continue;

    // The file can be gone: an OS purge, cleared app data, or a crash between
    // append and copy. Terminal, and handled per item so one missing file
    // cannot strand the rest of the pass.
    if (!deps.mediaExists(item.storedName)) {
      await markFailed(item.id, "The photo or recording is no longer on this device.");
      failed++;
      continue;
    }

    try {
      const resolution = await deps.resolve(item);
      const candidate = firstCandidate(resolution);
      if (!candidate?.item) throw new CaptureUnidentifiedError();

      if (resolution.tier === "auto") {
        // Hand off. This module never calls /v1/logs — the log queue owns
        // delivery, exactly as it does for slice 1's rows.
        await appendLog(
          {
            food_item_id: candidate.item.id,
            quantity_grams: candidate.quantity_grams,
            meal_slot: item.mealSlot ?? "snack",
            // Decision 2: capture time, always.
            logged_at: item.capturedAt,
            source: item.kind === "photo" ? "photo" : "voice",
          },
          item.id,
          item.ownerId,
        );
        await deps.deleteMedia(item.storedName);
        await discard(item.id);
        logged++;
      } else {
        await markReview(item.id, resolution);
        review++;
      }
    } catch (err) {
      if (err instanceof CaptureUnidentifiedError) {
        await markFailed(item.id, err.message);
        failed++;
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (isPermanent(err)) {
        await markFailed(item.id, message);
        failed++;
      } else {
        await recordAttempt(item.id, message, countsAsAttempt(err));
        deferred++;
      }
    }
  }
  return { logged, review, failed, deferred };
}

async function resolveCapture(capture: QueuedCapture): Promise<Resolution> {
  const { buildCaptureForm, normalizeResolution } = await import("@/api/hooks");
  const path = capture.kind === "photo" ? "/v1/resolve/photo" : "/v1/resolve/voice";
  const form = buildCaptureForm({
    uri: queuedMediaUri(capture.storedName),
    name: capture.fileName,
    type: capture.mimeType,
  });
  return normalizeResolution(await apiFetchMultipart(path, form));
}

// Same in-flight guard as drainLogs: four triggers overlap on launch, and two
// passes would resolve the same capture twice — paying Gemini twice for it.
let inFlight: Promise<void> | null = null;

async function runDrain(queryClient: QueryClient): Promise<void> {
  const ownerId = currentUserId();
  if (!ownerId) return;

  const result = await drainCaptureQueue({
    ownerId,
    resolve: resolveCapture,
    mediaExists,
    deleteMedia: deleteQueuedMedia,
  });

  queryClient.invalidateQueries({ queryKey: [QUEUED_CAPTURES_KEY] });
  if (result.logged > 0) {
    // The handoff put rows in the LOG queue; its own drain sends them.
    queryClient.invalidateQueries({ queryKey: [QUEUED_LOGS_KEY] });
  }
}

export function drainCaptures(queryClient: QueryClient): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runDrain(queryClient).finally(() => { inFlight = null; });
  return inFlight;
}
```

- [ ] **Step 4: Export what this task needs from `hooks.ts` and add the query key**

`buildFileForm` and `normalizeResolution` are currently private in `src/api/hooks.ts`. Rename `buildFileForm` → `buildCaptureForm` and export both, plus export `normalizeResolution`. Do not change their bodies — this is a visibility change only, and the existing `resolve-upload-multipart.test.tsx` must stay green.

```ts
// apps/mobile/src/offline/queryKeys.ts — append
// The react-query key the diary's queued CAPTURE rows live under. Separate
// from QUEUED_LOGS_KEY so a capture pass does not invalidate log rows that
// did not change.
export const QUEUED_CAPTURES_KEY = "queuedCaptures";
```

- [ ] **Step 5: Run and confirm PASS**

Run: `cd apps/mobile && npx jest src/offline/__tests__/drainCaptures.test.ts src/api/__tests__/resolve-upload-multipart.test.tsx --ci --forceExit`
Expected: PASS. The multipart test must still pass — it is the #82 guard.

- [ ] **Step 6: Mutation-verify**

| Mutation | Test that must fail |
|---|---|
| `logged_at: new Date().toISOString()` instead of `item.capturedAt` | "hands an auto-tier capture to the log queue at its CAPTURE time" |
| Route every tier to the log queue | "routes confirm and follow_up to review, keeping the media" |
| Treat `CaptureUnidentifiedError` as retryable (drop its branch) | "treats an unidentifiable capture as terminal, not retryable" |
| `countsAsAttempt` returns `true` always | "does not age a capture on a verdict-less failure" |
| `isPermanent` includes 401 | "keeps a 401 retryable — it means 'not authenticated YET'" |
| Drop the `mediaExists` guard | "fails a capture whose media has vanished, without throwing" |
| Drop the `item.ownerId !== deps.ownerId` check | "never drains another user's capture" |

- [ ] **Step 7: Typecheck, full suite, commit**

```bash
cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit
git add src/offline/drainCaptures.ts src/offline/queryKeys.ts src/api/hooks.ts src/offline/__tests__/drainCaptures.test.ts
git commit -m "feat(mobile): resolve queued captures and hand off to the log queue"
```

---

### Task 4: Enqueue on capture, and wire the triggers

**Files:**
- Modify: `apps/mobile/app/capture.tsx`
- Modify: `apps/mobile/src/offline/drainTriggers.ts`
- Test: `apps/mobile/src/offline/__tests__/drainTriggers.test.ts` (extend), `apps/mobile/app/__tests__/capture-offline-queue.test.tsx` (create)

**Interfaces:**
- Consumes: `captureQueue.append`, `captureMedia.copyIntoQueue`/`sweepOrphans`, `drainCaptures`, `resolveOwnerId`/`NoOwnerError` from `./owner`.
- Produces: `enqueueCapture(file, kind, mealSlot): Promise<QueuedCapture>` exported from `src/offline/enqueueCapture.ts`.

**This is the task that makes the loop real.** After it, a photo taken offline queues, and reconnecting resolves and logs it.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/mobile/src/offline/__tests__/enqueueCapture.test.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { list } from "../captureQueue";
import { enqueueCapture } from "../enqueueCapture";

jest.mock("../captureMedia", () => ({
  copyIntoQueue: jest.fn(async (_uri: string, id: string) => `${id}.jpg`),
}));
jest.mock("../owner", () => {
  const actual = jest.requireActual("../owner");
  return { ...actual, resolveOwnerId: jest.fn(async () => "uid-1") };
});

beforeEach(async () => { await AsyncStorage.clear(); });

it("copies the media BEFORE appending, so no row can reference a missing file", async () => {
  const { copyIntoQueue } = jest.requireMock("../captureMedia");
  await enqueueCapture(
    { uri: "file:///cache/x.jpg", name: "meal.jpg", type: "image/jpeg" },
    "photo",
    "lunch",
  );
  expect(copyIntoQueue).toHaveBeenCalled();
  const [item] = await list();
  expect(item).toMatchObject({ kind: "photo", mealSlot: "lunch", storedName: expect.any(String) });
  expect(item.capturedAt).toBe(item.queuedAt);
});

it("refuses to queue when nobody is signed in", async () => {
  const { resolveOwnerId } = jest.requireMock("../owner");
  resolveOwnerId.mockResolvedValueOnce(null);
  await expect(
    enqueueCapture({ uri: "file:///cache/x.jpg", name: "m.jpg", type: "image/jpeg" }, "photo"),
  ).rejects.toMatchObject({ name: "NoOwnerError" });
  await expect(list()).resolves.toEqual([]);
});
```

```ts
// apps/mobile/src/offline/__tests__/drainTriggers-captures.test.ts
import { onlineManager } from "@tanstack/react-query";
import { installDrainTriggers } from "../drainTriggers";

jest.mock("../drainCaptures", () => ({ drainCaptures: jest.fn(async () => {}) }));
jest.mock("../drainLogs", () => ({ drainLogs: jest.fn(async () => {}) }));
jest.mock("../captureMedia", () => ({ sweepOrphans: jest.fn(async () => 0) }));

it("drains captures on reconnect, not only logs", () => {
  const { drainCaptures } = jest.requireMock("../drainCaptures");
  // Start OFFLINE, so the transition below is a real reconnect. A test that
  // begins online never exercises the path it names — the exact trap slice 1 hit.
  onlineManager.setOnline(false);
  const teardown = installDrainTriggers({} as never);
  drainCaptures.mockClear();

  onlineManager.setOnline(true);

  expect(drainCaptures).toHaveBeenCalled();
  teardown();
});

it("sweeps orphaned media on install", async () => {
  const { sweepOrphans } = jest.requireMock("../captureMedia");
  const teardown = installDrainTriggers({} as never);
  await Promise.resolve();
  expect(sweepOrphans).toHaveBeenCalled();
  teardown();
});
```

- [ ] **Step 2: Run and confirm FAIL**

Run: `cd apps/mobile && npx jest src/offline/__tests__/enqueueCapture.test.ts src/offline/__tests__/drainTriggers-captures.test.ts --ci --forceExit`
Expected: FAIL — missing module `../enqueueCapture`; `drainCaptures` not called.

- [ ] **Step 3: Implement `enqueueCapture`**

```ts
// apps/mobile/src/offline/enqueueCapture.ts
import { copyIntoQueue } from "./captureMedia";
import { append, type QueuedCapture } from "./captureQueue";
import { NoOwnerError, resolveOwnerId } from "./owner";

export type CaptureFile = { uri: string; name: string; type: string };

// Media is copied BEFORE the row is appended. The other order can leave a row
// pointing at a file that was never written if the copy fails — a permanently
// unresolvable capture the user believes is saved. This order can only leak a
// file with no row, which sweepOrphans reclaims.
export async function enqueueCapture(
  file: CaptureFile,
  kind: "photo" | "voice",
  mealSlot?: string,
): Promise<QueuedCapture> {
  const ownerId = await resolveOwnerId();
  if (!ownerId) throw new NoOwnerError();

  const id = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const storedName = await copyIntoQueue(file.uri, id, file.name);

  return append({
    id, kind, storedName, fileName: file.name, mimeType: file.type,
    // The user is holding the phone now: capture time IS now (decision 2).
    capturedAt: new Date().toISOString(),
    ownerId, mealSlot,
  });
}
```

- [ ] **Step 4: Wire the triggers**

In `src/offline/drainTriggers.ts`, add alongside the existing `drainLogs` call — do not replace it:

```ts
import { sweepOrphans } from "./captureMedia";
import { list as listCaptures } from "./captureQueue";
import { drainCaptures } from "./drainCaptures";

// inside installDrainTriggers, replacing the existing `drain` helper:
const drain = () => {
  void drainLogs(queryClient).catch(() => {});
  void drainCaptures(queryClient).catch(() => {});
};

// and once, immediately after the cold-start `drain()`:
// Reclaim media left behind by a crash between the copy and the append. Runs
// once per launch; a failure is ignored because the next launch retries.
void listCaptures()
  .then((items) => sweepOrphans(items.map((i) => i.storedName)))
  .catch(() => {});
```

- [ ] **Step 5: Wire `capture.tsx` to enqueue when offline**

`resolvePhoto.mutate` is called at `app/capture.tsx:922` and its `onError` currently
does `setErrorMsg(ottoErrorMessage(error))`. A `NetworkError` there is the offline
case: the request never reached the server, so the capture is queueable rather than
lost. Replace both `onError` handlers (photo at :922, voice at :970) with:

```ts
onError: (error) => { void handleResolveFailure(error, outcome.file, "photo"); },
```

and add this helper inside the component, above `handleTakePhoto`:

```tsx
// A NetworkError means the request never arrived — the capture is still good,
// so queue it rather than telling the user it failed. Any other error is a
// genuine refusal and keeps the existing message.
async function handleResolveFailure(
  error: Error,
  file: CaptureFile,
  kind: "photo" | "voice",
) {
  if (!(error instanceof NetworkError)) {
    setErrorMsg(ottoErrorMessage(error));
    return;
  }
  try {
    await enqueueCapture(file, kind, selectedMealSlot);
    // Generalises the promise the barcode path already makes at :729.
    setErrorMsg(
      "You're offline — I've saved that, and I'll identify it as soon as you're back online.",
    );
    void queryClient.invalidateQueries({ queryKey: [QUEUED_CAPTURES_KEY] });
  } catch (queueError) {
    // The queue itself refused (full, or nobody signed in). Both carry
    // user-facing copy on `message`, so surface it verbatim rather than
    // collapsing to a generic failure.
    setErrorMsg(
      queueError instanceof CaptureQueueFullError || queueError instanceof NoOwnerError
        ? queueError.message
        : ottoErrorMessage(error),
    );
  }
}
```

Imports to add: `enqueueCapture`, `type CaptureFile` from `@/offline/enqueueCapture`;
`CaptureQueueFullError` from `@/offline/captureQueue`; `NoOwnerError` from
`@/offline/owner`; `QUEUED_CAPTURES_KEY` from `@/offline/queryKeys`; and
`useQueryClient` from `@tanstack/react-query` if the component does not already
hold a client.

**Check `selectedMealSlot` exists** in this component before using it; if the
capture screen does not track a meal slot, pass `undefined` and let
`drainCaptures` apply its `"snack"` default rather than inventing a value here.

- [ ] **Step 6: Run and confirm PASS**

Run: `cd apps/mobile && npx jest src/offline --ci --forceExit`
Expected: PASS, including the existing `drainTriggers` tests.

- [ ] **Step 7: Mutation-verify**

| Mutation | Test that must fail |
|---|---|
| `enqueueCapture` appends before copying | "copies the media BEFORE appending, so no row can reference a missing file" |
| `enqueueCapture` defaults `ownerId` to `"unknown"` instead of throwing | "refuses to queue when nobody is signed in" |
| `drain` helper calls only `drainLogs` | "drains captures on reconnect, not only logs" |
| Remove the `sweepOrphans` call from install | "sweeps orphaned media on install" |

- [ ] **Step 8: Typecheck, full suite, commit**

```bash
cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit
git add src/offline app/capture.tsx
git commit -m "feat(mobile): queue photo and voice captures taken offline"
```

---

### Task 5: Diary rows for queued captures

**Files:**
- Create: `apps/mobile/src/offline/useQueuedCaptures.ts`
- Modify: `apps/mobile/app/(tabs)/diary.tsx`
- Test: `apps/mobile/src/offline/__tests__/useQueuedCaptures.test.tsx`

**Interfaces:**
- Consumes: `captureQueue.list`/`retry`/`discard`, `captureMedia.queuedMediaUri`, `QUEUED_CAPTURES_KEY`.
- Produces: `useQueuedCaptures(date: string)` → `{ rows: QueuedCaptureRow[], retryRow, discardRow }`

```ts
export type QueuedCaptureRow = {
  id: string;
  kind: "photo" | "voice";
  thumbnailUri: string | null;  // null for voice
  capturedAt: string;
  mealSlot: string;
  status: "pending" | "review" | "failed";
  /** ALWAYS null — a capture contributes no macros until confirmed. */
  kcal: null;
};
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/src/offline/__tests__/useQueuedCaptures.test.tsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import { renderHook, waitFor } from "@testing-library/react-native";
import { append, markReview } from "../captureQueue";
import { useQueuedCaptures } from "../useQueuedCaptures";
import type { Resolution } from "@/api/types";

jest.mock("@/lib/api", () => ({ ...jest.requireActual("@/lib/api"), currentUserId: () => "uid-1" }));

const RESOLUTION = { tier: "confirm", candidates: [] } as unknown as Resolution;

async function seed(id: string, capturedAt: string, ownerId = "uid-1") {
  await append({
    id, kind: "photo", storedName: `${id}.jpg`, fileName: "m.jpg", mimeType: "image/jpeg",
    capturedAt, ownerId,
  } as Parameters<typeof append>[0]);
}

beforeEach(async () => { await AsyncStorage.clear(); });

it("shows a capture on the day it was CAPTURED", async () => {
  await seed("c1", atLocalNoon(2026, 8, 6));
  const { result } = renderHook(() => useQueuedCaptures("2026-08-06"), { wrapper: wrap(newClient()) });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  expect(result.current.rows[0]).toMatchObject({ id: "c1", status: "pending", kcal: null });
});

// A review row has macros but the user has not accepted them. Counting them
// would make the day total MOVE when the user rejects the suggestion.
it("reports kcal null for a review row so it cannot enter day totals", async () => {
  await seed("c1", atLocalNoon(2026, 8, 6));
  await markReview("c1", RESOLUTION);
  const { result } = renderHook(() => useQueuedCaptures("2026-08-06"), { wrapper: wrap(newClient()) });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  expect(result.current.rows[0]).toMatchObject({ status: "review", kcal: null });
});

it("never shows another user's capture", async () => {
  await seed("theirs", atLocalNoon(2026, 8, 6), "uid-2");
  const { result } = renderHook(() => useQueuedCaptures("2026-08-06"), { wrapper: wrap(newClient()) });
  await waitFor(() => expect(result.current.rows).toEqual([]));
});

it("excludes captures from other days", async () => {
  await seed("c1", atLocalNoon(2026, 8, 5));
  const { result } = renderHook(() => useQueuedCaptures("2026-08-06"), { wrapper: wrap(newClient()) });
  await waitFor(() => expect(result.current.rows).toEqual([]));
});
```

- [ ] **Step 2: Run and confirm FAIL**

Run: `cd apps/mobile && npx jest src/offline/__tests__/useQueuedCaptures.test.tsx --ci --forceExit`
Expected: FAIL — `Cannot find module '../useQueuedCaptures'`.

- [ ] **Step 3: Implement** — mirror `useQueuedLogs.ts` exactly, including `networkMode: "always"` (these rows exist only when offline, so react-query's default would pause every refetch) and putting `ownerId` **in the query key** (a shared key paints the previous user's rows for one frame after an account switch).

```ts
// apps/mobile/src/offline/useQueuedCaptures.ts
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { currentUserId } from "@/lib/api";
import { queuedMediaUri } from "./captureMedia";
import { discard, list, retry, type QueuedCapture } from "./captureQueue";
import { drainCaptures } from "./drainCaptures";
import { QUEUED_CAPTURES_KEY } from "./queryKeys";

export type QueuedCaptureRow = {
  id: string;
  kind: "photo" | "voice";
  thumbnailUri: string | null;
  capturedAt: string;
  mealSlot: string;
  status: "pending" | "review" | "failed";
  kcal: null;
};

// Same derivation as useQueuedLogs: `capturedAt` is a bare UTC instant, so its
// "YYYY-MM-DD" prefix is a different day from the device's whenever the device
// is not on UTC.
const localDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA");

function toRow(c: QueuedCapture): QueuedCaptureRow {
  return {
    id: c.id,
    kind: c.kind,
    thumbnailUri: c.kind === "photo" ? queuedMediaUri(c.storedName) : null,
    capturedAt: c.capturedAt,
    mealSlot: c.mealSlot ?? "snack",
    status: c.status,
    // ALWAYS null. A pending capture has no macros; a review capture has macros
    // the user has not accepted. Day totals contain only data the user accepted
    // or the AI was >= 0.90 confident of.
    kcal: null,
  };
}

const NO_ROWS: QueuedCaptureRow[] = [];

export function useQueuedCaptures(date: string) {
  const qc = useQueryClient();
  const ownerId = currentUserId();

  const query = useQuery({
    queryKey: [QUEUED_CAPTURES_KEY, ownerId, date],
    queryFn: async () => {
      if (!ownerId) return NO_ROWS;
      return (await list())
        .filter((c) => c.ownerId === ownerId && localDay(c.capturedAt) === date)
        .map(toRow);
    },
    networkMode: "always",
  });

  const invalidate = useCallback(
    () => qc.invalidateQueries({ queryKey: [QUEUED_CAPTURES_KEY] }),
    [qc],
  );

  const retryRow = useCallback(async (id: string) => {
    await retry(id);
    await invalidate();
    void drainCaptures(qc).catch(() => {});
  }, [invalidate, qc]);

  const discardRow = useCallback(async (id: string) => {
    await discard(id);
    await invalidate();
  }, [invalidate]);

  return { rows: query.data ?? NO_ROWS, retryRow, discardRow };
}
```

- [ ] **Step 4: Render the rows in `app/(tabs)/diary.tsx`** beside the existing `useQueuedLogs` rows — pending shows a spinner and "Identifying when you're back online", review shows "Tap to confirm", failed shows "Couldn't identify".

- [ ] **Step 5: Run and confirm PASS**

Run: `cd apps/mobile && npx jest src/offline --ci --forceExit`

- [ ] **Step 6: Mutation-verify**

| Mutation | Test that must fail |
|---|---|
| `toRow` returns a computed kcal for review rows | "reports kcal null for a review row so it cannot enter day totals" |
| Drop the `c.ownerId === ownerId` filter | "never shows another user's capture" |
| Use `c.queuedAt` instead of `c.capturedAt` for `localDay` | "shows a capture on the day it was CAPTURED" |
| Drop `networkMode: "always"` | "shows a capture on the day it was CAPTURED" (with the test's client offline) |

- [ ] **Step 7: Typecheck, full suite, commit**

```bash
cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit
git add src/offline/useQueuedCaptures.ts src/offline/__tests__/useQueuedCaptures.test.tsx "app/(tabs)/diary.tsx"
git commit -m "feat(mobile): show queued captures in the diary"
```

---

### Task 6: Extract `ResolutionResult` from `capture.tsx`

**Files:**
- Create: `apps/mobile/src/components/ResolutionResult.tsx`
- Modify: `apps/mobile/app/capture.tsx`
- Test: existing `app/__tests__/capture*.test.tsx` must stay green, unchanged.

**This task changes NO behaviour.** `app/capture.tsx` is 1,134 lines — past this project's 800-line ceiling — and the review surface in Task 7 needs the same confirm/correct/follow-up UI. Extract it now, prove nothing changed, and build on it after.

**Interfaces:**
- Produces: `<ResolutionResult resolution={...} onConfirm={...} onReject={...} onAnswerFollowUp={...} />`, plus `resolveResultView(resolution)` and `resultSummary(resolution)` moved verbatim.

- [ ] **Step 1: Record the baseline**

```bash
cd apps/mobile && npx jest app/__tests__ --ci --forceExit 2>&1 | tail -5
```
Note the suite/test counts. They must be identical at Step 4.

- [ ] **Step 2: Move `resolveResultView`, `resultSummary`, `candidateKey` and the candidate/follow-up rendering into `src/components/ResolutionResult.tsx`**, exporting them. Change no logic, no copy, no styles. `capture.tsx` imports them instead of defining them.

- [ ] **Step 3: Run the capture tests**

Run: `cd apps/mobile && npx jest app/__tests__ --ci --forceExit`
Expected: identical counts to Step 1, all green. **If any test changed, the extraction was not behaviour-preserving — revert and redo.**

- [ ] **Step 4: Confirm the file shrank**

```bash
wc -l apps/mobile/app/capture.tsx   # must be materially below 1134
```

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit
git status   # confirm eslint.config.js is NOT staged
git add src/components/ResolutionResult.tsx app/capture.tsx
git commit -m "refactor(mobile): extract ResolutionResult from capture screen"
```

---

### Task 7: The review surface

**Files:**
- Create: `apps/mobile/app/capture-review.tsx`
- Test: `apps/mobile/app/__tests__/capture-review.test.tsx`

**Interfaces:**
- Consumes: `ResolutionResult` (Task 6), `captureQueue.list`/`discard`, `queue.append`, `captureMedia.deleteQueuedMedia`.
- Produces: a route that takes `?id=<captureId>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/app/__tests__/capture-review.test.tsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { append, list as listCaptures, markReview } from "@/offline/captureQueue";
import { list as listLogs } from "@/offline/queue";
import CaptureReviewScreen from "../capture-review";
import type { Resolution } from "@/api/types";

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "c1" }),
  router: { back: jest.fn() },
}));

const RESOLUTION = {
  tier: "confirm",
  candidates: [{ item: { id: "food-1", name: "Oats", kcal_per_100g: 389 }, quantity_grams: 100 }],
} as unknown as Resolution;

beforeEach(async () => {
  await AsyncStorage.clear();
  await append({
    id: "c1", kind: "photo", storedName: "c1.jpg", fileName: "m.jpg", mimeType: "image/jpeg",
    capturedAt: atLocalNoon(2026, 8, 6), ownerId: "uid-1",
  } as Parameters<typeof append>[0]);
  await markReview("c1", RESOLUTION);
});

it("confirming hands the capture to the log queue at its capture time", async () => {
  render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
  fireEvent.press(await screen.findByText(/confirm/i));

  await waitFor(async () => expect(await listLogs()).toHaveLength(1));
  const [log] = await listLogs();
  expect(log.payload.logged_at).toBe(atLocalNoon(2026, 8, 6));
  await expect(listCaptures()).resolves.toEqual([]);
});

it("rejecting discards the capture without logging anything", async () => {
  render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
  fireEvent.press(await screen.findByText(/not right|reject|discard/i));

  await waitFor(async () => expect(await listCaptures()).toEqual([]));
  await expect(listLogs()).resolves.toEqual([]);
});
```

- [ ] **Step 2: Run and confirm FAIL** — `Cannot find module '../capture-review'`.

- [ ] **Step 3: Implement the screen** — load the capture by id, render `<ResolutionResult resolution={capture.resolution} />`, and on confirm: `queue.append(payload, capture.id, capture.ownerId)` with `logged_at: capture.capturedAt`, then `deleteQueuedMedia`, then `captureQueue.discard`. On reject: `deleteQueuedMedia` then `discard`. A `follow_up` row renders its stored question through the same component.

- [ ] **Step 4: Run and confirm PASS.**

- [ ] **Step 5: Mutation-verify**

| Mutation | Test that must fail |
|---|---|
| `logged_at: new Date().toISOString()` | "confirming hands the capture to the log queue at its capture time" |
| Reject also appends to the log queue | "rejecting discards the capture without logging anything" |

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit
git add app/capture-review.tsx app/__tests__/capture-review.test.tsx
git commit -m "feat(mobile): review surface for captures resolved offline"
```

---

### Task 8: Failed captures stay usable

**Files:**
- Modify: `apps/mobile/app/capture-review.tsx` (failed branch), `apps/mobile/app/(tabs)/diary.tsx`
- Test: `apps/mobile/app/__tests__/capture-failed.test.tsx`

Decision 3: a permanently failed capture is **kept, with its media**, and offers manual logging seeded with the capture time. Voice has no thumbnail, so it shows duration and capture time with playback — the user's words are their record of the meal, the direct analogue of showing the photo.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/app/__tests__/capture-failed.test.tsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { append, list, markFailed } from "@/offline/captureQueue";
import CaptureReviewScreen from "../capture-review";

const push = jest.fn();
jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "c1" }),
  router: { back: jest.fn(), push: (...a: unknown[]) => push(...a) },
}));

beforeEach(async () => {
  await AsyncStorage.clear();
  push.mockClear();
  await append({
    id: "c1", kind: "photo", storedName: "c1.jpg", fileName: "m.jpg", mimeType: "image/jpeg",
    capturedAt: atLocalNoon(2026, 8, 6), ownerId: "uid-1",
  } as Parameters<typeof append>[0]);
  await markFailed("c1", "I couldn't identify that.");
});

it("keeps the failed capture and its media rather than discarding it", async () => {
  render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
  expect(await screen.findByText(/couldn't identify/i)).toBeTruthy();
  expect(await list()).toHaveLength(1);
});

it("offers manual logging seeded with the CAPTURE time", async () => {
  render(<CaptureReviewScreen />, { wrapper: wrap(newClient()) });
  fireEvent.press(await screen.findByText(/log it manually/i));
  expect(push).toHaveBeenCalledWith(
    expect.objectContaining({ params: expect.objectContaining({ loggedAt: atLocalNoon(2026, 8, 6) }) }),
  );
});
```

- [ ] **Step 2: Run and confirm FAIL.**

- [ ] **Step 3: Implement** — the failed branch shows the thumbnail (photo) or duration + playback (voice), the failure reason, and two actions: "Log it manually" (routes to the manual log screen with `loggedAt` and the thumbnail) and "Discard" (`deleteQueuedMedia` + `discard`).

- [ ] **Step 4: Run and confirm PASS.**

- [ ] **Step 5: Mutation-verify**

| Mutation | Test that must fail |
|---|---|
| Failed branch discards the capture on mount | "keeps the failed capture and its media rather than discarding it" |
| Seed manual logging with `Date.now()` | "offers manual logging seeded with the CAPTURE time" |

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit
git add app/capture-review.tsx "app/(tabs)/diary.tsx" app/__tests__/capture-failed.test.tsx
git commit -m "feat(mobile): keep failed captures usable with manual logging"
```

---

## Final verification — on a device, not the simulator

Unit tests cannot prove this feature works. Slice 1 shipped fourteen green offline tests that all ran online, and #82 shipped green because its tests mocked the transport.

- [ ] **A native rebuild is required** if any new native module was added: `npx expo run:ios --device <udid>`.
- [ ] Start Metro on **8083** — 8081 and 8082 are taken by Home-Chef-App, and `expo run:ios` has silently attached to another project's Metro before:
  ```bash
  cd apps/mobile && EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app \
    npx expo start --port 8083 --dev-client
  ```
- [ ] **Verify the served bundle, never Metro's startup line:**
  ```bash
  curl -s "http://localhost:8083/node_modules/expo-router/entry.bundle?platform=ios&dev=true" \
    | grep -oE '"EXPO_PUBLIC_API_URL": \{ enumerable: true, value: "[^"]*"'
  ```
- [ ] **Offline capture on a PHYSICAL DEVICE in airplane mode.** Do NOT disable workstation Wi-Fi — Mahesh declined that outright; it takes down the agent's own connectivity. The netinfo pre-flight path has no simulator equivalent (`simctl status_bar --dataNetwork` only repaints the icon) and was left **unverified on device** by slice 1.
- [ ] Take a photo in airplane mode → confirm the diary shows a pending row on **today**.
- [ ] **Force-quit and relaunch while still offline** → the row survives (this is the acceptance criterion the media copy exists for).
- [ ] Leave airplane mode → the capture resolves; a high-confidence result appears as a real log at the **capture** time, not the resolve time.
- [ ] Confirm a `confirm`-tier capture waits for review and does **not** move the day total until confirmed.
- [ ] Check `ai_usage_events` in prod for exactly one `identify_photo` row per resolved capture — two means the in-flight guard leaked and you paid Gemini twice.

## Open questions carried from the spec

- **#84 is inherited, not fixed.** `logged_at = capturedAt` comes from the device; if the server buckets by profile timezone, a capture near midnight can land on a different day than the pending row showed. Confirm the pending row and the delivered log agree on the day before calling this done.
