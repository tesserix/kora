# Queueing typed captures offline

**Issue:** kora#196
**Date:** 2026-08-18
**Status:** design approved, not yet implemented

## Problem

The offline capture queue is media-shaped. Photo and voice captures survive being
offline; typed and barcode captures are dropped.

| Mode | Offline behaviour | Queued? |
|---|---|---|
| Photo | "I've saved that, and I'll identify it as soon as you're back online." | yes |
| Voice | same | yes |
| Typed | "I couldn't reach the server. Check your connection and try again." | **no** |
| Barcode (unseen) | "Scan it again once you're back online." | **no** |

kora#191 already made both remaining messages honest — neither now promises a save
that does not happen — but the capture itself is still lost. From the user's side
"capture" is one feature, and the offline guarantee silently covers half of it.

**Typed is the cheapest thing in the app to queue**: a short string, no media file,
no storage lifecycle, no `CaptureQueueFullError` pressure. It is also the mode a
user falls back to when a photo resolves badly (kora#184 established the index is
98% USDA), which makes it the mode with no safety net and the highest need for one.

## Scope

**In scope:** typed captures.

**Out of scope:** the unseen-barcode path, split into its own issue. Two reasons.
First, an offline barcode that has been *seen before* already resolves from
`src/offline/cachedResolution.ts` and is marked `CACHED_MATCH_TIER` so a cache hit
can never pass as a fresh server answer; only an unseen code is dropped, and its
current copy is honest rather than misleading. Second, a barcode needs a real
scanner, so the path is device-only to verify — and shipping an unverified path is
a failure mode this project has already paid for (see the note on stubbed
`ai.Provider` tests hiding three shipping blockers).

## Constraint: the queue is persisted

`QueuedCapture` is not an internal type. It is the shape of rows in AsyncStorage
under `kora.captureQueue`, and `isValid` (`src/offline/captureQueue.ts`) is a
runtime guard that **silently drops** any row failing it. Rows written by the
shipped build carry `storedName`/`fileName`/`mimeType`.

Any change that stops those rows validating deletes a user's queued photos on
upgrade. This is the binding constraint on the data model below.

## Approaches considered

**A. Extend the existing discriminator — chosen.** `kind` is already the
discriminant (`"photo" | "voice"`), so it gains `"text"` and the type becomes a
union. Old rows validate unchanged because they already carry both a valid `kind`
and their media fields, so there is no migration step at all. The compiler forces
every consumer that switches on `kind` to handle text explicitly, which matters
when the failure mode is "a text row is silently treated as media and dropped".

**B. Optional fields on one flat type.** What kora#196 sketches: `storedName` and
`mimeType` become optional, `phrase` is added. Smallest diff, but every media
consumer must then null-check, and nothing in the type prevents a text row
carrying a `storedName` or a photo row with none. The invariant moves out of the
compiler and into reviewers' heads — rejected for that reason.

**C. A separate text queue.** Leaves the media queue untouched, but the diary,
drain triggers, review screen and any future "N pending" surface must then merge
two sources, and the attempt/backoff/ownership logic is duplicated. kora#144
already records duplicated queue logic as where drift starts. Rejected.

## Design

### 1. Data model

```ts
type Base = {
  id: string; capturedAt: string; mealSlot?: string;
  status: "pending" | "review" | "failed";
  attempts: number; lastError?: string;
  failureKind?: CaptureFailureKind; resolution?: Resolution;
  ownerId: string; queuedAt: string;
};

export type MediaCapture = Base & {
  kind: "photo" | "voice";
  storedName: string; fileName: string; mimeType: string;
};

export type TextCapture = Base & { kind: "text"; phrase: string };

export type QueuedCapture = MediaCapture | TextCapture;

export function hasMedia(c: QueuedCapture): c is MediaCapture;
```

`isValid` checks the base fields, then narrows per arm: a media row must have a
string `storedName`; a text row must have a non-empty `phrase`. A shipped-build
row satisfies the media arm exactly as it does today.

`hasMedia` is the single narrowing helper. Consumers use it rather than
re-deriving `kind === "photo" || kind === "voice"` in five places.

### 2. Capacity

`MAX_CAPTURES = 20` exists for **bytes** — its own comment says so: *"A photo at
quality 0.7 is roughly 1-3 MB, so this bounds queued media at well under 100 MB."*
That rationale does not transfer to a few hundred bytes of text, and applying it
would reject a typed meal while twenty photos occupy the queue.

Media keeps `MAX_CAPTURES = 20`. Text gets `MAX_TEXT_CAPTURES = 50`. `append`
counts per arm. `CaptureQueueFullError` is reused — its copy ("There are too many
captures waiting to be identified. Connect to the internet, or remove one first.")
is true of either arm.

Text is still bounded rather than unlimited: an abandoned-owner queue growing
without limit is a known leak already recorded against the log queue in kora#85,
and this must not add a second instance of it.

### 3. Enqueue

`enqueueCapture(file, kind, mealSlot)` is unchanged for media.

A sibling `enqueueTextCapture(phrase, mealSlot)` resolves the owner (throwing
`NoOwnerError` as today) and appends. It has no `copyIntoQueue` call and needs no
cleanup `try/catch`: the copy-before-append invariant that `enqueueCapture`'s
header comment exists to state has nothing to protect when there is no file, and
a failed append can leak nothing.

`handleSend` (`app/capture.tsx`) routes its `onError` through the same classifier
`handleResolveFailure` uses — `NetworkError`, `AuthTokenError` and `TimeoutError`
queue; anything else is a genuine refusal and keeps today's behaviour of handing
the words back to the composer.

**Consequence, intended.** Today `handleSend` clears `sentPhrase` on failure,
reasoning that *"a message that never arrived should not sit in the thread as
though it did."* Once the phrase is queued it **was** accepted, so the bubble
correctly stays and the composer stays empty. Returning text to the composer for
something that is safely saved would be the misleading state, not the honest one.

### 4. Drain

`resolveCapture` (`src/offline/drainCaptures.ts`) dispatches on `kind`:

- media: today's `buildCaptureForm` + `apiFetchMultipart` path, unchanged
- text: `apiFetch("/v1/resolve/text", { method: "POST", body: JSON.stringify({ phrase }) })`

`apiFetch` is already available from `@/lib/api`, which this module imports, and
`normalizeResolution` already lives in the `resolveWire` leaf module precisely so
the offline layer can use it without inverting the `@/api` → `@/offline`
dependency. No new dependency edge is introduced.

`sourceOf` gains `text → "ai_text"`. It stays typed against `ResolutionSource` so
the compiler, not a human reading `api/internal/metrics/labels.go`, rejects a
value the server would bucket into "other" and corrupt the by-source metric.

Guarded by `hasMedia`:

- the `mediaExists` precondition and its `missing-media` failure
- the `deleteMedia` call after a successful auto-log
- `sweepOrphans`' `keepNames` at its call site, `src/offline/drainTriggers.ts:31`
  (`items.map((i) => i.storedName)`), which must filter to media rows. This is a
  **type-level** fix, not a latent data-loss bug: the map stops compiling once
  `QueuedCapture` is a union, and an `undefined` in the keep-set would in any case
  be harmless because no file on disk is ever named "undefined". Worth stating
  precisely so nobody later "fixes" a bug that was never there.

Everything downstream is untouched: `tier === "auto"` still hands off to the log
queue under a fresh `newLogId()` (never the capture id, which the server cannot
bind into `*uuid.UUID`), and anything else still goes to review.

### 5. Surfaces

`app/capture-review.tsx` renders a photo thumbnail or an audio player. The text
arm renders the phrase itself, so it reads as the thing the user typed rather than
as a caption.

It should be styled **after** `src/components/capture/UserBubble.tsx`, not reuse it
verbatim. `UserBubble` is built for a thread: it is right-aligned
(`justifyContent: "flex-end"`) and springs in with a `FadeInDown` entrance. The
review screen is not a thread and has no sender to align against, so the phrase
should take the bubble's surface treatment — `T.inset` fill, `T.glassBorder`
hairline, the squared corner — while dropping the right alignment and the entrance
animation. If a second surface ends up wanting that same static treatment, extract
the presentation then rather than pre-emptively.

The diary's queued-capture rows show the phrase where a media row shows a
thumbnail.

### 6. Marker comments

Two comments name kora#196 as the thing to revisit and become wrong when this
lands:

- `ottoErrorMessage`'s `TimeoutError` branch in `app/capture.tsx`. This comment is
  additionally **mis-assembled**: the kora#196 parenthetical is spliced into the
  middle of a sentence, splitting *"this function is also"* from *"reached from the
  barcode and typed-text paths"*. Repair the prose as well as the claim — barcode
  remains un-queued, so the branch's reasoning survives in narrowed form.
- `handleSend`'s `onError` comment, which states that a failed text resolve is not
  queued.

## Testing

- **Queue.** A text row validates; a text row with an empty phrase does not; **a
  shipped-build media row still validates** (the upgrade guard, and the most
  important test here). Per-arm caps: 20 media rows do not block a text append,
  and vice versa.
- **Enqueue.** `enqueueTextCapture` writes no file and creates no capture
  directory. `NoOwnerError` still propagates.
- **Drain.** A text row posts to `/v1/resolve/text` with its phrase; never calls
  `mediaExists` or `deleteMedia`; sources as `ai_text`; an auto-tier text
  resolution hands off to the log queue exactly as photo does.
- **Sweep.** `sweepOrphans` keep-names exclude text rows and a queue containing a
  text row does not cause live media to be deleted.
- **Screen.** An offline typed send queues and says so, keeps the bubble, and
  leaves the composer empty. A non-network failure still hands the words back.

## Verification

The typed path is fully simulator-reachable: it needs no camera and no microphone,
which is precisely why it was chosen over barcode. Offline is reproduced by
pointing the dev client at an unreachable API URL; the drain is then exercised by
restoring it.

Note the standing limitation this does **not** escape: no *media* capture can be
created on the simulator (the iOS 26 camera UI renders but its shutter produces no
photo, and voice needs real mic input). The upgrade-guard test above is therefore
the only check that shipped media rows still validate — it cannot be confirmed by
staging a real photo on the simulator, and must not be dropped.

## Out of scope, recorded

- The unseen-barcode path (own issue).
- `app/capture.tsx` is over 1,800 lines against the project's 800 ceiling. kora#111
  recorded it at 1,081, so it has grown substantially and independently. This
  change adds to it; the extraction is its own work.
