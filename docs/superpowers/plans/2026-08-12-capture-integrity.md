# Capture Integrity Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the capture flow losing user data, bricking its own barcode scanner, and printing invented numbers as facts — before any of it is redesigned.

**Architecture:** Six independent fixes to the existing screens, each shippable on its own. No new UI shape, no new dependencies. This is plan 1 of 3 for `docs/superpowers/specs/2026-08-12-kora-capture-otto-design.md`; plan 2 rebuilds the capture shell, plan 3 wires Otto.

**Tech Stack:** Expo SDK 57 / RN 0.86, expo-camera, TypeScript, jest + @testing-library/react-native, Go 1.26 / Gin for the resolve service.

**Spec:** `docs/superpowers/specs/2026-08-12-kora-capture-otto-design.md`

## Global Constraints

- **Do NOT trigger EAS builds.** No `eas build` from any task in this plan.
- No new npm or Go dependencies. If one seems necessary, STOP and ask.
- Capture surfaces are exempt from theming — always dark, via `INSTRUMENT_DARK_FIXED` from `@/theme`. Do not introduce `useTheme()` into capture components.
- Accent `#FF4A00` is for the primary action, over-target and redline states only. No green anywhere.
- **The project invariant:** an unknown value and a real value must never render the same way. A guessed portion is not a measured one.
- Baseline before this plan: `cd apps/mobile && npm test` → 149 suites / 1181 tests passing; `npx tsc --noEmit` clean. Go: `cd api && go test ./internal/resolve/...` passing.
- Existing tests assert some of these defects as intended behaviour. When you change one, say so in the commit body — do not silently delete an assertion.
- Single-line conventional commit messages, no signatures.
- Scope every `git add` to the files the task names — never `git add -A`.

---

### Task 1: Confirm every item in a queued capture

`capture-review.tsx` reads `resolution?.candidates?.[0]` and logs only that one, while the card above it can read "Add 2 items to diary". The rest are discarded when the capture row is deleted. This is live data loss.

**Files:**
- Modify: `apps/mobile/app/capture-review.tsx:126,130,136-170`
- Test: `apps/mobile/app/__tests__/capture-review.test.tsx`

**Interfaces:**
- Consumes: `append as appendLog`, `newLogId` from `@/offline/queue`; `isLoggable` from `@/lib/candidateTier`; `deleteQueuedMedia` from `@/offline/captureMedia`; `discard` from `@/offline/captureQueue`.
- Produces: nothing new — behaviour change only.

- [ ] **Step 1: Write the failing test**

Add to `apps/mobile/app/__tests__/capture-review.test.tsx`, following that file's existing mock setup:

```tsx
test("confirming a two-item capture logs both items", async () => {
  const capture = queuedCaptureFixture({
    resolution: resolutionFixture({
      candidates: [
        candidateFixture({ id: "food-a", name: "Chicken ramen", portion_grams: 350 }),
        candidateFixture({ id: "food-b", name: "Soft boiled egg", portion_grams: 50 }),
      ],
    }),
  });
  mockListCaptures([capture]);

  const { getByLabelText } = await render(<CaptureReviewScreen />);
  fireEvent.press(getByLabelText("Add to diary"));

  await waitFor(() => expect(appendLog).toHaveBeenCalledTimes(2));
  expect(appendLog.mock.calls[0][0]).toMatchObject({ food_item_id: "food-a", quantity_grams: 350 });
  expect(appendLog.mock.calls[1][0]).toMatchObject({ food_item_id: "food-b", quantity_grams: 50 });
});

test("each logged item gets its own fresh log id", async () => {
  const capture = queuedCaptureFixture({
    resolution: resolutionFixture({
      candidates: [candidateFixture({ id: "food-a" }), candidateFixture({ id: "food-b" })],
    }),
  });
  mockListCaptures([capture]);

  const { getByLabelText } = await render(<CaptureReviewScreen />);
  fireEvent.press(getByLabelText("Add to diary"));

  await waitFor(() => expect(appendLog).toHaveBeenCalledTimes(2));
  const idA = appendLog.mock.calls[0][1];
  const idB = appendLog.mock.calls[1][1];
  expect(idA).not.toEqual(idB);
});

// The capture row and its media are the only copy of an unlogged item. They
// must not be destroyed while any item still failed to queue.
test("a partial failure keeps the capture and its media", async () => {
  appendLog.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("queue full"));
  const capture = queuedCaptureFixture({
    resolution: resolutionFixture({
      candidates: [candidateFixture({ id: "food-a" }), candidateFixture({ id: "food-b" })],
    }),
  });
  mockListCaptures([capture]);

  const { getByLabelText } = await render(<CaptureReviewScreen />);
  fireEvent.press(getByLabelText("Add to diary"));

  await waitFor(() => expect(appendLog).toHaveBeenCalledTimes(2));
  expect(deleteQueuedMedia).not.toHaveBeenCalled();
  expect(discard).not.toHaveBeenCalled();
});
```

If `queuedCaptureFixture` / `resolutionFixture` / `candidateFixture` helpers do not already exist in that test file, write them at the top of it as plain functions returning the shapes in `src/api/types.ts` — do not import fixtures from source.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest app/__tests__/capture-review.test.tsx -t "two-item"`
Expected: FAIL — `appendLog` called 1 time, not 2.

- [ ] **Step 3: Write the implementation**

Replace the single-candidate derivation at `capture-review.tsx:126-130`:

```tsx
  const loggable = (resolution?.candidates ?? []).filter(isLoggable);
  // Only a "card" result names food to log — a follow-up question has nothing
  // to hand the log queue, so there is nothing honest for Confirm to do there.
  const canConfirm = resultView === "card" && loggable.length > 0;
```

Replace the body of `handleConfirm`:

```tsx
  const handleConfirm = async () => {
    if (!capture || loggable.length === 0) return;
    setBusy(true);
    try {
      // Queue EVERY item, not just the first. The card above can say
      // "Add 2 items to diary"; logging one and deleting the capture row
      // destroyed the rest with no trace.
      //
      // allSettled, not all: one rejected item must not abandon the ones that
      // already queued, and the outcome list is what decides whether the
      // capture is safe to delete.
      const outcomes = await Promise.allSettled(
        loggable.map((c) =>
          appendLog(
            {
              food_item_id: c.item.id,
              quantity_grams: c.portion_grams,
              meal_slot: mealSlot,
              // The time the photo/recording was TAKEN, never now — a capture
              // confirmed a day late still counts toward the day it was taken.
              logged_at: capture.capturedAt,
              source: sourceOf(capture.kind),
            },
            // A FRESH log id per item, never `capture.id`: the capture queue's
            // key is `cap_<millis>_<rand>` and the server binds this field as
            // `ID *uuid.UUID`, so reusing it 400s — and the log queue treats a
            // 400 as terminal, after the media below is already gone.
            newLogId(),
            capture.ownerId,
          ),
        ),
      );

      const failed = outcomes.filter((o) => o.status === "rejected").length;
      if (failed > 0) {
        // The capture row and its media are the only copy of an item that did
        // not queue. Keep both so the user can retry rather than losing it.
        setBusy(false);
        Alert.alert(
          "Some items didn't save",
          `${failed} of ${loggable.length} couldn't be queued. Your capture is still here — try again.`,
        );
        return;
      }

      await deleteQueuedMedia(capture.storedName);
      await discard(capture.id);
      invalidate();
      qc.invalidateQueries({ queryKey: [QUEUED_LOGS_KEY] });
      router.back();
    } catch {
      setBusy(false);
      Alert.alert("Couldn't confirm that", "Please try again.");
    }
  };
```

Add the import for `isLoggable`:

```tsx
import { isLoggable } from "@/lib/candidateTier";
```

Then delete the now-unused `candidate` binding and update any other reference to it in the file (`canConfirm` is handled above; check the render body for `candidate?.` usages and switch them to `loggable[0]?.` where they are display-only).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/mobile && npx jest app/__tests__/capture-review.test.tsx`
Expected: PASS, including any pre-existing tests in the file.

- [ ] **Step 5: Wire per-row correction**

`capture-review.tsx` passes no `onResolveUncertain` to `ResolutionResult`, so "tap to change" rows are inert on this screen while they work in `capture.tsx`. Pass a handler that opens the same manual-search route the screen already uses for "Search manually", carrying the row index so the correction replaces the right row.

Add a test asserting the row is pressable and routes with the index.

- [ ] **Step 6: Run the full suite**

Run: `cd apps/mobile && npm test`
Expected: 149 suites passing, test count up by your additions, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/app/capture-review.tsx apps/mobile/app/__tests__/capture-review.test.tsx
git commit -m "fix(mobile): log every item when confirming a queued capture"
```

---

### Task 2: Re-arm the barcode scanner after every outcome

`scannedRef` latches on scan and is released only in the error path and in the mode-change handler. After one successful scan the only way to scan again is to switch modes and back — and plan 2 deletes the mode pills, removing that accidental escape hatch entirely.

**Files:**
- Modify: `apps/mobile/app/capture.tsx:1023-1040` (the barcode handler), `capture.tsx:866` (mode-change reset)
- Test: `apps/mobile/app/__tests__/capture-barcode.test.tsx` (create if absent)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — behaviour change only.

- [ ] **Step 1: Write the failing test**

```tsx
test("a second barcode scans after the first one succeeds", async () => {
  const { getByTestId } = await renderCapture({ mode: "barcode" });
  const scanner = getByTestId("barcode-scanner");

  fireEvent(scanner, "onBarcodeScanned", { data: "5000112637922" });
  await waitFor(() => expect(resolveBarcode).toHaveBeenCalledTimes(1));

  fireEvent(scanner, "onBarcodeScanned", { data: "4008400402222" });
  await waitFor(() => expect(resolveBarcode).toHaveBeenCalledTimes(2));
});

// The server answers "not recognized" with a 200 and a follow-up question,
// not an error — so the error path never runs and the scanner stayed latched.
test("an unrecognised barcode does not latch the scanner", async () => {
  resolveBarcode.mockResolvedValueOnce(
    resolutionFixture({ tier: "follow_up", follow_up_question: "Barcode not recognized", candidates: [] }),
  );
  const { getByTestId } = await renderCapture({ mode: "barcode" });
  const scanner = getByTestId("barcode-scanner");

  fireEvent(scanner, "onBarcodeScanned", { data: "0000000000000" });
  await waitFor(() => expect(resolveBarcode).toHaveBeenCalledTimes(1));

  fireEvent(scanner, "onBarcodeScanned", { data: "5000112637922" });
  await waitFor(() => expect(resolveBarcode).toHaveBeenCalledTimes(2));
});

test("a scan is ignored while one is already in flight", async () => {
  let release: () => void = () => {};
  resolveBarcode.mockImplementationOnce(() => new Promise((r) => { release = () => r(resolutionFixture()); }));
  const { getByTestId } = await renderCapture({ mode: "barcode" });
  const scanner = getByTestId("barcode-scanner");

  fireEvent(scanner, "onBarcodeScanned", { data: "5000112637922" });
  fireEvent(scanner, "onBarcodeScanned", { data: "4008400402222" });
  expect(resolveBarcode).toHaveBeenCalledTimes(1);

  release();
  await waitFor(() => expect(resolveBarcode).toHaveBeenCalledTimes(1));
});
```

Give the `CameraView` used for barcodes `testID="barcode-scanner"` so the test can drive it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest app/__tests__/capture-barcode.test.tsx`
Expected: FAIL — second scan never calls `resolveBarcode`.

- [ ] **Step 3: Write the implementation**

Restructure the handler so the latch is released in a `finally`, which is the only construction that cannot miss an outcome:

```tsx
  async function handleBarcodeScanned({ data }: { data: string }) {
    // The latch exists to stop CameraView firing the same barcode dozens of
    // times a second while a resolve is in flight — NOT to make scanning
    // one-shot. It must therefore be released on every terminal outcome:
    // success, failure, and the server's "not recognized" (a 200 with a
    // follow-up question, which is neither).
    //
    // finally, not per-branch resets: the previous version released it only in
    // the error path, so one successful scan disabled the scanner until the
    // user switched modes — and the mode pills are being removed.
    if (scannedRef.current) return;
    scannedRef.current = true;
    try {
      await resolveAndApplyBarcode(data);
    } finally {
      scannedRef.current = false;
    }
  }
```

Keep the existing reset at the mode-change handler — it is harmless and disappears with the mode pills in plan 2.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/mobile && npx jest app/__tests__/capture-barcode.test.tsx`
Expected: PASS, all three.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/app/capture.tsx apps/mobile/app/__tests__/capture-barcode.test.tsx
git commit -m "fix(mobile): re-arm the barcode scanner after every resolve outcome"
```

---

### Task 3: Stop presenting an assumed portion as a measured one

When a food has no serving size the resolve service falls back to 100 g, computes kcal from it, and stamps the result `MatchScore: 1.0`. The client prints an exact figure. This is the same defect class removed from the widgets on 2026-08-12.

**Files:**
- Modify: `api/internal/resolve/handler.go:54,63-64,232-240`
- Test: `api/internal/resolve/handler_test.go`
- Modify: `apps/mobile/src/api/types.ts` (`ResolvedCandidate`)
- Modify: `apps/mobile/src/api/resolveWire.ts` (normalisation)

**Interfaces:**
- Produces: `ResolvedCandidate.portion_assumed?: boolean` — consumed by Task 4 and by plan 2's result sheet.

**IMPORTANT — do not lower `MatchScore`.** `api/internal/resolve/handler.go:240-241` stamps `MatchScore: 1.0` with `MatchTier: nutrition.MatchAlias` and the comment "exact barcode == exact match". That is **correct and must stay**: a barcode is an exact identification of the food. Identity is certain; only the *portion* is assumed. Lowering the score would make every barcode result look doubtful when it is not, and would change how confidence renders across the app.

- [ ] **Step 1: Write the failing Go test**

Add to `api/internal/resolve/handler_test.go`, following the table-driven style already there:

```go
func TestBarcodePortionAssumedWhenServingGramsMissing(t *testing.T) {
	item := nutrition.FoodItem{Name: "Nescafé Mocha", KcalPer100g: 183, ServingGrams: 0}

	got := barcodeCandidate(item)

	assert.True(t, got.PortionAssumed, "a 100g fallback is a guess and must say so")
	// Identity is still exact — a barcode names the food with certainty.
	// Only the portion is assumed, and the two must not be conflated.
	assert.Equal(t, 1.0, got.MatchScore)
	assert.Equal(t, nutrition.MatchAlias, got.MatchTier)
}

func TestBarcodePortionNotAssumedWhenServingGramsPresent(t *testing.T) {
	item := nutrition.FoodItem{Name: "Chicken Ramen", KcalPer100g: 183, ServingGrams: 350}

	got := barcodeCandidate(item)

	assert.False(t, got.PortionAssumed)
	assert.InDelta(t, 350.0, got.PortionGrams, 1e-9)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && go test ./internal/resolve/ -run TestBarcodePortion -v`
Expected: FAIL — `barcodeCandidate` and `PortionAssumed` undefined.

- [ ] **Step 3: Write the Go implementation**

Add the field to `ai.ResolvedCandidate` (in the `ai` package — find its declaration; `handler.go` constructs it at `:236-243`):

```go
	// PortionAssumed reports that no serving size was known for this food and
	// the portion below is a 100g fallback, not a measurement. It is
	// deliberately separate from MatchScore: a barcode identifies the food
	// exactly (score 1.0 is honest), while the portion is still a guess.
	// Collapsing the two would either overstate the portion or understate the
	// match. The client must not render an assumed portion as an exact figure.
	PortionAssumed bool `json:"portion_assumed"`
```

Extract the candidate construction at `handler.go:236-243` into a testable function, so the fallback decision has one home:

```go
// barcodeCandidate builds the single candidate a barcode hit resolves to.
// Extracted from the handler so the assumed-portion rule is testable without
// standing up an HTTP request.
func barcodeCandidate(item nutrition.FoodItem) ai.ResolvedCandidate {
	assumed := item.ServingGrams <= 0
	grams := barcodePortionGrams(item)
	return ai.ResolvedCandidate{
		Item:           item,
		PortionGrams:   grams,
		// Nutrition is row-sourced: kcal = KcalPer100g * (grams/100).
		Kcal:           item.KcalPer100g * grams / 100,
		MatchScore:     1.0,
		MatchTier:      nutrition.MatchAlias, // exact barcode == exact match
		Tier:           ai.TierAuto,
		PortionAssumed: assumed,
	}
}
```

Then call it from the handler in place of the inline literal.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && go test ./internal/resolve/...`
Expected: PASS, including the existing portion tests around `handler_test.go:484`. No existing assertion should need changing — the score is deliberately unchanged.

- [ ] **Step 5: Thread the flag through the client**

In `apps/mobile/src/api/types.ts`, add to `ResolvedCandidate`:

```ts
  /**
   * True when the server had no serving size for this food and fell back to a
   * 100g assumption. The portion is a guess, not a measurement, and must never
   * be rendered as an exact figure without saying so.
   */
  portion_assumed?: boolean;
```

In `src/api/resolveWire.ts`'s `normalizeResolution`, coerce it to a boolean the same way the file already normalises other optional fields, so consumers never branch on `undefined`.

Add a jest test asserting a wire payload with `portion_assumed: true` survives normalisation, and one asserting an absent field normalises to `false`.

- [ ] **Step 6: Run the JS suite**

Run: `cd apps/mobile && npm test && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add api/internal/resolve/handler.go api/internal/resolve/handler_test.go \
        apps/mobile/src/api/types.ts apps/mobile/src/api/resolveWire.ts \
        apps/mobile/src/api/__tests__/resolveWire.test.ts
git commit -m "fix(api): mark an assumed 100g portion instead of scoring it a perfect match"
```

---

### Task 4: Say the portion is a guess

With the flag available, the card must stop printing an assumed portion as fact.

**Files:**
- Modify: `apps/mobile/src/components/capture/DetectedCard.tsx`
- Modify: `apps/mobile/src/components/ResolutionResult.tsx` (`resultSummary`)
- Test: `apps/mobile/src/components/capture/__tests__/DetectedCard.test.tsx`, `src/components/__tests__/ResolutionResult.test.tsx`

**Interfaces:**
- Consumes: `ResolvedCandidate.portion_assumed` from Task 3.

- [ ] **Step 1: Write the failing tests**

```tsx
test("an assumed portion is labelled as a guess on the row", () => {
  const { getByText } = render(
    <DetectedCard {...baseProps} resolution={resolutionFixture({
      candidates: [candidateFixture({ portion_assumed: true, portion_grams: 100 })],
    })} />,
  );
  expect(getByText(/portion is a guess/i)).toBeTruthy();
});

test("a known portion says nothing about guessing", () => {
  const { queryByText } = render(
    <DetectedCard {...baseProps} resolution={resolutionFixture({
      candidates: [candidateFixture({ portion_assumed: false, portion_grams: 350 })],
    })} />,
  );
  expect(queryByText(/guess/i)).toBeNull();
});

test("the summary reflects the weakest row, not the first", () => {
  const summary = resultSummary(resolutionFixture({
    candidates: [
      candidateFixture({ portion_assumed: false }),
      candidateFixture({ portion_assumed: true }),
    ],
  }));
  expect(summary).toMatch(/guess/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && npx jest src/components/capture/__tests__/DetectedCard.test.tsx src/components/__tests__/ResolutionResult.test.tsx`
Expected: FAIL — no guess copy exists.

- [ ] **Step 3: Write the implementation**

In `DetectedCard`, render a hedge on any row whose `portion_assumed` is true — engraved, beneath the row's figures: `portion is a guess`. Use `INSTRUMENT_DARK_FIXED` tokens, `mut` colour, the same engraved treatment the card already uses. Do not use accent; this is information, not an alarm.

In `resultSummary`, when any candidate has `portion_assumed`, append the hedge to the sentence — e.g. `I found 2 items, about 620 kcal — one portion is a guess. Confirm and I'll log it.` Compute from the whole candidate list, never from `candidates[0]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/mobile && npx jest src/components/capture src/components/__tests__/ResolutionResult.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/capture/DetectedCard.tsx \
        apps/mobile/src/components/ResolutionResult.tsx \
        apps/mobile/src/components/capture/__tests__/DetectedCard.test.tsx \
        apps/mobile/src/components/__tests__/ResolutionResult.test.tsx
git commit -m "feat(mobile): say when a detected portion is a guess"
```

---

### Task 5: Give every request a deadline and a cancel

There is no `AbortController` anywhere in `src/lib/api.ts`, no cancel affordance, and the resolve budget reaches ~110s server-side while Istio cuts the connection at 30s. A slow resolve is currently an unescapable wait.

**Files:**
- Modify: `apps/mobile/src/lib/api.ts:136-240`
- Modify: `apps/mobile/app/capture.tsx` (analyzing state gains Cancel)
- Test: `apps/mobile/src/lib/__tests__/api.test.ts`, `apps/mobile/app/__tests__/capture.test.tsx`

**Interfaces:**
- Produces: `apiFetch(path, init)` and `apiFetchMultipart(path, form)` accept an optional `signal` on `init`, and time out on their own after `REQUEST_TIMEOUT_MS`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a request that outlives the deadline rejects as a timeout", async () => {
  jest.useFakeTimers();
  (global.fetch as jest.Mock).mockImplementation(() => new Promise(() => {}));
  const promise = apiFetch("/v1/slow");
  jest.advanceTimersByTime(REQUEST_TIMEOUT_MS + 1);
  await expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
  jest.useRealTimers();
});

test("an aborted request rejects and does not resolve later", async () => {
  const controller = new AbortController();
  (global.fetch as jest.Mock).mockImplementation((_u, init) =>
    new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(abortError()))),
  );
  const promise = apiFetch("/v1/slow", { signal: controller.signal });
  controller.abort();
  await expect(promise).rejects.toBeTruthy();
});

test("the client deadline is below the gateway's 30s cut-off", () => {
  expect(REQUEST_TIMEOUT_MS).toBeLessThan(30_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && npx jest src/lib/__tests__/api.test.ts -t timeout`
Expected: FAIL — `REQUEST_TIMEOUT_MS` not exported.

- [ ] **Step 3: Write the implementation**

In `src/lib/api.ts`:

```ts
// Below Istio's 30s connection cut-off on purpose. The resolve service's own
// budget reaches ~110s (photo 20s + fallback 90s), so without a client
// deadline the app waits on a socket the gateway has already closed — which is
// why voice resolution appeared to hang rather than fail.
export const REQUEST_TIMEOUT_MS = 25_000;
```

Wrap the existing `fetch` call so it composes the caller's `signal` (if any) with an internal timeout signal, and clears the timer in a `finally` so a fast response does not leave a pending timer. Use `AbortSignal.any([...])` if available in this RN version — check `node_modules/react-native` typings first; if it is not, compose manually with an `AbortController` and an `abort` listener. Never swallow the abort: it must reject.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/mobile && npx jest src/lib/__tests__/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Add Cancel to the analyzing state**

In `capture.tsx`, hold an `AbortController` for the in-flight resolve, pass its signal through the resolve call, and render a Cancel control in the analyzing state that aborts it and returns to idle. Abort on unmount and on leaving the screen too.

Add a test asserting Cancel aborts and returns the screen to idle.

- [ ] **Step 6: Run the full suite**

Run: `cd apps/mobile && npm test && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/lib/api.ts apps/mobile/src/lib/__tests__/api.test.ts \
        apps/mobile/app/capture.tsx apps/mobile/app/__tests__/capture.test.tsx
git commit -m "fix(mobile): time out and cancel in-flight resolve requests"
```

---

### Task 6: Remove the controls that lie, and offer a way out of a denied permission

Three controls render as interactive and do nothing, and a denied camera or microphone permission is a dead end.

**Files:**
- Modify: `apps/mobile/app/capture.tsx:261-274` (fake voice mic), `:319-331` (fake barcode placeholder and its fake scan line), `:341-345` (hardcoded example bubble), `:442-456` (no-op photo-library button)
- Test: `apps/mobile/app/__tests__/capture-permissions.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `Linking.openSettings` from `react-native`.

- [ ] **Step 1: Write the failing tests**

```tsx
test("a denied camera permission offers a route to Settings", async () => {
  const { getByText } = await renderCapture({ cameraPermission: "denied" });
  fireEvent.press(getByText("Open Settings"));
  expect(Linking.openSettings).toHaveBeenCalled();
});

test("a denied camera permission still offers a way to log", async () => {
  const { getByText } = await renderCapture({ cameraPermission: "denied" });
  expect(getByText(/describe it/i)).toBeTruthy();
});

// The placeholder drew a scan line, so a screen that could not scan looked
// like it was scanning.
test("the denied barcode state does not render a scan line", async () => {
  const { queryByTestId } = await renderCapture({ cameraPermission: "denied", mode: "barcode" });
  expect(queryByTestId("scan-line")).toBeNull();
});

test("no control renders without an action", async () => {
  const { queryByLabelText } = await renderCapture({});
  expect(queryByLabelText("Photo library")).toBeNull();
});
```

Give the real scan line `testID="scan-line"` so the assertion is meaningful.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/mobile && npx jest app/__tests__/capture-permissions.test.tsx`
Expected: FAIL — no "Open Settings" text; "Photo library" still present.

- [ ] **Step 3: Write the implementation**

Delete the no-op photo-library button entirely — including its `accessibilityElementsHidden` wrapper, which exists only to hide a control that should not be there.

Delete the decorative 72pt voice mic and the barcode permission placeholder with its fake scan line.

Delete the hardcoded example `UserBubble` in Type mode — an example message indistinguishable from a real one.

Replace the denied-permission states with a single component: a short explanation, an `Open Settings` primary button calling `Linking.openSettings()`, and a secondary "Describe it instead" that switches to text entry. Mirror the pattern already used for the notification-permission denial elsewhere in the app — find it and follow it rather than inventing a second style.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/mobile && npx jest app/__tests__/`
Expected: PASS. Some existing capture tests assert the deleted controls exist — update them and record the reason in the commit body.

- [ ] **Step 5: Run the full suite**

Run: `cd apps/mobile && npm test && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/capture.tsx apps/mobile/app/__tests__/
git commit -m "fix(mobile): remove dead capture controls and offer a route out of denied permissions"
```

---

### Task 7: Verify on the simulator

Nothing above has been seen on screen. Jest cannot catch clipping, contrast, or a gesture that does not fire.

- [ ] **Step 1: Boot and run**

Boot **iPhone 17 Pro** (never Pro Max). Start the local API and Metro, install the dev client, sign in.

- [ ] **Step 2: Walk the fixed paths**

Verify and screenshot:
- Scan a barcode, then scan a **second** one without leaving the screen — both resolve.
- Scan an unrecognised barcode, then a valid one — the second still resolves.
- A multi-item capture confirmed from the review screen lands **every** item in the diary.
- A row with an assumed portion says so, and the summary hedges.
- Cancel during analyzing returns to idle and does not later apply a result.
- Deny camera permission in the simulator's settings → the screen offers Open Settings and a way to describe the meal.

- [ ] **Step 3: Record the outcome**

Append a Verification section to `docs/superpowers/specs/2026-08-12-kora-capture-otto-design.md` recording each check as passed or failed, with the date.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-12-kora-capture-otto-design.md
git commit -m "docs: record capture integrity verification"
```

- [ ] **Step 5: Stop**

**Do NOT run `eas build`.** The user will request a build explicitly.

---

## Notes for the implementer

- `apps/mobile/ios/` and `android/` are gitignored prebuild artifacts. Never commit them.
- When a test you did not write starts failing, read it before changing it. Several encode the defects this plan removes — changing them is correct, but must be deliberate and recorded.
- Capture components use `INSTRUMENT_DARK_FIXED`, not `useTheme()`. Follow the file you are editing.
