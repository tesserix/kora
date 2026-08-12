# Capture and Otto — camera first, conversation underneath

**Date:** 2026-08-12
**Status:** Approved direction
**Design language:** `docs/superpowers/specs/2026-08-11-kora-instrument-glass-design.md`
**Audit:** full findings in the brainstorm session; every claim below cites `file:line`.

## Direction

`capture.tsx` today is a food-logging pipeline dressed as a conversation. It is
titled "Ask Otto", greets you in chat bubbles, and cannot be asked anything.
Meanwhile `api/internal/coach/` — grounded Q&A with citations, ED-risk
guardrails, budget metering and persisted threads — is finished and has **no
mobile client at all**.

This redesign makes both halves honest:

- **The camera becomes the screen**, not a message inside a scrolling transcript.
- **Swiping the camera down reveals Otto**, wired to the coach that already exists.
- **Guesses say they are guesses**, instead of being printed as exact numbers.

Logging must not get slower. It is the highest-frequency action in the app;
asking is occasional. Camera is the default state on every open.

## Decisions

| Decision | Choice | Rejected |
| --- | --- | --- |
| Shape | One screen, two states: camera (default) → swipe down → thread | Separate Otto destination; conversation-first with a camera attachment |
| Modes | **Deleted.** Camera auto-detects barcode vs food; words go to the chat | Keeping the four mode pills |
| Result | Sheet over the still-live frozen frame | Replacing the viewfinder (today's behaviour) |
| Text intent | Otto infers log-vs-ask, with a one-tap correction either way | Explicit "+" button for food; asking the user every time |
| Otto's memory | Recent turns fed back for conversational reference; **every number still from the freshly-computed deterministic context** | Stateless (follow-ups fail); full memory (weakens grounding) |
| Unknown portion | Stated out loud + `Fix portion` | Silent 100 g assumption stamped as a perfect match |

Out of scope: onboarding (its own brainstorm), the Trends/Home surfaces, and any
change to the resolve model itself.

## Screen shape

### Camera state — default on open

Full-bleed `CameraView`, **not inside a `ScrollView`**. Reticle corners and the
accent scan line stay per the Instrument Glass spec. One shutter. Close button.
A grabber at the top with "swipe down to ask Otto".

Barcode scanning runs continuously while this state is visible: a barcode in
frame resolves immediately with no shutter and no mode; anything else is a food
photo on shutter.

**Gesture risk:** a downward swipe near the top edge competes with iOS Control
Centre. The gesture originates from the grabber and upper-middle of the
viewfinder, and tapping the grabber is the reliable fallback. Verify on device
early — the whole shape rests on this interaction.

### Thread state

Camera collapses to a peek strip that can be pulled back down. Composer: text
field, mic, and a camera button. Thread loads from `GET /v1/coach/thread`.

### Why modes go

`mode` (4 values) × `stage` are two independent axes with no explicit state
machine (`capture.tsx:778-781` derives `analyzing` from `isPending`), and they
are not even exclusive — Photo mode also renders a text field and Send that logs
as `ai_text` (`capture.tsx:411`). There is no `result → idle` transition except
changing mode. Two states with one transition replace eight ambiguous
combinations.

## Camera behaviour

**Barcode re-arm.** `scannedRef` is set on scan (`capture.tsx:1023-1024`) and
released in only two places: the error path (`capture.tsx:1035`) and the
mode-change handler (`capture.tsx:866`). It is never released on success — so
after one successful scan the only way to scan again is to switch modes and back.
The server's "Barcode not recognized" is a `200` with a follow-up, not an error,
so an unrecognised item latches it too.

**This gets worse under this redesign, not better:** deleting the mode pills
removes `capture.tsx:866`, the accidental escape hatch. The guard must be rebuilt
to latch during an in-flight resolve and release on **every** terminal outcome —
success, failure, and not-recognised alike.

**Timeouts and cancel.** There is no `AbortController` anywhere in
`src/lib/api.ts`, no cancel affordance, and the server budget reaches ~110 s
(photo 20 s + fallback 90 s, `router.go:18,27`). Voice is already broken
end-to-end at Istio's 30 s timeout (`resolveWire.ts`). Add a client timeout below
the gateway's, an `AbortController` wired to both an explicit Cancel and to
leaving the state, and an honest failure message.

**Permission recovery.** Denial is terminal everywhere — there is no
`Linking.openSettings` in this flow. Worse, the denied-barcode placeholder draws a
*fake scan line* (`capture.tsx:319-331`), so it looks functional. Delete the
placeholder; denial gets an explanation, an Open Settings button, and a
"Describe it instead" route into the thread.

**Retake.** The camera stays live under the result sheet, so retaking costs one
gesture and loses nothing.

**Offline.** The queue is currently one transient bubble with no count or list;
only the diary shows the truth. The thread carries a persistent, countable queued
row that resolves when the drain succeeds.

## Otto

Wired to `POST /v1/coach/ask`, `GET /v1/coach/thread`, `GET /v1/coach/nudges` —
none of which have a mobile client today.

**Citations are rendered.** The backend already returns `citations` as
label/value facts on both `ask` and `thread`. They appear as chips beneath each
answer. This is what makes Otto checkable rather than merely fluent, and it costs
nothing but display.

**Intent inference.** A food phrase returns a log card; a question returns an
answer. Each carries the opposite affordance ("No, answer it" / "Actually, log
that"), so a misfire is one tap, never a dead end and never a silent wrong log.

**Composite meals are first-class.** A described meal is usually several foods:
*"nescafé mocha sachet with a high-protein lite meal"*. `/v1/resolve/text`
already returns a `candidates` array and Otto's own copy ("I found 3 items")
proves multi-item resolution works server-side — it is the client that collapses
it. The log card is therefore **multi-row**: one row per component, each with its
own editable portion and kcal, a running total, per-row remove, and a single
`Log it` that writes every row as its own food log.

Otto decomposes **only what was said**. If a phrase names two foods, two rows
appear. Unstated components — the milk in a mocha, the oil in a stir-fry — are
not invented; where a product's own data already accounts for them, that is the
row's nutrition, not an extra row. A missing item is added by saying so. This
keeps the resolve model unchanged and keeps every number traceable to something
the user actually said.

**Logged meals become turns.** A meal logged from the camera or the chat posts
into the thread with its card. The thread becomes the day's record, which is what
makes "was that a lot of carbs?" resolve naturally.

**Follow-ups without losing the guarantee.** Recent turns are fed back for
conversational reference only. Every number Otto states still comes from the
freshly-computed deterministic `Context`. `qaSystemPrompt` (`service.go:17-27`)
is written for a stateless call and **must be rewritten to state this explicitly** —
quietly handing it history is precisely the change that lets invented numbers in.
Citations remain the enforcement mechanism: a figure with no backing fact is a
detectable bug.

**Guardrails are respected, not reimplemented.** `show_support` surfaces a
supportive resource whenever set. Suppressed answers return replacement text and
are rendered as-is. Budget exhaustion and an unconfigured provider return
graceful copy (`service.go:29-36`) and render as Otto being briefly unavailable —
logging and numbers keep working.

**Nudges** appear as thread turns on open, never as interruptions elsewhere.

## Results and honesty

Result rises as a sheet over the frozen frame: `Log it` · `Fix portion` ·
`Not this`.

**`Fix portion` is new.** No portion is editable anywhere in this flow today
(`DetectedCard.tsx:171`). The sheet gets a stepper reusing `PortionField`, with
kcal and macros recomputed live.

**The 100 g assumption gets fixed at the source.** When `ServingGrams` is absent
the server falls back to `barcodeDefaultGrams = 100.0`
(`api/internal/resolve/handler.go:54,63-64`), computes
`kcal = KcalPer100g * grams / 100` (`:232-234`) and stamps the result
`MatchScore: 1.0` (`:240`) — and the client prints an exact kcal figure. An invented
number presented as measurement. This is the same defect class removed from the
widgets on 2026-08-12.

The fix is a `portion_assumed` flag on the candidate, **not** a lower match
score. `MatchScore: 1.0` on a barcode hit is correct and must stay: an exact
barcode genuinely is an exact identification of the food. Identity is certain;
only the portion is a guess, and conflating the two would make every barcode
result look doubtful when it is not. Otto says the true thing:
*"about 640 kcal, but the portion is a guess."*

**Weak matches stop riding the primary button.** A `TierGuess` candidate is
preselected and logged by the same accent CTA as a firm match, distinguished only
by 11pt muted "Best guess" (`candidateTier.ts:10-12`). Guess-tier results get the
hedge in Otto's sentence and a primary action reading `Log as a guess`. One tap
still logs it — the user just knows what they are logging.

**`follow_up_question` gets an answer box.** The backend returns one
(`ResolutionResult.tsx:134`) and the UI offers only "Search manually". With a
thread underneath, it becomes a turn you can reply to.

**Multi-item meals stop losing data.** `capture-review.tsx:126` takes
`resolution?.candidates?.[0]` and every downstream use — `canConfirm`,
`handleConfirm`, the logged `food_item_id` and `quantity_grams`
(`capture-review.tsx:130,137,145-146`) — reads only that one candidate, while
`DetectedCard` can render "Add 2 items to diary" (asserted in
`DetectedCard.test.tsx:235`). The card promises N and the confirm writes one.
It also omits `onResolveUncertain`, so "tap to change" rows are not pressable
there.

This is the same multi-row card described under Otto above: per-row selection,
per-row portion, per-row correction, and a confirm that writes every selected
row. **This is live data loss and should be the first task in the plan.**

**Otto's summary reflects the weakest row.** "I found 3 items, about 620 kcal"
currently reads identically whether the rows are firm or all guesses.

## What gets deleted

Four mode pills · the no-op photo-library button (`capture.tsx:442-456`) · the
decorative 72pt voice mic (`capture.tsx:261-274`) · the fake barcode placeholder
and its fake scan line (`capture.tsx:319-331`) · the hardcoded example
`UserBubble` in Type mode (`capture.tsx:341-345`) · the chat framing around a
scrollable camera.

## File structure

`capture.tsx` is 1176 lines against this project's 800 max and its
"many small files" rule. The redesign splits it along the seams the audit
identified — camera state, thread state, result sheet, portion editor, resolve
orchestration, permission states — each a focused file with one responsibility.
No file introduced by this work exceeds 400 lines.

## Testing

- Unit tests for intent inference, portion recomputation, barcode re-arm logic,
  and timeout/abort behaviour.
- Existing tests under `app/__tests__/capture*.test.tsx` **assert several of the
  defects above as intended behaviour**. They must be changed deliberately, with
  the reason recorded in the commit — not discovered as failures and patched.
- Simulator gates, both themes not required (capture is always dark): camera →
  shoot → sheet → logged; barcode auto-detect and re-arm across two scans;
  swipe-down/pull-up between states; permission-denied route to Settings.
- Device gate: the swipe-down gesture against iOS Control Centre.

## Sequencing

1. **Data-loss and dead-control fixes first** — multi-item logging, barcode
   re-arm, `portion_assumed`. These harm users today and do not depend on the new
   shape.
2. Camera state and the two-state shell.
3. Result sheet, portion editing, guess hedging.
4. Otto: thread, ask, citations, intent, nudges.
5. Backend: `portion_assumed`, conversational reference in `qaSystemPrompt`.

## Build constraints

- **No EAS builds** are triggered from this work until explicitly requested.
- Any dependency change requires `npx npm@10.9.3 install --package-lock-only`.
- Capture is exempt from theming — always dark, `INSTRUMENT_DARK_FIXED`.
