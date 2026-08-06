# Design — offline capture queue (#22 slice 2)

Date: 2026-08-06. Touches `apps/mobile` only — no API change, no migration.
Follows `2026-08-02-offline-queue-design.md` (slice 1, shipped and verified).

**Status: designed with the user on 2026-08-06.** The three product decisions
below (resolve UX, day semantics, failure UX) were made in conversation, not
inferred. The architectural choice and every constraint marked "call" are mine;
they are flagged as such so a reviewer can overturn them knowing they were not
the user's.

## Purpose

Slice 1 made barcode, manual and previously-seen foods log fully offline. It
queues an **already-resolved log** (`CreateLogInput`) and drains it by POSTing
`/v1/logs`.

Photo and voice cannot work that way: they need AI to become a log at all. This
slice queues the **unresolved capture** — the media file plus when it was taken
— and resolves it when connectivity returns.

This was blocked on #82 (React Native rejected the `{uri,name,type}` FormData
part, so photo and voice had never worked at all). #82 is closed, which is what
unblocks this.

### Not to be confused with the failed-capture explorer

`2026-08-05-kora-failed-capture-explorer-design.md` is an **operator** surface
in tesserix-home for server-side AI failures. This document is a **user-facing**
mobile surface for a capture that could not be resolved on the user's own
device. Different audience, different data, no overlap. Both can exist.

## The three decisions taken with the user

1. **A resolved capture routes by confidence tier, reusing #21.** `tier: "auto"`
   logs straight into the diary; `confirm` and `follow_up` wait for review. One
   mental model with the online path.
2. **A capture is stamped at CAPTURE time, always.** Monday's dinner counts to
   Monday even when it resolves Tuesday. A completed day can therefore change
   retroactively; that was accepted deliberately, because the alternative
   (stamping at resolve time) puts wrong data in the record and corrupts the
   pattern-over-time signal the coach (#51) is built on.
3. **A permanently failed capture is kept, with its photo, and offers manual
   logging** seeded with the capture time. Not discarded. The user's memory of
   the meal survives the AI's failure.

### One honest deviation, accepted knowingly

Online, `tier: "auto"` is **one-tap**, not zero-tap: the UI pre-selects the
result and the user still taps to accept (`ai/types.go:52` — `>= 0.90 one-tap`).
Deferred, nobody is present to tap, so auto-logging is strictly **more
permissive** than the online path. This follows from decision 1 and the user
signed off on it with that stated. #20's correction loop is the safety net.

If this later proves wrong, the lever is to demote `auto` to the review bucket
for deferred captures only — a one-line change in the routing, not a redesign.

## Architecture

Four new files beside the existing ten in `src/offline/`. `lock.ts`, `owner.ts`,
`connectivity.ts` and `drainTriggers.ts` are reused **unchanged**.

| File | One job |
|---|---|
| `captureQueue.ts` | Persist `QueuedCapture`. Own AsyncStorage key, own lock. |
| `captureMedia.ts` | Copy media into `documentDirectory`, delete it, sweep orphans. |
| `drainCaptures.ts` | media → resolved capture. Never calls `/v1/logs`. |
| `useQueuedCaptures.ts` | Diary rows for pending / review / failed captures. |

### One extraction, required by the work rather than drive-by

A review row needs the same "here is what the AI thinks — confirm, correct, or
answer a follow-up" UI the live capture flow already has. That UI is currently
**inside `app/capture.tsx`, which is 1,134 lines** — already past this project's
800-line ceiling. Adding a second entry mode to it would make the largest file
in the app larger, and it is the file #82 lived in.

So `resolveResultView`, `resultSummary`, the candidate list and the follow-up
prompt move to `src/components/ResolutionResult.tsx`, consumed by both the live
capture screen and the new review surface. This is scoped to what the review
surface needs — not a general refactor of `capture.tsx`.

**This extraction is behaviour-preserving and must be proven so**: land it as its
own commit with the existing capture tests green *before* the review surface is
built on top, so a regression in the live path cannot hide inside new-feature
work.

### Why a separate queue rather than a `kind` union on `QueuedLog`

Considered and rejected: widening `QueuedLog` to
`{kind:"log"} | {kind:"capture"}`. One queue would give strict drain ordering
between a manual log and a photo taken a minute apart.

That ordering buys little — these are independent meals, not a sequence — and
the cost is real: the drain becomes a two-stage pipeline (resolve, *then* log)
with different failure semantics per stage, every existing `QueuedLog` consumer
must narrow, and the riskiest new logic lands inside the file slice 1's
correctness depends on. Slice 1 is shipped and verified; this design does not
modify it.

The separate queue instead **hands off**: a resolved capture is appended to the
existing log queue, which delivers it exactly as it does today. `drainCaptures`
never learns what `/v1/logs` is.

Accepted cost: two storage keys, two drains, no ordering guarantee between them,
and some attempts/retry logic common to both. If the duplication becomes real
rather than superficial, extract a shared core — do not merge the queues.

### The row

```ts
type QueuedCapture = {
  id: string;
  kind: "photo" | "voice";
  mediaPath: string;       // documentDirectory-relative, NEVER a cache URI
  fileName: string;
  mimeType: string;
  capturedAt: string;      // ISO. Becomes the log's logged_at (decision 2).
  mealSlot?: string;       // what the user chose at capture time
  status: "pending" | "review" | "failed";
  attempts: number;
  lastError?: string;
  resolution?: Resolution; // set when status === "review"
  ownerId: string;         // required, unlike slice 1's optional field
  queuedAt: string;
};
```

`ownerId` is **required** here. Slice 1 left it optional only to tolerate rows
persisted before ownership existed; no such rows can exist for this new queue,
so the weaker type would be a lie.

## Data flow

1. Capture offline → copy media into `documentDirectory` → append (`pending`) →
   the diary shows a row at **`capturedAt`** carrying a thumbnail and
   `kcal: null`. `useQueuedLogs.toRow` already renders that as "—", so the
   macro-less state is not new.
2. Reconnect → `drainTriggers` fires `drainCaptures` (same triggers as slice 1).
3. `POST /v1/resolve/photo` or `/v1/resolve/voice`, multipart, per pending row
   owned by the current uid.
4. `tier: "auto"` → append to the **log queue** with `logged_at = capturedAt` →
   delete media → drop the capture row. Slice 1's drain delivers it.
5. `confirm` / `follow_up` → `status: "review"`, store the resolution and any
   `follow_up_question`, keep the media.
6. Tapping a review row in the diary opens `ResolutionResult` (the component
   extracted above) seeded with the stored resolution. Confirming appends to the
   log queue → deletes media → drops the row. Rejecting discards the capture.
   A `follow_up` row shows its stored question here, answered the same way the
   live flow answers it.
7. Permanent failure → `status: "failed"`, **keep the media**. Tapping the row
   opens manual entry seeded with `capturedAt` and the thumbnail.

## Error handling

Slice 1's verdict logic is reused **verbatim**, including its subtlety: a
failure carrying **no** HTTP status never got a verdict from the server, so it
must not count as a delivery attempt. Only that distinction stops a tunnel or a
captive portal from burning the attempt budget.

- 4xx except 401 → permanent. 401 → does not count (token refresh will retry).
- Attempts exhausted → `failed`. Never discarded (decision 3).
- **"The AI could not identify it" is a SUCCESSFUL resolve with no result**, and
  is terminal `failed` — not a retryable error. Conflating the two retries
  forever against a photo of a wall, spending real Gemini budget each time.
- **Media missing at drain time** (OS purge, user cleared data, a bug) →
  `failed` with a distinct message. It must not throw: an unhandled error here
  takes down the whole drain pass and strands every other queued capture.
- Ownership gating identical to slice 1 — never drain another user's row.

## Storage discipline

`ImagePicker` returns a **cache-directory** URI, which iOS may purge under
storage pressure. #22's acceptance criterion is *"no data loss across app
restart while items are queued"*, so a queued capture must copy its media into
`documentDirectory`. Getting this wrong makes the feature appear to work in
testing and lose data in the field, which is the worst available outcome.

- **Cap: 20 captures** (my call, not the user's). Past the cap, refuse the new
  capture with a clear message rather than silently evicting the oldest —
  silently discarding a meal the user believes is saved is the exact failure
  this feature exists to prevent.
- Delete media on success, on discard, and on discard-after-failure.
- **Orphan sweep on app start**: any file in the capture media directory with no
  corresponding queue row is deleted. Without it, every crash between "file
  written" and "row appended" leaks megabytes permanently.

At `quality: 0.7` a photo is roughly 1–3 MB, so the cap bounds this at well
under 100 MB worst case.

## Testing

This codebase has a documented, repeated failure mode: **green tests that never
execute the path they name.** Slice 1 shipped fourteen green offline tests, every
one of which ran with `onlineManager` reporting **online** — the feature was dead
in its only real condition. #82 shipped broken because its tests mocked the
transport, so `FormData.append` never ran.

Therefore, binding on this slice:

- Every offline test runs with the app **genuinely offline**. A test that
  asserts offline behaviour while online proves nothing and must be treated as a
  failing test, not a passing one.
- **The resolve transport is NOT mocked.** A test whose fix also mocks the
  transport reproduces #82 exactly.
- Every assertion is **mutation-verified**: break the behaviour the test names,
  confirm it fails *on that test's own assertion*, revert, confirm `git diff` is
  clean. Reason backward from "what implementation would make this pass while
  broken?" — never forward from the implementation.
- Media durability is verified across an actual app restart, not by asserting
  that a copy function was called.

## Open questions

- **Interaction with #84** (device-local day vs server profile timezone).
  Decision 2 stamps `logged_at = capturedAt` from the device. If the server
  buckets by profile timezone, a capture near midnight can land on a different
  day than the diary showed while it was pending. This slice does not resolve
  #84; it inherits it. Worth confirming the pending row and the delivered log
  agree on the day before calling this done.
### Resolved by me, overturnable

- **Voice has no thumbnail.** Decision 3's "show the photo" has no equivalent for
  a failed voice capture. **Decision: show the recording's duration and capture
  time, with playback.** The point of decision 3 is that the user's own record of
  the meal survives the AI's failure; for voice, their words are that record, so
  playback is the direct analogue of showing the photo.
- **A review row does NOT count toward day totals.** It has a resolution and
  therefore macros, but the user has not accepted it. It renders like a pending
  row ("—") until confirmed. This keeps a single, defensible invariant: **day
  totals contain only data the user accepted, or that the AI was ≥ 0.90 confident
  of.** The alternative — counting unconfirmed macros — would make totals move
  when the user *rejects* a suggestion, which reads as a bug.

Both are my calls, not the user's. Either can be overturned without touching the
architecture.
