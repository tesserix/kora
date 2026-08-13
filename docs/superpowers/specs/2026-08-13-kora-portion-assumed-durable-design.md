# Carrying `portion_assumed` past confirm (#138)

Design for #138 — deferred from the capture-integrity branch (`b2a2add`) because
doing it properly needs a schema and wire decision rather than a bolt-on.

**The project invariant:** an unknown value and a known value must never render
identically.

`portion_assumed` marks a portion the system chose rather than one derived from
real data or stated by the user. It originates at four Go construction sites
plus the offline cache twin, and is rendered as a per-row hedge in
`DetectedCard` and in Otto's summary.

**The hedge stops at confirm.** It is not carried into the log payload, so once
logged the diary shows a guessed portion as a plain figure, indistinguishable
from a weighed one. The honesty the capture screen gained is discarded at the
moment the number becomes durable — and the diary is where the user actually
revisits it.

## Decisions

| Question | Decision |
|---|---|
| Does `food_logs` carry the flag? | **Yes** — a dedicated `portion_assumed BOOLEAN NOT NULL DEFAULT false` column |
| Does the diary render it? | **Yes** — the same engraved marker, same words, as capture |
| Does it affect totals? | **No** — deliberately |
| Editing the portion | **Clears the flag** |

### Why a column, not `provenance`

`FoodLog` already has a `Provenance` string, and reusing it was considered and
rejected.

`provenance` answers *where the nutrition data came from* — it carries sentinels
like `UNKNOWN_PROVENANCE` for exactly that axis. Portion-confidence is
**orthogonal**: a portion can be guessed for a food whose per-100g figures are
authoritative, and a portion can be exact for a food whose nutrition is an AI
estimate. Folding two independent facts into one string produces a value no
later reader can decompose.

There is also in-repo precedent. `recipe_ingredients` took a
`portion_assumed BOOLEAN NOT NULL DEFAULT false` column in migration
`000028_recipes.up.sql`, whose comment states it "carries #138's lesson". Same
name, same type, same default — a reader who learns it in one table already
knows it in the other.

### Why the diary uses the same marker, verbatim

`DetectedCard` (`src/components/capture/DetectedCard.tsx:147-163`) and
`app/recipe/[id].tsx:93` both render an engraved `mut`, uppercase,
letter-spaced **"portion is a guess"**. The diary uses the same words and the
same treatment.

The alternative — inventing a quieter diary-specific signal — would mean the
user learns three visual languages for one fact and is likelier to miss the
third. A marker's job is recognition.

Placement: the row's secondary line, beside the meal slot. `MealRow` already
has that line for `slot`.

### Why totals are unaffected

The grams on the row are the system's best estimate, and the day's total is the
sum of its rows. Excluding assumed portions from the total would make the total
disagree with the visible rows — a worse dishonesty than the one being fixed,
and one the user cannot diagnose.

Marking uncertainty is not discarding data. `MealRow` already models the
genuinely-unknown case on a different axis (`kcal: number | null` renders
`— kcal`), and that distinction stays intact and separate.

### Why editing clears the flag

`app/recipe/[id].tsx:217-224` already establishes this: *"portion_assumed is
CLEARED here: this figure was typed by hand"*. Once the user states a portion,
it is no longer the system's guess, and continuing to hedge it would be its own
small lie.

## Scope

### Server

1. **Migration** `000031_food_logs_portion_assumed` — add
   `portion_assumed BOOLEAN NOT NULL DEFAULT false` to `food_logs`.
   `DEFAULT false` makes every existing row read as "not a guess", which is the
   correct reading: those rows predate the flag and nothing recorded otherwise.
2. **`foodlog.FoodLog`** — add `PortionAssumed bool` with the
   `json:"portion_assumed"` tag, mirroring `recipes.model`'s field.
3. **The create and append handlers** — accept the flag on the request and
   persist it. A request that omits it means `false`, which the column default
   already expresses.

### Mobile

4. **Types** — `portion_assumed` on the log request and on the log row.
5. **`capture.tsx`** — pass `candidate.portion_assumed` in the confirm payload
   (the `createLog`/`appendLog` calls around line 1331).
6. **The offline queue** — carry the flag through the queued shape and its
   drain, or a queued log silently loses the hedge.
7. **`MealRow`** — render the marker when the row is assumed.
8. **Edit clears it** — a portion edited by hand sends `portion_assumed: false`.

### The related, smaller item

9. **`ResolutionResult.resultSummary`** — the cached branch
   (`ResolutionResult.tsx:46-48`) returns **early**, before the `assumedCount`
   hedging below it. So a cached resolution whose row *is* hedged — and
   `src/offline/cachedResolution.ts:48` sets
   `portion_assumed: item.serving_grams <= 0`, so it genuinely can be — gets a
   bubble that says *"that's X, from a scan you've done before"* with no
   qualification. The row tells the truth; the bubble above it does not.

   The cached branch must hedge on the same condition the live branch does.

## Testing

Per the #110 lesson — *an assertion whose expected value equals the initial
state cannot distinguish "it worked" from "nothing ran"* — assertions check for
the **presence** of the flag and the marker, against fixtures where a plain
row is also present.

- **Server:** a log created with `portion_assumed: true` reads back true; one
  created without the field reads back **false**, not null. A pre-existing row
  (inserted without the column) reads false.
- **Round trip:** the flag survives create → read, asserted by query rather
  than by the response echoing its own input.
- **`capture.tsx`:** confirming an assumed candidate sends
  `portion_assumed: true`; confirming a plain one sends `false`. Both asserted
  in the same test file so a payload that hardcodes either value fails.
- **Offline queue:** a queued assumed log still carries the flag after drain.
- **`MealRow`:** the marker renders when assumed and is **absent** when not —
  both directions, since a marker that always renders is as wrong as one that
  never does.
- **Edit clears:** editing a portion on an assumed row sends `false`.
- **`resultSummary`:** a cached resolution with an assumed candidate hedges;
  a cached resolution with no assumed candidate does not. This is the pair that
  pins the bug being fixed.

Suites must stay green: `cd apps/mobile && npx tsc --noEmit && npx jest --ci
--forceExit` and `cd api && go test ./...`.

**Note on the Go suite:** `go test ./...` truncates the dev `food_items` table
(`internal/nutrition`'s tests wipe it). Re-seed afterwards with
`cd api && set -a && . ./.env && set +a && go run ./cmd/seed`.

## Acceptance (from #138)

A portion the system guessed is still identifiable as a guess after it has been
logged.

Additionally, from this design:

- The day's total is unchanged by the flag.
- A hand-edited portion is no longer marked.
- A cached resolution's summary bubble hedges exactly when its rows do.

## Out of scope

- Backfilling historical rows. Nothing recorded whether their portions were
  assumed, and inventing that is worse than the `false` default.
- Any change to how portions are *chosen*. This carries an existing signal
  further; it does not alter estimation.
- Filtering or weighting assumed portions in analytics or targets.
