# Cancel Actually Aborts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cancel aborts the in-flight resolve for real — freeing bandwidth and server AI budget — re-arms the barcode scanner safely, and stops destroying an offline capture.

**Architecture:** The abort plumbing already exists below the hooks (`apiFetchEnvelope` takes `init.signal`, `apiFetchMultipart` takes `{ signal }`). The four resolve hooks' mutation variables become an object carrying the signal, `capture.tsx` passes its controller's signal at every call site, the barcode latch gains a per-code cooldown so a truly-aborting Cancel cannot instantly re-fire on the in-frame code, and a cancelled offline capture is enqueued instead of dropped.

**Tech Stack:** React Native / Expo SDK 57, TypeScript, React Query, Jest + `@testing-library/react-native`.

## Global Constraints

- **Expo v57.** Read https://docs.expo.dev/versions/v57.0.0/ before using any Expo API.
- **Suites must stay green:** `cd apps/mobile && npx tsc --noEmit` and `cd apps/mobile && npx jest --ci --forceExit`. **Baseline: 174 suites / 1429 tests.** Report counts.
- **No `console.log`** in `app/` or `src/`. A deliberate best-effort swallow is a commented empty `catch` (`src/lib/push.ts:46-50`).
- **Explicit types on exported functions.** No `any` — use `unknown` and narrow.
- **Immutability.** Never mutate existing objects.
- **Commit messages:** single-line, conventional-commit prefix, **no signature, no body**.
- **Tests: `fireEvent` MUST be awaited** (RNTL 14.0.1 + React 19.2.3 do not flush state otherwise; an un-awaited event lets assertions pass against a broken implementation). See `app/__tests__/sign-in.test.tsx:69-121`.
- **Spec of record:** `docs/superpowers/specs/2026-08-13-kora-cancel-aborts-design.md`.

## Context an implementer needs

**The four hooks** are in `apps/mobile/src/api/hooks.ts`: `useResolveText` (:659), `useResolveBarcode` (:680), `useResolvePhoto` (:717), `useResolveVoice` (:756). Each currently takes a raw value as its mutation variable.

**The layer below already accepts a signal** — do not change it:
- `apiFetch(path, init)` → `apiFetchEnvelope`, which passes `init.signal` (`src/lib/api.ts:344`).
- `apiFetchMultipart(path, form, { signal })` (`src/lib/api.ts:376,387`).

**`useResolveBarcode` has an offline cache fallback** (`withCacheFallback` → `barcodeFromCache`) and `networkMode: "always"`. Preserve both exactly — a paused mutation there does not delay the feature, it removes it.

**The barcode latch.** `capture.tsx:1254-1256` documents that `CameraView` fires `onBarcodeScanned` **dozens of times a second while a code is in frame**. `scannedRef` exists to stop dozens of concurrent resolves, and is correctly released on every terminal outcome (`onSuccess`, `onError`, and the server's "not recognized" 200) *before* the aborted-signal early return.

**Why Task 2 must follow Task 1 and not precede it.** Today the latch stays up until the abandoned resolve settles (up to 25s). Once Task 1 lands, `onError` fires immediately with an `AbortError` and the latch releases at once — with the same barcode still in frame. Without Task 2 that instantly starts a new resolve and defeats Cancel. Resetting the latch inside `handleCancelResolve` is the naive fix and is explicitly worse.

**Cancel's current shape** (`capture.tsx:943-955`): `beginResolve()` creates the controller and stores it in `resolveControllerRef`; `handleCancelResolve()` aborts it, sets `cancelledResolve`, and returns the stage to idle. Each `mutate()` closes over its own controller and early-returns from `onSuccess`/`onError` when `controller.signal.aborted`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `apps/mobile/src/api/hooks.ts` | Modify (:659, :680, :717, :756) | Resolve hooks accept and forward the signal |
| `apps/mobile/app/capture.tsx` | Modify | Pass the signal; barcode cooldown; preserve offline capture |
| `apps/mobile/src/api/__tests__/hooks.test.tsx` | Modify | Updated variable shape |
| `apps/mobile/src/api/__tests__/resolve-upload-multipart.test.tsx` | Modify | Updated variable shape |
| `apps/mobile/app/__tests__/capture*.test.tsx` | Modify | Updated variable shape + new behaviour |

---

## Task 1: Thread the signal from hook to socket

**Files:**
- Modify: `apps/mobile/src/api/hooks.ts` (the four resolve hooks)
- Modify: `apps/mobile/app/capture.tsx` (every resolve `mutate()` call site)
- Modify: `apps/mobile/src/api/__tests__/hooks.test.tsx`, `apps/mobile/src/api/__tests__/resolve-upload-multipart.test.tsx`, and the `app/__tests__/capture*.test.tsx` files

**Interfaces:**
- Consumes: `apiFetch(path, init)` and `apiFetchMultipart(path, form, { signal })` — unchanged.
- Produces: each resolve mutation takes `{ input, signal }`. Tasks 2 and 3 rely on Cancel genuinely aborting.

**This task must land as one commit** — changing the variable shape breaks every call site and its assertions simultaneously; there is no smaller compiling slice.

- [ ] **Step 1: Write the failing test**

Add to `apps/mobile/src/api/__tests__/hooks.test.tsx`, following the file's existing mock conventions:

```tsx
test("useResolveText passes the caller's signal to apiFetch", async () => {
  const controller = new AbortController();
  // ...render the hook per this file's existing harness...
  await result.current.mutateAsync({ input: "two eggs", signal: controller.signal });

  const [, init] = mockApiFetch.mock.calls[0] as [string, RequestInit];
  expect(init.signal).toBe(controller.signal);
});

test("aborting the signal rejects the in-flight resolve", async () => {
  const controller = new AbortController();
  mockApiFetch.mockImplementation(
    (_p: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  // ...start the mutation, then controller.abort(), and assert it rejects...
});
```

The second test is the one that matters: the acceptance criterion is explicit that the abort must be verified by the request not completing, **not** by the UI returning to idle — which already happens today and would pass against the unfixed code.

Add the equivalent signal-forwarding test for `useResolvePhoto` in `resolve-upload-multipart.test.tsx`, asserting the third argument to `apiFetchMultipart` carries the signal.

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/mobile && npx jest src/api/__tests__/hooks.test.tsx --ci --forceExit`
Expected: FAIL — the hook takes a string, so `{ input, signal }` is not forwarded and `init.signal` is undefined.

- [ ] **Step 3: Change the four hooks**

Define one shared variables type near the hooks:

```ts
/** Resolve mutations carry the caller's AbortSignal in their variables because
 *  React Query hands `mutationFn` exactly one argument. Without it, Cancel was
 *  a local token only: the UI went idle while the socket — and the server's AI
 *  budget — kept running to completion or the 25s deadline. See #136. */
export type ResolveVars<T> = { input: T; signal?: AbortSignal };
```

Then, for each hook, take `{ input, signal }` and forward the signal:

- `useResolveText` — `apiFetch("/v1/resolve/text", { method: "POST", body: JSON.stringify({ phrase: input }), signal })`
- `useResolveBarcode` — same pattern for `/v1/resolve/barcode` with `{ barcode: input }`. **Keep `networkMode: "always"` and the `withCacheFallback(..., () => barcodeFromCache(input))` fallback exactly as they are** — a paused mutation here removes the offline feature rather than delaying it.
- `useResolvePhoto` and `useResolveVoice` — pass `{ signal }` as the third argument to `apiFetchMultipart`.

- [ ] **Step 4: Update every call site in `capture.tsx`**

Each resolve `mutate()`/`mutateAsync()` already has a `controller` in scope from `beginResolve()`. Change the argument from the raw value to `{ input: <the raw value>, signal: controller.signal }`. Leave the existing `onSuccess`/`onError` handlers — including their `controller.signal.aborted` early returns — untouched.

- [ ] **Step 5: Update the pinned assertions**

`toHaveBeenCalledWith(rawValue, …)` assertions across `hooks.test.tsx`, `resolve-upload-multipart.test.tsx` and the `capture-*.test.tsx` files now need the object shape. Prefer `expect.objectContaining({ input: rawValue })` so the assertions do not also pin the signal identity where that is not the point of the test.

**Do not weaken an assertion to make it pass.** If one fails for a reason other than the shape change, stop and report it.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit`
Expected: green. Report counts.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/api/hooks.ts apps/mobile/app/capture.tsx apps/mobile/src/api/__tests__ apps/mobile/app/__tests__
git commit -m "fix(mobile): thread the abort signal from resolve hooks to the socket"
```

---

## Task 2: Re-arm the barcode scanner safely

**Files:**
- Modify: `apps/mobile/app/capture.tsx`
- Test: `apps/mobile/app/__tests__/capture-barcode.test.tsx` (or the capture test file that covers barcode scanning — find it)

**Interfaces:**
- Consumes: Task 1's genuine abort.
- Produces: nothing.

Now that Cancel truly aborts, `onError` fires at once with an `AbortError` and `scannedRef` releases immediately — with the cancelled barcode still in frame, firing `onBarcodeScanned` dozens of times a second. Without this task, Cancel instantly starts a new resolve of the same code.

- [ ] **Step 1: Write the failing tests**

In the barcode capture test file, following its existing conventions:

1. Cancel a barcode resolve, then scan **a different** barcode — it resolves immediately.
2. Cancel a barcode resolve, then re-present **the same** barcode within the cooldown — no new resolve starts.
3. The same barcode **after** the cooldown elapses — a new resolve starts. Use Jest fake timers.

Test 3 is not optional: a suppression with no expiry is its own bug, and tests 2 and 3 together are what distinguish "cooled down" from "permanently dead".

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/mobile && npx jest app/__tests__/capture-barcode.test.tsx --ci --forceExit`
Expected: FAIL — test 2 fails because the cancelled code re-fires immediately.

- [ ] **Step 3: Implement the cooldown**

Add two refs beside `scannedRef`:

```tsx
  // Cancel must mean "stop this scan", not "stop scanning". Once the resolve
  // genuinely aborts (#136), scannedRef releases immediately — with the
  // cancelled code still in frame, and CameraView firing dozens of times a
  // second. Suppressing only THAT code for a moment lets a different barcode
  // scan instantly while stopping the cancelled one from re-firing on its own.
  const cancelledCodeRef = useRef<string | null>(null);
  const cancelledAtRef = useRef(0);
```

Add a module-level constant with the other constants in the file:

```tsx
const CANCELLED_CODE_COOLDOWN_MS = 2000;
```

In `handleBarcodeScanned`, before the latch check:

```tsx
    if (
      cancelledCodeRef.current === data &&
      Date.now() - cancelledAtRef.current < CANCELLED_CODE_COOLDOWN_MS
    ) {
      return;
    }
```

In `handleCancelResolve`, record what was cancelled. It needs the in-flight barcode, so store it when the scan starts (`handleBarcodeScanned` sets a `lastScannedCodeRef`), and on cancel copy that into `cancelledCodeRef` with `cancelledAtRef.current = Date.now()`.

Clear `cancelledCodeRef` when a *different* code scans successfully, so the suppression cannot outlive its purpose.

**Do not reset `scannedRef` inside `handleCancelResolve`.** The abort from Task 1 releases it through `onError`; resetting it here as well is the naive fix the issue warns against.

- [ ] **Step 4: Run the tests**

Run: `cd apps/mobile && npx jest app/__tests__/capture-barcode.test.tsx --ci --forceExit`
Expected: PASS.

- [ ] **Step 5: Full suite and typecheck**

Run: `cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit`
Report counts.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/capture.tsx apps/mobile/app/__tests__
git commit -m "fix(mobile): re-arm the barcode scanner without re-firing the cancelled code"
```

---

## Task 3: A cancelled offline capture is preserved

**Files:**
- Modify: `apps/mobile/app/capture.tsx` (the photo and voice `onError` handlers, ~:1175 and ~:1233)
- Test: the capture test file covering offline queueing

**Interfaces:**
- Consumes: Task 1's abort.
- Produces: nothing.

Today `onError` early-returns on `controller.signal.aborted` **before** reaching `handleResolveFailure`, so a cancelled capture is never enqueued. It is the one place Cancel destroys something the user made.

Cancel stops the **waiting**, not the capture. Offline, the photo or voice is queued and resolves later — which is what an offline *timeout* already does, so this makes the two consistent rather than inventing a behaviour.

- [ ] **Step 1: Write the failing tests**

1. Cancelling a photo resolve **while offline** enqueues the capture — asserted on the queue, not on the UI.
2. Cancelling a photo resolve **while online** enqueues nothing. This is the pair that stops the fix over-reaching into the online case, where there is nothing to resolve later.
3. The same pair for voice.

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/mobile && npx jest app/__tests__ --ci --forceExit -t offline`
Expected: FAIL — test 1 finds nothing queued.

- [ ] **Step 3: Implement**

In the photo and voice `onError` handlers, call `handleResolveFailure(error, file, "photo" | "voice")` on the aborted path too, **before** the early return that suppresses UI state. Keep suppressing the UI updates — the user asked for the screen to go idle; they did not ask to lose the photo.

`handleResolveFailure` already decides whether the failure is queueable (it queues on offline/timeout and not otherwise), so the online case needs no extra branch here — but verify that by reading it rather than assuming, and if it would queue an online cancel, gate it.

Add a brief comment explaining that Cancel stops the waiting, not the capture, referencing #136.

- [ ] **Step 4: Run the tests**

Run: `cd apps/mobile && npx jest app/__tests__ --ci --forceExit`
Expected: PASS.

- [ ] **Step 5: Full suite and typecheck**

Run: `cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit`
Report counts.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/capture.tsx apps/mobile/app/__tests__
git commit -m "fix(mobile): keep a cancelled offline capture instead of discarding it"
```

---

## Definition of done

- [ ] `npx tsc --noEmit` clean; `npx jest --ci --forceExit` green.
- [ ] Aborting the controller rejects the in-flight resolve — asserted on the request, not the UI.
- [ ] A different barcode scans immediately after Cancel.
- [ ] The cancelled barcode is suppressed during the cooldown and accepted after it.
- [ ] A cancelled offline capture is queued; a cancelled online one is not.
- [ ] `useResolveBarcode` keeps `networkMode: "always"` and its cache fallback.

## Out of scope

- Any change to `REQUEST_TIMEOUT_MS` or the retry policy.
- Server-side cancellation.
- The voice recorder's own cleanup, which already aborts correctly.
