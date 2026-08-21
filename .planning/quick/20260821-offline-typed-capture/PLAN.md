---
quick_id: 260821-otc
slug: offline-typed-capture
date: 2026-08-21
refs: kora#242, kora#243, kora#196, kora#136, kora#191, kora#241
---

# Two offline typed-capture bugs from #196's branch review

Fixes #242 and #243. Both are in `app/capture.tsx`'s `handleSend`, both were
found by the whole-branch review of #196, and both are cases where the **typed**
path disagrees with a rule that already exists elsewhere.

Deliberately NOT #241 — see "Out of scope" below.

## 1. Cancelling an offline typed resolve loses the phrase (#242)

`handleCancelResolve` clears `sentPhrase` and aborts the controller.
`handleSend`'s `onError` then returns at `if (controller.signal.aborted) return;`
**before** reaching the recoverable-error classifier #196 added, so
`enqueueTextCapture` is never called. The words are gone from the thread and the
composer.

The media path deliberately does the opposite, and says why (capture.tsx, photo
`onError`):

> Cancel stops the WAITING, not the capture (#136 task 3): route the failure
> through the same classifier the non-cancelled path uses rather than destroying
> the photo the user just took.

**The fix is to mirror that, and the mechanism already exists.** Move the abort
guard so a cancelled typed failure still reaches the classifier, and suppress
only the reassurance copy — Cancel already took the screen to idle and does not
also get to raise a fresh bubble about the request it just stopped.

**The third acceptance criterion falls out for free, and must not be
re-implemented.** "A cancelled ONLINE typed resolve still queues nothing" needs
no connectivity check: an online Cancel arrives as `CancelledError`, which is
none of `NetworkError` / `AuthTokenError` / `TimeoutError`, so the existing
classifier already declines to queue it. The photo path's comment states this
outright. Do not add a connectivity snapshot.

`onSuccess`'s abort guard stays exactly as it is — applying a result after
cancel would resurrect it onto a screen that said it was abandoned.

## 2. A 1-character phrase queues, then fails permanently (#243)

The server requires >= 2 characters (`api/internal/resolve/handler.go:115`). The
client accepts 1: `handleSend` only trims (`if (!phrase) return;`), and
`isValid` accepts `phrase.length > 0`.

So a 1-character phrase typed offline is queued, drains later, 400s, and is
marked permanently `failed`. Online the outcome is unchanged — it already fails
the same server rule — but #196 turned that from an error bubble that scrolls
away into a **persisted failed row the user has to deal with**.

Fix: make the client agree with the server at the point of send, so a
1-character phrase never enters the queue. Prefer making the rule **visible**
(the send affordance is unavailable below the threshold) over enforcing it after
the fact — check how send is currently gated and keep that mechanism.

**Do NOT tighten `isValid`.** The issue is explicit: that would silently drop
already-queued single-character rows on upgrade, which is the failure mode
#196's design went out of its way to avoid. `isValid` is the *upgrade* contract,
not the *entry* rule, and the comment at captureQueue.ts:51 says so.

Derive the constant from the server's rule and name it, rather than typing a
bare `2` at the call site.

## Out of scope — #241, and why

#241 (unseen barcode scanned offline is dropped) is the other half of #196 and
is NOT in this task.

- It **cannot be verified here.** A barcode needs a real scanner;
  `CameraView`'s `onBarcodeScanned` only fires continuously on hardware and the
  simulator cannot produce one. The issue says shipping it would mean shipping
  an unverified path.
- It carries three **product decisions**, not just plumbing: what the user is
  told in place of "scan it again"; how the diary presents a queued row whose
  only content is an EAN nobody recognises; and what happens when the same
  unknown code is scanned three times offline.

It also is not urgent in the way these two are: #191 already made its copy
truthful, so it is a lost scan with honest messaging, not silent data loss.

## Tests

Extend the existing capture tests. Pin, per issue acceptance:

- cancelling an OFFLINE typed resolve enqueues the phrase
- no reassurance bubble on that path (matching photo/voice)
- cancelling an ONLINE typed resolve enqueues **nothing** — and assert this goes
  through the classifier, not a connectivity branch
- a non-cancelled offline failure still queues exactly as before (no regression
  on #196's path)
- a 1-character phrase never reaches the queue
- a 2-character phrase does
- `isValid` still accepts an already-queued 1-character row (the upgrade
  contract #196 protects)

## Verification

`capture` is in the golden set at `medium`, so any visible change to the send
affordance moves a golden and needs a deliberate re-capture.

Jest performs no layout and cannot see a disabled-button style — see the blind
spot note now at the reanimated mock in `jest.setup.js` (#257).
