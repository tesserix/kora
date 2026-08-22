---
quick_id: 260821-obq
slug: offline-barcode-queue
date: 2026-08-21
refs: kora#241, kora#196, kora#191, kora#139, kora#257
---

# Queue an unseen barcode scanned offline

Implements #241 — the remaining half of #196. The typed half shipped in #196;
photo and voice were already queued.

**This PR is not to be merged on tests alone.** It ships a path that cannot be
exercised here: a barcode needs a real scanner, `CameraView`'s
`onBarcodeScanned` only fires continuously on hardware, and the simulator
cannot produce a scan (#139 records the same limit). Merge is gated on a device
test with a real product.

## What happens today

A **seen** barcode already works offline — `src/offline/cachedResolution.ts`
answers from the local food cache and marks the result `CACHED_MATCH_TIER`, so
a cache hit can never be mistaken for a fresh server answer.
`OfflineUnknownBarcodeError` exists precisely to distinguish "we positively
established we have no answer" from a transport failure.

So the gap is narrow: **only the first-ever scan of a given product while
offline**, which is dropped with honest copy (#191 made it so). This is
therefore an improvement to a truthful message, not the closing of a silent
data loss — unlike the typed half.

## Two traps that fail silently. Both must be handled.

### 1. The capacity predicate is text-vs-everything, not lightweight-vs-media

`captureQueue.ts` splits capacity twice (lines ~143 and ~209):

```js
const limit = item.kind === "text" ? MAX_TEXT_CAPTURES : MAX_CAPTURES;
const used = items.filter((i) => (i.kind === "text") === (item.kind === "text")).length;
```

#241 asks for `MAX_TEXT_CAPTURES`-style capacity because a barcode row is a
short string. But `kind === "barcode"` is not `"text"`, so a new arm lands in
the **media** bucket and is capped alongside photos and voice notes. Nothing
fails; the queue just quietly gets the wrong capacity.

Generalise the predicate to "is this a lightweight row" rather than "is this
text". `hasMedia()` already exists at line 80 for exactly this shape and its
comment anticipates a third arm.

### 2. The diary's row label is a fallthrough, not an exhaustive switch

`app/(tabs)/diary.tsx:369`:

```js
c.kind === "text" ? (c.phrase ?? "Typed note")
  : c.kind === "photo" ? "Photo"
  : "Voice note"
```

and `iconName` falls through to `"mic"` the same way. **A barcode row renders
as "Voice note" with a microphone icon** unless this is handled, and no test
catches it. Prefer restructuring so a future arm is a compile error rather than
a wrong label.

## The three product decisions

#241 names these as genuinely new. Proposed answers below; the PR presents
them for a decision rather than assuming them settled.

**1. What the user is told.** Replace `app/capture.tsx:985`'s "You're offline,
and this isn't a barcode you've scanned before. Scan it again once you're back
online." with the same shape the typed path uses on success — an
acknowledgement that it is saved and will be identified later. Keep the first
clause: explaining *why* it cannot answer now is what made #191's copy honest.

**2. The diary row.** A raw EAN is not a meal name. Proposal: a stable label
("Scanned item") plus the barcode icon, with the code available but not the
title. If two unknown codes are queued the rows must still be
distinguishable — decide how, and say so, rather than shipping two identical
rows. Check what the `Icon` set actually has before assuming a barcode glyph
exists.

**3. Duplicate scans.** Scanning the same unknown code three times offline must
not queue three rows. Dedupe on `code` against pending barcode rows.

**Plus one the issue raises but does not decide:** if the code is queued and
the user later scans the same product **online**, the resolve caches the food,
so the queued row then drains against a code the device can now answer locally.
Harmless, but decide it deliberately — draining from cache is correct and
cheaper, and `CACHED_MATCH_TIER` already keeps it honest about provenance.

## Plumbing (mostly predicted correctly by the issue)

- `QueuedCapture` gains a `"barcode"` arm carrying `code`. The union and
  `hasMedia()` are already shaped for it.
- `isValid` gains a per-arm check. **Do not tighten the existing arms** — it is
  the upgrade contract, and #243 records why (dropping already-queued rows on
  upgrade is the failure mode #196's design avoids).
- `drainCaptures`' `resolveCapture` gains a `/v1/resolve/barcode` dispatch.
- `sourceOf` gains `barcode → "ai_barcode"`, already a valid `ResolutionSource`.

## Verification

Unit tests cover the queue, drain, dedupe, capacity and copy. They **cannot**
cover the scan itself.

Jest performs no layout (see the blind-spot note at the reanimated mock in
`jest.setup.js`, #257), so the diary row's appearance is asserted as props, not
pixels. `tab-diary` is in the golden set and a new row type may move it.

**Device gate before merge** — with a real product, offline:

1. scan a product never scanned before; confirm the new copy, and that the
   diary shows a legible queued row
2. scan the same code twice more; confirm one row, not three
3. go online; confirm it resolves and the row becomes a real food
4. scan a **seen** barcode offline; confirm the existing cache path is
   unchanged and still marks `CACHED_MATCH_TIER`

Step 4 is the regression check that matters most: the cache path already works
and must not be disturbed by the new arm.
