# Typed Capture Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A typed capture that fails while offline is queued and resolved on reconnect, exactly as a photo already is.

**Architecture:** `QueuedCapture` becomes a discriminated union on its existing `kind` field, gaining a `"text"` arm that carries a `phrase` instead of media. Rows written by the shipped build already carry a valid `kind` plus their media fields, so they validate unchanged and no migration runs. Every consumer that switches on `kind` is forced by the compiler to handle text.

**Tech Stack:** TypeScript, React Native / Expo SDK 57, AsyncStorage, TanStack Query, Jest + @testing-library/react-native.

**Spec:** `docs/superpowers/specs/2026-08-18-kora-typed-capture-queue-design.md`

## Global Constraints

- **Never break shipped rows.** `isValid` in `src/offline/captureQueue.ts` is a runtime guard over AsyncStorage that silently drops rows failing it. A row of the form `{kind: "photo", storedName, fileName, mimeType, ...}` MUST keep validating. This is the single most important constraint in the plan.
- **Capacity:** media keeps `MAX_CAPTURES = 20` (a byte budget); text gets `MAX_TEXT_CAPTURES = 50`. Counted per arm.
- **Source labels:** use the `ResolutionSource` union from `src/api/types.ts` (`"ai_photo" | "ai_text" | "ai_voice" | "ai_barcode"`). Never an inline string literal — a wrong value buckets into "other" server-side and corrupts the by-source metric.
- **Barcode is out of scope** (tracked in kora#241). `kind` gains `"text"` only.
- **Commit style:** single-line conventional-commit messages, no signature, no body.
- **Run tests from** `apps/mobile/`.

---

### Task 1: The queue's data model

**Files:**
- Modify: `apps/mobile/src/offline/captureQueue.ts`
- Test: `apps/mobile/src/offline/__tests__/captureQueue.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `MediaCapture`, `TextCapture`, `QueuedCapture` (union), `hasMedia(c: QueuedCapture): c is MediaCapture`, `MAX_TEXT_CAPTURES: number`, `AppendCaptureInput` (union of `AppendMediaInput | AppendTextInput`). Later tasks import all of these.

- [ ] **Step 1: Write the failing tests**

Append to `apps/mobile/src/offline/__tests__/captureQueue.test.ts`:

```ts
// kora#196. The queue was media-shaped: `kind` was "photo" | "voice" and
// isValid rejected anything else, so a typed capture had nowhere to live.
describe("text captures (kora#196)", () => {
  const textInput = {
    id: "cap_text_1",
    kind: "text" as const,
    phrase: "chicken and rice",
    capturedAt: "2026-08-18T10:00:00.000Z",
    ownerId: "owner-1",
  };

  it("accepts a text row and reads it back with its phrase", async () => {
    await append(textInput);
    const [row] = await list();
    expect(row.kind).toBe("text");
    expect(row).toMatchObject({ phrase: "chicken and rice", status: "pending", attempts: 0 });
  });

  // The upgrade guard, and the most important test in this change. isValid
  // silently DROPS rows it rejects, so a shipped-build media row that stops
  // validating deletes a user's queued photos on update. It cannot be caught
  // on a simulator either — no media capture can be staged there.
  it("still accepts a row written by the shipped, media-only build", async () => {
    await AsyncStorage.setItem(
      "kora.captureQueue",
      JSON.stringify([{
        id: "cap_old_1", kind: "photo", storedName: "cap_old_1.jpg",
        fileName: "meal.jpg", mimeType: "image/jpeg",
        capturedAt: "2026-08-17T10:00:00.000Z", queuedAt: "2026-08-17T10:00:00.000Z",
        status: "pending", attempts: 0, ownerId: "owner-1",
      }]),
    );
    const rows = await list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("photo");
  });

  it("drops a text row with no phrase rather than queueing an empty capture", async () => {
    await AsyncStorage.setItem(
      "kora.captureQueue",
      JSON.stringify([{
        id: "cap_bad", kind: "text", phrase: "",
        capturedAt: "2026-08-18T10:00:00.000Z", queuedAt: "2026-08-18T10:00:00.000Z",
        status: "pending", attempts: 0, ownerId: "owner-1",
      }]),
    );
    expect(await list()).toEqual([]);
  });

  // MAX_CAPTURES exists for BYTES ("a photo at quality 0.7 is roughly 1-3 MB").
  // A few hundred bytes of text must not be refused because 20 photos are
  // queued — typed is the mode with no safety net today.
  it("does not let a full media queue refuse a text capture", async () => {
    for (let i = 0; i < MAX_CAPTURES; i++) {
      await append({
        id: `cap_${i}`, kind: "photo", storedName: `cap_${i}.jpg`,
        fileName: "m.jpg", mimeType: "image/jpeg",
        capturedAt: "2026-08-18T10:00:00.000Z", ownerId: "owner-1",
      });
    }
    await expect(append(textInput)).resolves.toMatchObject({ kind: "text" });
  });

  it("refuses a text capture past its own ceiling", async () => {
    for (let i = 0; i < MAX_TEXT_CAPTURES; i++) {
      await append({ ...textInput, id: `cap_t_${i}` });
    }
    await expect(append({ ...textInput, id: "cap_t_over" })).rejects.toThrow(CaptureQueueFullError);
  });

  it("does not let a full text queue refuse a photo", async () => {
    for (let i = 0; i < MAX_TEXT_CAPTURES; i++) {
      await append({ ...textInput, id: `cap_t_${i}` });
    }
    await expect(append({
      id: "cap_photo", kind: "photo", storedName: "cap_photo.jpg",
      fileName: "m.jpg", mimeType: "image/jpeg",
      capturedAt: "2026-08-18T10:00:00.000Z", ownerId: "owner-1",
    })).resolves.toMatchObject({ kind: "photo" });
  });

  it("hasMedia narrows a media row and rejects a text row", async () => {
    await append(textInput);
    const [row] = await list();
    expect(hasMedia(row!)).toBe(false);
  });
});
```

Update that file's import line to include the new names:

```ts
import {
  append, CaptureQueueFullError, discard, hasMedia, list, markFailed, markReview,
  MAX_CAPTURES, MAX_TEXT_CAPTURES, recordAttempt, restore, retry,
} from "../captureQueue";
```

Keep any other names the file already imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/mobile && npx jest src/offline/__tests__/captureQueue.test.ts`
Expected: FAIL — `MAX_TEXT_CAPTURES` and `hasMedia` are not exported, and appending `kind: "text"` is a type error.

- [ ] **Step 3: Implement the union**

In `apps/mobile/src/offline/captureQueue.ts`, replace the `QueuedCapture` and `AppendCaptureInput` declarations with:

```ts
// Fields every queued capture carries regardless of modality.
type QueuedCaptureBase = {
  id: string;
  capturedAt: string;
  mealSlot?: string;
  status: "pending" | "review" | "failed";
  attempts: number;
  lastError?: string;
  // Optional: a row persisted before this field existed has none, and must
  // still be accepted by isValid below rather than dropped from the queue.
  failureKind?: CaptureFailureKind;
  resolution?: Resolution;
  ownerId: string;
  queuedAt: string;
};

// A capture whose identity is a file on disk. `storedName` is the persisted
// NAME, never an absolute URI — see captureMedia.ts.
export type MediaCapture = QueuedCaptureBase & {
  kind: "photo" | "voice";
  storedName: string;
  fileName: string;
  mimeType: string;
};

// A typed capture (kora#196). No media at all, so no storage lifecycle, no
// orphan sweep, and no byte budget — which is why it gets its own ceiling
// below rather than sharing the media one.
export type TextCapture = QueuedCaptureBase & {
  kind: "text";
  phrase: string;
};

export type QueuedCapture = MediaCapture | TextCapture;

// The single narrowing helper. Consumers use this rather than re-deriving
// `kind === "photo" || kind === "voice"` at each site, so adding a future
// media modality touches one predicate.
export function hasMedia(c: QueuedCapture): c is MediaCapture {
  return c.kind === "photo" || c.kind === "voice";
}

type AppendMediaInput = Pick<
  MediaCapture,
  "id" | "kind" | "storedName" | "fileName" | "mimeType" | "capturedAt" | "ownerId"
> & { mealSlot?: string };

type AppendTextInput = Pick<
  TextCapture,
  "id" | "kind" | "phrase" | "capturedAt" | "ownerId"
> & { mealSlot?: string };

export type AppendCaptureInput = AppendMediaInput | AppendTextInput;
```

Replace `isValid` with:

```ts
function isValid(v: unknown): v is QueuedCapture {
  const q = v as QueuedCapture;
  if (
    !q || typeof q.id !== "string" || typeof q.capturedAt !== "string" ||
    typeof q.queuedAt !== "string" || typeof q.attempts !== "number" ||
    typeof q.ownerId !== "string" ||
    !(q.status === "pending" || q.status === "review" || q.status === "failed")
  ) {
    return false;
  }
  // Per-arm. A shipped-build row carries kind "photo"/"voice" AND its media
  // fields, so it satisfies the media arm exactly as it did before the union.
  if (q.kind === "photo" || q.kind === "voice") return typeof q.storedName === "string";
  // An empty phrase is not a capture — queueing one would drain into a resolve
  // of nothing and fail as "unidentified", which reads as an AI failure rather
  // than the empty input it actually is.
  if (q.kind === "text") return typeof q.phrase === "string" && q.phrase.length > 0;
  return false;
}
```

Add the text ceiling next to `MAX_CAPTURES`:

```ts
// Text has no byte budget — MAX_CAPTURES exists for megabytes of media and
// that rationale does not transfer. Still bounded rather than unlimited: an
// abandoned-owner queue growing without limit is a known leak already recorded
// against the log queue (kora#85), and this must not add a second instance.
export const MAX_TEXT_CAPTURES = 50;
```

Replace `append` with a per-arm capacity check:

```ts
export async function append(input: AppendCaptureInput): Promise<QueuedCapture> {
  const item = {
    ...input, status: "pending", attempts: 0, queuedAt: new Date().toISOString(),
  } as QueuedCapture;
  let full = false;
  await withCaptureLock(async () => {
    const items = await list();
    // Counted PER ARM: a queue of 20 photos must not refuse a text capture,
    // and 50 queued phrases must not refuse a photo.
    const limit = item.kind === "text" ? MAX_TEXT_CAPTURES : MAX_CAPTURES;
    const used = items.filter((i) => (i.kind === "text") === (item.kind === "text")).length;
    if (used >= limit) { full = true; return; }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...items, item]));
  });
  if (full) throw new CaptureQueueFullError();
  return item;
}
```

Apply the same per-arm rule in `restore`, replacing its `items.length >= MAX_CAPTURES` check with:

```ts
    const limit = item.kind === "text" ? MAX_TEXT_CAPTURES : MAX_CAPTURES;
    const used = items.filter((i) => (i.kind === "text") === (item.kind === "text")).length;
    if (used >= limit) {
      full = true;
      return;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/mobile && npx jest src/offline/__tests__/captureQueue.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: errors ONLY in `drainCaptures.ts`, `drainTriggers.ts`, `useQueuedCaptures.ts` and `capture-review.tsx` — the consumers later tasks fix. That list is the compiler proving the union reaches every site that needs updating. Do not fix them here.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/offline/captureQueue.ts apps/mobile/src/offline/__tests__/captureQueue.test.ts
git commit -m "feat(offline): give the capture queue a text arm alongside its media one (#196)"
```

---

### Task 2: Enqueueing a typed capture

**Files:**
- Modify: `apps/mobile/src/offline/enqueueCapture.ts`
- Test: `apps/mobile/src/offline/__tests__/enqueueCapture.test.ts`

**Interfaces:**
- Consumes: `append`, `TextCapture` from Task 1.
- Produces: `enqueueTextCapture(phrase: string, mealSlot?: string): Promise<TextCapture>`. Task 7 calls it.

- [ ] **Step 1: Write the failing tests**

Append to `apps/mobile/src/offline/__tests__/enqueueCapture.test.ts`:

```ts
// kora#196. enqueueCapture's whole contract is media: copy the file first,
// then append, so a failure can only ever leak a file with no row. A text
// capture has no file, so none of that machinery applies to it.
describe("enqueueTextCapture (kora#196)", () => {
  it("queues the phrase without writing any media", async () => {
    const row = await enqueueTextCapture("chicken and rice", "lunch");
    expect(row).toMatchObject({ kind: "text", phrase: "chicken and rice", mealSlot: "lunch" });
    expect(copyIntoQueue).not.toHaveBeenCalled();
  });

  it("mints an id in the same shape the media path uses", async () => {
    const row = await enqueueTextCapture("two eggs");
    expect(row.id).toMatch(/^cap_\d+_[a-z0-9]+$/);
  });

  it("refuses to queue with nobody signed in, rather than queueing an ownerless row", async () => {
    (resolveOwnerId as jest.Mock).mockResolvedValueOnce(null);
    await expect(enqueueTextCapture("two eggs")).rejects.toBeInstanceOf(NoOwnerError);
  });
});
```

Add `enqueueTextCapture` to that file's import from `../enqueueCapture`, and ensure `copyIntoQueue` is available as a mock — the file already mocks `../captureMedia`; if `copyIntoQueue` is not currently exposed as a `jest.fn()` there, make it one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/mobile && npx jest src/offline/__tests__/enqueueCapture.test.ts`
Expected: FAIL with "enqueueTextCapture is not a function".

- [ ] **Step 3: Implement it**

Append to `apps/mobile/src/offline/enqueueCapture.ts`:

```ts
// The text sibling of enqueueCapture (kora#196). Deliberately does NOT share a
// body with it: the copy-before-append invariant the header comment above
// exists to state has nothing to protect when there is no file, and there is
// no cleanup path because a refused append can leak nothing.
export async function enqueueTextCapture(
  phrase: string,
  mealSlot?: string,
): Promise<TextCapture> {
  const ownerId = await resolveOwnerId();
  if (!ownerId) throw new NoOwnerError();

  return (await append({
    id: `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: "text",
    phrase,
    // The user is holding the phone now: capture time IS now (decision 2).
    capturedAt: new Date().toISOString(),
    ownerId,
    mealSlot,
  })) as TextCapture;
}
```

Extend its import from `./captureQueue`:

```ts
import { append, type QueuedCapture, type TextCapture } from "./captureQueue";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/mobile && npx jest src/offline/__tests__/enqueueCapture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/offline/enqueueCapture.ts apps/mobile/src/offline/__tests__/enqueueCapture.test.ts
git commit -m "feat(offline): queue a typed capture with no media lifecycle (#196)"
```

---

### Task 3: Keep the orphan sweep compiling and correct

**Files:**
- Modify: `apps/mobile/src/offline/drainTriggers.ts:31`
- Test: `apps/mobile/src/offline/__tests__/drainTriggers-captures.test.ts`

**Interfaces:**
- Consumes: `hasMedia` from Task 1.
- Produces: nothing new.

Note for the implementer: this is a **type-level** fix, not a latent data-loss bug. An `undefined` in the keep-set would be harmless, because no file on disk is ever named "undefined". The map simply stops compiling once `QueuedCapture` is a union.

- [ ] **Step 1: Write the failing test**

Append to `apps/mobile/src/offline/__tests__/drainTriggers-captures.test.ts`:

```ts
// kora#196: a text row has no storedName. The keep-set must contain only real
// media names, and a text row in the queue must not disturb the sweep.
it("passes only media names to the orphan sweep when the queue also holds text", async () => {
  const { sweepOrphans } = jest.requireMock("../captureMedia");
  sweepOrphans.mockClear();
  listCaptures.mockResolvedValueOnce([
    { id: "c1", kind: "photo", storedName: "c1.jpg" },
    { id: "c2", kind: "text", phrase: "chicken and rice" },
    { id: "c3", kind: "voice", storedName: "c3.m4a" },
  ]);

  await runTriggers();
  await flushPromises();

  expect(sweepOrphans).toHaveBeenCalledWith(["c1.jpg", "c3.m4a"]);
});
```

Match the existing test's setup for `listCaptures`, `runTriggers` and the promise flush — the file already has a working example immediately above (the one asserting `["c1.jpg", "c2.m4a"]`); mirror its mechanics exactly rather than inventing new ones.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/mobile && npx jest src/offline/__tests__/drainTriggers-captures.test.ts`
Expected: FAIL — `sweepOrphans` receives `["c1.jpg", undefined, "c3.m4a"]`.

- [ ] **Step 3: Filter to media rows**

In `apps/mobile/src/offline/drainTriggers.ts`, change line 31 from:

```ts
    .then((items) => sweepOrphans(items.map((i) => i.storedName)))
```

to:

```ts
    // Media rows only (kora#196): a text capture has no file, so it
    // contributes no name to keep. Filtering also keeps this compiling now
    // that QueuedCapture is a union.
    .then((items) => sweepOrphans(items.filter(hasMedia).map((i) => i.storedName)))
```

Add `hasMedia` to its import from `./captureQueue`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/mobile && npx jest src/offline/__tests__/drainTriggers-captures.test.ts`
Expected: PASS, including the pre-existing sweep test.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/offline/drainTriggers.ts apps/mobile/src/offline/__tests__/drainTriggers-captures.test.ts
git commit -m "fix(offline): keep only media names in the orphan sweep's keep-set (#196)"
```

---

### Task 4: Draining a typed capture

**Files:**
- Modify: `apps/mobile/src/offline/drainCaptures.ts`
- Test: `apps/mobile/src/offline/__tests__/drainCaptures.test.ts`

**Interfaces:**
- Consumes: `hasMedia`, `QueuedCapture` from Task 1.
- Produces: no new exports; `resolveCapture` and `sourceOf` stay private.

- [ ] **Step 1: Write the failing tests**

Append to `apps/mobile/src/offline/__tests__/drainCaptures.test.ts`:

This file already provides `seed(id, over)`, `res(tier)`, `deps(over)` and `OWNER = "uid-1"`. `seed` builds a **media** row, so add a text sibling next to it:

```ts
// seed() builds a MEDIA row. A text capture has no media at all, so it gets
// its own builder rather than a pile of `undefined` overrides (kora#196).
async function seedText(id: string, over: Record<string, unknown> = {}) {
  return appendCapture({
    id, kind: "text", phrase: "chicken and rice",
    capturedAt: atLocalNoon(2026, 8, 6), ownerId: OWNER, ...over,
  } as Parameters<typeof appendCapture>[0]);
}
```

Then append the tests:

```ts
// kora#196. The drain assumed every row had media: it gated on mediaExists and
// deleted a file after a successful auto-log. A text row has neither.
describe("text captures (kora#196)", () => {
  it("never asks whether a text row's media exists, and never deletes any", async () => {
    await seedText("cap_t1");
    const mediaExists = jest.fn(() => false);
    const deleteMedia = jest.fn(async () => {});

    await drainCaptureQueue(deps({ mediaExists, deleteMedia }));

    // Without the hasMedia guard this row would be failed as "missing-media"
    // on the first line of the loop — a text capture reported as a lost file.
    expect(mediaExists).not.toHaveBeenCalled();
    expect(deleteMedia).not.toHaveBeenCalled();
  });

  it("hands an auto-tier text resolution to the log queue as ai_text", async () => {
    await seedText("cap_t1");
    const result = await drainCaptureQueue(deps());

    expect(result.logged).toBe(1);
    expect(appendLog).toHaveBeenCalledWith(
      expect.objectContaining({ source: "ai_text" }),
      expect.stringMatching(UUID_V4),
      OWNER,
    );
  });

  it("sends a non-auto text resolution to review, like every other modality", async () => {
    await seedText("cap_t1");
    const result = await drainCaptureQueue(
      deps({ resolve: jest.fn(async () => res("confirm")) }),
    );
    expect(result.review).toBe(1);
  });
});
```

Use whatever name the file already binds for the mocked `appendLog` from `../queue`; if it asserts on that mock elsewhere, mirror that call exactly.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/mobile && npx jest src/offline/__tests__/drainCaptures.test.ts`
Expected: FAIL — the text row is marked `missing-media`, so `logged` is 0.

- [ ] **Step 3: Implement the dispatch and the guards**

In `apps/mobile/src/offline/drainCaptures.ts`:

Extend the imports:

```ts
import { apiFetch, apiFetchMultipart, currentUserId } from "@/lib/api";
import {
  discard, hasMedia, list, markFailed, markReview, recordAttempt, type QueuedCapture,
} from "./captureQueue";
```

Replace `sourceOf`:

```ts
function sourceOf(kind: QueuedCapture["kind"]): ResolutionSource {
  if (kind === "photo") return "ai_photo";
  if (kind === "text") return "ai_text";
  return "ai_voice";
}
```

Guard the missing-media precondition — replace:

```ts
    if (!deps.mediaExists(item.storedName)) {
```

with:

```ts
    // Media rows only (kora#196). A text capture has no file, so asking
    // whether its media exists would fail it as "missing-media" on the first
    // line of the loop — reporting a lost file for a capture that never had one.
    if (hasMedia(item) && !deps.mediaExists(item.storedName)) {
```

Guard the post-log delete — replace:

```ts
        await deps.deleteMedia(item.storedName);
        await discard(item.id);
```

with:

```ts
        if (hasMedia(item)) await deps.deleteMedia(item.storedName);
        await discard(item.id);
```

Replace `resolveCapture`:

```ts
async function resolveCapture(capture: QueuedCapture): Promise<Resolution> {
  // Text posts plain JSON to the same endpoint useResolveText uses; only media
  // needs the multipart body. normalizeResolution lives in the resolveWire leaf
  // module precisely so this file can use it without inverting the
  // @/api -> @/offline dependency (see that file's header).
  if (!hasMedia(capture)) {
    return normalizeResolution(
      await apiFetch("/v1/resolve/text", {
        method: "POST",
        body: JSON.stringify({ phrase: capture.phrase }),
      }),
    );
  }
  const path = capture.kind === "photo" ? "/v1/resolve/photo" : "/v1/resolve/voice";
  const form = buildCaptureForm({
    uri: queuedMediaUri(capture.storedName),
    name: capture.fileName,
    type: capture.mimeType,
  });
  return normalizeResolution(await apiFetchMultipart(path, form));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/mobile && npx jest src/offline/__tests__/drainCaptures.test.ts src/offline/__tests__/drainCaptures-upload-multipart.test.ts`
Expected: PASS, including every pre-existing test in both files.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/offline/drainCaptures.ts apps/mobile/src/offline/__tests__/drainCaptures.test.ts
git commit -m "feat(offline): resolve a queued typed capture on reconnect (#196)"
```

---

### Task 5: The diary row

**Files:**
- Modify: `apps/mobile/src/offline/useQueuedCaptures.ts`
- Modify: `apps/mobile/app/(tabs)/diary.tsx:360-367`
- Test: `apps/mobile/src/offline/__tests__/useQueuedCaptures.test.tsx`

**Interfaces:**
- Consumes: `hasMedia`, `QueuedCapture` from Task 1.
- Produces: `QueuedCaptureRow` gains `kind: "photo" | "voice" | "text"` and `phrase: string | null`. `diary.tsx` reads both.

- [ ] **Step 1: Write the failing test**

Append to `apps/mobile/src/offline/__tests__/useQueuedCaptures.test.tsx`:

```tsx
// kora#196: a queued text capture has no thumbnail. Its phrase is what the
// diary shows in place of one, so the row must carry it.
it("exposes a text capture's phrase and no thumbnail", async () => {
  listMock.mockResolvedValue([{
    id: "cap_t1", kind: "text", phrase: "chicken and rice",
    capturedAt: "2026-08-18T10:00:00.000Z", queuedAt: "2026-08-18T10:00:00.000Z",
    status: "pending", attempts: 0, ownerId: "owner-1", mealSlot: "lunch",
  }]);

  const { result } = renderHook(() => useQueuedCaptures("2026-08-18"), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));

  expect(result.current.rows[0]).toMatchObject({
    kind: "text", phrase: "chicken and rice", thumbnailUri: null, kcal: null,
  });
});
```

Use the file's existing `listMock` / `wrapper` setup rather than new ones.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/mobile && npx jest src/offline/__tests__/useQueuedCaptures.test.tsx`
Expected: FAIL — `phrase` is undefined on the row.

- [ ] **Step 3: Carry the phrase onto the row**

In `apps/mobile/src/offline/useQueuedCaptures.ts`, change the row type and `toRow`:

```ts
export type QueuedCaptureRow = {
  id: string;
  kind: "photo" | "voice" | "text";
  thumbnailUri: string | null;
  /** The typed phrase, for a text capture. null for media (kora#196). */
  phrase: string | null;
  capturedAt: string;
  mealSlot: string;
  status: "pending" | "review" | "failed";
  /** ALWAYS null — a capture contributes no macros until confirmed. */
  kcal: null;
};

function toRow(c: QueuedCapture): QueuedCaptureRow {
  return {
    id: c.id,
    kind: c.kind,
    thumbnailUri: c.kind === "photo" ? queuedMediaUri(c.storedName) : null,
    phrase: c.kind === "text" ? c.phrase : null,
    capturedAt: c.capturedAt,
    mealSlot: c.mealSlot ?? "snack",
    status: c.status,
    kcal: null,
  };
}
```

Add `hasMedia` to the import from `./captureQueue` if the compiler needs it to narrow `c.storedName`; `c.kind === "photo"` already narrows to `MediaCapture`, so it should not.

- [ ] **Step 4: Show the phrase in the diary**

In `apps/mobile/app/(tabs)/diary.tsx`, replace:

```tsx
                  const name = c.kind === "photo" ? "Photo" : "Voice note";
```

with:

```tsx
                  // A text capture's own words are a better row title than
                  // "Typed note" — the phrase IS the thing the user logged, and
                  // a queued row is otherwise unidentifiable until it resolves.
                  const name =
                    c.kind === "text" ? (c.phrase ?? "Typed note")
                      : c.kind === "photo" ? "Photo"
                      : "Voice note";
```

and replace:

```tsx
                      iconName={c.kind === "photo" ? "camera" : "mic"}
```

with:

```tsx
                      iconName={
                        c.kind === "text" ? "message-circle"
                          : c.kind === "photo" ? "camera"
                          : "mic"
                      }
```

`message-circle` is used deliberately: the `Icon` set (`apps/mobile/src/components/Icon.tsx`) has **no** text/type glyph, and a speech bubble is the closest honest reading of "the user said this in words". Do NOT add a new icon asset in this task.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/mobile && npx jest src/offline/__tests__/useQueuedCaptures.test.tsx 'app/(tabs)/__tests__'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/offline/useQueuedCaptures.ts "apps/mobile/app/(tabs)/diary.tsx" apps/mobile/src/offline/__tests__/useQueuedCaptures.test.tsx
git commit -m "feat(diary): show a queued typed capture by its own words (#196)"
```

---

### Task 6: The review screen

**Files:**
- Modify: `apps/mobile/app/capture-review.tsx`
- Test: `apps/mobile/app/__tests__/capture-review.test.tsx` (exists — extend it)

Note: `apps/mobile/app/__tests__/capture-review-discard.test.tsx` also exercises this screen. Run both.

**Interfaces:**
- Consumes: `hasMedia`, `QueuedCapture` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```tsx
// kora#196: a text capture has neither a thumbnail nor an audio clip. The
// phrase itself is the record of what the user logged, so a failed text
// capture must still show it — that is the whole point of keeping the row.
it("shows the typed phrase for a failed text capture", async () => {
  loadCapture.mockResolvedValue({
    id: "cap_t1", kind: "text", phrase: "chicken and rice",
    capturedAt: "2026-08-18T10:00:00.000Z", queuedAt: "2026-08-18T10:00:00.000Z",
    status: "failed", attempts: 5, failureKind: "delivery",
    lastError: "boom", ownerId: "owner-1",
  });

  const { findByText } = await render(<CaptureReviewScreen />);
  expect(await findByText("chicken and rice")).toBeTruthy();
});
```

Mirror the existing suite's mocks for the capture lookup and router params rather than inventing new ones — the file already has working examples for a failed photo capture.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/mobile && npx jest app/__tests__/capture-review.test.tsx`
Expected: FAIL — the phrase is not rendered; the screen tries the media branch.

- [ ] **Step 3: Render the phrase**

In `apps/mobile/app/capture-review.tsx`:

Fix `sourceOf` for the new arm:

```ts
function sourceOf(kind: QueuedCapture["kind"]): ResolutionSource {
  if (kind === "photo") return "ai_photo";
  if (kind === "text") return "ai_text";
  return "ai_voice";
}
```

Guard the audio source so a text row never reaches `queuedMediaUri`:

```ts
  const audioSource = capture?.kind === "voice" ? queuedMediaUri(capture.storedName) : null;
```

Fix the header overline:

```tsx
          overline={
            capture?.kind === "text" ? "Typed"
              : capture?.kind === "photo" ? "Photo"
              : "Voice note"
          }
```

Add the text branch ahead of the media ones in the failed-capture body — replace `{capture.kind === "photo" ? (` with `{capture.kind === "text" ? (` followed by this block, then `) : capture.kind === "photo" ? (` and the existing photo/voice branches unchanged:

```tsx
            // Styled AFTER UserBubble, not reusing it: that component is built
            // for the capture thread — right-aligned with a FadeInDown
            // entrance — and this screen is not a thread and has no sender to
            // align against. Same surface treatment, static.
            <View
              style={{
                borderRadius: 16,
                backgroundColor: colors.cardSecondary,
                padding: 18,
                gap: 8,
              }}
            >
              <AppText muted style={{ fontSize: 13 }}>
                Typed {new Date(capture.capturedAt).toLocaleString()}
              </AppText>
              <AppText variant="headline">{capture.phrase}</AppText>
            </View>
```

Guard both `deleteQueuedMedia(capture.storedName)` calls (around the discard and manual-log handlers) so a text row does not reach them:

```ts
      if (hasMedia(capture)) await deleteQueuedMedia(capture.storedName);
```

Add `hasMedia` to the import from `@/offline/captureQueue`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/mobile && npx jest app/__tests__/capture-review.test.tsx app/__tests__/capture-review-discard.test.tsx`
Expected: PASS, including every pre-existing test in both files.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/app/capture-review.tsx apps/mobile/app/__tests__/capture-review.test.tsx
git commit -m "feat(capture): show a queued typed capture's phrase on the review screen (#196)"
```

---

### Task 7: Queue on a failed typed send

**Files:**
- Modify: `apps/mobile/app/capture.tsx` (`handleSend`, and the `ottoErrorMessage` TimeoutError comment)
- Test: `apps/mobile/app/__tests__/capture.test.tsx`

**Interfaces:**
- Consumes: `enqueueTextCapture` from Task 2.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `apps/mobile/app/__tests__/capture.test.tsx`, inside the typed/text describe block:

```tsx
// kora#196. A failed typed resolve used to hand the words back and drop the
// capture. Someone typing "chicken and rice" on a plane lost it, while the
// same meal photographed was safely queued and replayed.
it("queues a typed capture when the request never arrived, and says so", async () => {
  const { findByPlaceholderText, findByText } = await render(<CaptureScreen />);
  await fireEvent.changeText(await findByPlaceholderText(/tell otto/i), "chicken and rice");
  await fireEvent.press(await findByLabelText("Send"));

  const [, options] = mockResolveTextMutate.mock.calls[0];
  await act(async () => options.onError(new NetworkError("offline")));

  expect(enqueueTextCapture).toHaveBeenCalledWith("chicken and rice", expect.anything());
  expect(await findByText(/I've saved that/i)).toBeTruthy();
});

// The phrase is safe in the queue, so returning it to the composer would be
// the misleading state — and the bubble stays because the capture WAS accepted.
it("keeps the sent bubble and leaves the composer empty once queued", async () => {
  const { findByPlaceholderText, findByText } = await render(<CaptureScreen />);
  const field = await findByPlaceholderText(/tell otto/i);
  await fireEvent.changeText(field, "chicken and rice");
  await fireEvent.press(await findByLabelText("Send"));

  const [, options] = mockResolveTextMutate.mock.calls[0];
  await act(async () => options.onError(new NetworkError("offline")));

  expect(await findByText("chicken and rice")).toBeTruthy();
  expect(field.props.value).toBe("");
});

// A genuine refusal is NOT queued — retrying it would fail identically.
it("hands the words back on a real server refusal instead of queueing", async () => {
  const { findByPlaceholderText, findByLabelText } = await render(<CaptureScreen />);
  const field = await findByPlaceholderText(/tell otto/i);
  await fireEvent.changeText(field, "chicken and rice");
  await fireEvent.press(await findByLabelText("Send"));

  const [, options] = mockResolveTextMutate.mock.calls[0];
  await act(async () => options.onError(new ApiError("bad request")));

  expect(enqueueTextCapture).not.toHaveBeenCalled();
  expect(field.props.value).toBe("chicken and rice");
});
```

Add `enqueueTextCapture` to the existing `@/offline/enqueueCapture` mock in that file as a `jest.fn()`. Use the file's real placeholder text and send-button accessibility label rather than the approximations above if they differ.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/mobile && npx jest app/__tests__/capture.test.tsx`
Expected: FAIL — `enqueueTextCapture` is never called and the composer is refilled.

- [ ] **Step 3: Queue on the offline classes**

In `apps/mobile/app/capture.tsx`, replace `handleSend`'s `onError` body:

```tsx
      onError: async (error) => {
        if (controller.signal.aborted) return;
        // Same classifier handleResolveFailure uses: these three mean the
        // request never arrived, so the phrase is still good and belongs in
        // the queue (kora#196). Anything else is a genuine refusal that would
        // fail identically on replay.
        const recoverable =
          error instanceof NetworkError ||
          error instanceof AuthTokenError ||
          error instanceof TimeoutError;
        if (!recoverable) {
          // Hand the words back. The bubble goes with them: a message that
          // never arrived should not sit in the thread as though it did.
          setSentPhrase(null);
          setText(phrase);
          setErrorMsg(ottoErrorMessage(error));
          return;
        }
        try {
          await enqueueTextCapture(phrase, mealSlot);
          // The bubble STAYS and the composer stays empty: the capture was
          // accepted, so returning the text would be the misleading state.
          setErrorMsg(
            "You're offline — I've saved that, and I'll identify it as soon as you're back online.",
          );
          void queryClient.invalidateQueries({ queryKey: [QUEUED_CAPTURES_KEY] });
        } catch (queueError) {
          // The queue refused (full, or nobody signed in) — the phrase is only
          // safe in the composer now, so put it back and say why.
          setSentPhrase(null);
          setText(phrase);
          setErrorMsg(
            queueError instanceof CaptureQueueFullError || queueError instanceof NoOwnerError
              ? queueError.message
              : ottoErrorMessage(error),
          );
        }
      },
```

Add `enqueueTextCapture` to the import from `@/offline/enqueueCapture`.

- [ ] **Step 4: Repair the marker comment**

Replace the whole `TimeoutError` branch of `ottoErrorMessage` — it is currently mis-assembled, with the kora#196 parenthetical spliced into the middle of a sentence — with:

```ts
  if (error instanceof TimeoutError) {
    // Reached from the BARCODE path (handleBarcodeScanned), which still does
    // not queue — kora#241 tracks giving it one. The typed path now queues on
    // timeout (kora#196) and sets its own copy in handleSend's onError, and
    // handleResolveFailure does the same for photo and voice, so this generic
    // text is only ever seen by a caller with nothing saved. It therefore
    // stays honest about the timeout itself and promises no save.
    return "That took too long — mind trying again?";
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/mobile && npx jest app/__tests__/capture.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full suite, typecheck and lint**

Run: `cd apps/mobile && npx tsc --noEmit && npx jest && npm run -s lint`
Expected: `tsc` clean; all suites pass; lint problem count no higher than `main`'s baseline (71 errors / 40 warnings — all pre-existing React-Compiler-vs-Reanimated false positives).

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/app/capture.tsx apps/mobile/app/__tests__/capture.test.tsx
git commit -m "feat(capture): queue a typed capture instead of dropping it offline (#196)"
```

---

## Simulator verification

Run after Task 7. The typed path was chosen over barcode precisely because it needs no camera and no microphone, so it is fully reachable on the simulator.

- [ ] Boot the **iPhone 17 Pro Max** (matches the user's device; a screenshot from a narrower sim actively conceals layout problems).
- [ ] Start Metro against an **unreachable** API so the app is effectively offline:
      `EXPO_PUBLIC_API_URL=https://127.0.0.1:9 npx expo start --dev-client --port 8084`
- [ ] Sign in (the sign-in screen's "Create an account" link lands directly in onboarding; `idb ui text` truncates the last ~3 characters of a long string, so screenshot and top up the tail).
- [ ] Type a meal in the composer and send. Confirm: the bubble stays, the composer clears, and the copy says the capture is saved.
- [ ] Open the diary. Confirm the queued row shows **the phrase**, not "Typed note", with "Identifying when you're back online".
- [ ] Restart Metro against `https://kora-api.tesserix.app`, reload, and confirm the row drains — it either logs or moves to review.
- [ ] Delete the throwaway account afterwards (`accounts:signInWithPassword` → `accounts:delete` with the iOS API key).

## Known limitation, do not try to work around

No **media** capture can be created on the simulator: the iOS 26 camera UI renders but its shutter produces no photo, and voice needs real mic input. The upgrade guard in Task 1 — that a shipped-build media row still validates — therefore cannot be confirmed by staging a real photo, and that test is the only thing standing between this change and deleting a user's queued photos on update. Do not weaken or remove it.
