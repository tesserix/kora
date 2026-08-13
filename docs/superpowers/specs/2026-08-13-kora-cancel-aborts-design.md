# Cancel actually aborts (#136)

Design for #136 — deferred from the capture-integrity branch (`b2a2add`).
Three defects, one root cause: **the abort signal never reaches the network
layer.**

`app/capture.tsx` holds an `AbortController` per in-flight resolve, but the four
resolve hooks in `src/api/hooks.ts` never receive its signal. Cancel is a purely
local cancellation token — it returns the UI to idle and stops a late response
writing state, but the socket keeps running until it completes or the 25s
`REQUEST_TIMEOUT_MS` fires.

The plumbing already exists below the hooks: `apiFetchEnvelope` takes
`init.signal` (`src/lib/api.ts:344`) and `apiFetchMultipart` takes `{ signal }`
(`:376`). Only the hook layer is missing.

## Why it matters

Every Cancel still burns bandwidth and **server AI budget** — photo and voice
are the expensive paths, and per-user AI caps now exist (#81), so an abandoned
resolve eats a real user's allowance.

## Decisions

| Question | Decision |
|---|---|
| How does the signal reach the hook? | The mutation **variables become an object** carrying it |
| Barcode re-arm after Cancel | **Suppress that specific code briefly**; a different code scans instantly |
| Cancelling an offline capture | **Preserve it** — enqueue anyway |

### Why the variables become an object

React Query's `mutationFn` receives exactly one argument, so a signal can only
arrive as part of the variables. Each resolve mutation's variables therefore go
from a raw value to `{ input, signal }`.

This is what makes the change larger than it looks: pinned
`toHaveBeenCalledWith(rawValue, …)` assertions across `hooks.test.tsx`,
`resolve-upload-multipart.test.tsx` and the `capture-*.test.tsx` files assert
the old shape. That blast radius is why the issue was deferred rather than
fixed inline — it is mechanical, not risky, but it is not small.

### Why the barcode latch needs its own guard

`scannedRef` exists because `CameraView` fires `onBarcodeScanned` **dozens of
times a second while a code is in frame** (`capture.tsx:1254-1256`). Today the
latch stays up until the abandoned resolve settles — up to 25s of a live camera
silently ignoring scans.

**Fixing the abort makes this worse before it makes it better.** Once the
request truly aborts, `onError` fires at once with an `AbortError` and the latch
releases immediately — with the same barcode still in frame, which would
instantly start a new resolve and defeat Cancel entirely.

So the fix is: on cancel, remember the barcode value that was cancelled and
ignore **only that value** for a short cooldown. A different barcode scans
immediately. Re-presenting the same one after the cooldown works. Cancel means
"stop this", not "stop scanning".

The naive alternative — resetting the latch in `handleCancelResolve` — is
explicitly worse and is called out in the issue.

### Why a cancelled offline capture is preserved

Today `onError` returns before `handleResolveFailure`, so a cancelled capture is
never enqueued. It is the one place Cancel destroys something the user made, and
it is not signposted.

Cancel stops the **waiting**, not the capture. Offline, the photo or voice is
queued and resolves later — which is exactly what an offline *timeout* already
does, so this makes the two consistent rather than inventing a behaviour. If the
user genuinely did not want it, the queued item can be deleted; the reverse
(recovering a discarded capture) is impossible.

## Scope

1. **`src/api/hooks.ts`** — the four resolve hooks (`useResolveText`,
   `useResolveBarcode`, `useResolvePhoto`, `useResolveVoice`) take
   `{ input, signal }` and pass the signal to `apiFetch`/`apiFetchMultipart`.
2. **`app/capture.tsx`** — every `mutate()` call site passes the controller's
   signal.
3. **`app/capture.tsx`** — `handleCancelResolve` records the cancelled barcode
   value; `handleBarcodeScanned` ignores that value during the cooldown.
4. **`app/capture.tsx`** — a cancelled offline photo/voice capture is enqueued
   rather than dropped.
5. **Tests** — update the pinned assertions to the new variable shape.

## Testing

Per the #110 lesson, assertions check for the **presence** of the new behaviour
rather than matching a state that would also hold if nothing ran.

- **The abort reaches the network.** Assert the signal passed to
  `apiFetch`/`apiFetchMultipart` is the controller's, and that aborting it
  rejects the in-flight request. The acceptance criterion is explicit that this
  must be verified by the request not reaching the server — **not** by the UI
  returning to idle, which already happens today and would pass against the
  unfixed code.
- **Cancel then rescan a different barcode** works immediately.
- **Cancel then re-present the same barcode** is ignored during the cooldown and
  accepted after it. Both halves — a suppression with no expiry is its own bug.
- **A cancelled offline capture is enqueued**, asserted on the queue rather than
  on the UI.
- **A cancelled online capture is not enqueued** — the pair that stops the fix
  from over-reaching.

Suites must stay green: `cd apps/mobile && npx tsc --noEmit && npx jest --ci
--forceExit`. Baseline 174 suites / 1429 tests.

## Acceptance (from #136)

- Cancel aborts the in-flight request, verified by the request never reaching
  the server.
- Scanning a second barcode immediately after Cancel works.
- Cancelling a capture either preserves it or says plainly it is discarded —
  here, **preserves**.

## Out of scope

- Any change to `REQUEST_TIMEOUT_MS` or the retry policy.
- Server-side cancellation. Aborting the client request is what stops the
  billable work from being awaited; whether the server keeps computing after the
  client disconnects is a separate question.
- The voice recorder's own cleanup, which already aborts correctly.
