# Durable `portion_assumed` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A portion the system guessed stays identifiable as a guess after it has been logged — through the wire, the database, and the diary.

**Architecture:** A new `portion_assumed` boolean column on `food_logs`, mirroring the one `recipe_ingredients` already has. The flag is set at confirm from the candidate that already carries it, survives the offline queue, renders in the diary with the same marker capture uses, and is cleared when the user edits the portion by hand.

**Tech Stack:** Go 1.26 + GORM + golang-migrate (API), React Native / Expo SDK 57 + TypeScript (mobile), Jest + `@testing-library/react-native`.

## Global Constraints

- **Expo v57.** Read https://docs.expo.dev/versions/v57.0.0/ before using any Expo API.
- **Mobile suites must stay green:** `cd apps/mobile && npx tsc --noEmit` and `cd apps/mobile && npx jest --ci --forceExit`. **Baseline: 173 suites / 1409 tests.** Report counts.
- **Go suite:** `cd api && go test ./...`. **It truncates the dev `food_items` table** (`internal/nutrition`'s tests wipe it). Re-seed after with `cd api && set -a && . ./.env && set +a && go run ./cmd/seed`. Also: a running API binds `:9090` and makes `internal/metrics` tests fail — stop it first.
- **`cmd/api/main.go` does not load `.env`.** Run Go things as `cd api && set -a && . ./.env && set +a && <cmd>`.
- **No `console.log`** in `app/` or `src/`. A deliberate best-effort swallow is a commented empty `catch` (`src/lib/push.ts:46-50`).
- **Explicit types on exported functions.** No `any` — use `unknown` and narrow.
- **Immutability.** Never mutate existing objects.
- **Commit messages:** single-line, conventional-commit prefix, **no signature, no body**.
- **Tests: `fireEvent` MUST be awaited** (RNTL 14.0.1 + React 19.2.3 do not flush state otherwise; an un-awaited event lets assertions pass against a broken implementation). See `app/__tests__/sign-in.test.tsx:69-121`.
- **Spec of record:** `docs/superpowers/specs/2026-08-13-kora-portion-assumed-durable-design.md`.

## Context an implementer needs

**The precedent to copy.** `recipe_ingredients` already has this exact column, added in `api/internal/database/migrations/000028_recipes.up.sql:28-31`:

```sql
-- portion_assumed carries #138's lesson: a guessed portion must stay
-- ...
portion_assumed BOOLEAN NOT NULL DEFAULT false,
```

and the Go field at `api/internal/recipes/model.go:52-55`. Match the name, type, default and tag.

**Where the flag comes from.** It already exists end-to-end up to confirm:

- Go sets it at four sites (`internal/resolve/handler.go:83`, `internal/ai/resolver.go:154,418`, `internal/recipes/parse.go:300`).
- Wire type: `internal/ai/types.go:91-97` — `PortionAssumed bool \`json:"portion_assumed"\``.
- Mobile reads it: `src/api/types.ts:437`, normalised in `src/api/resolveWire.ts:26-29` (an older server may omit it, so it defaults to `false`).
- The offline twin sets it: `src/offline/cachedResolution.ts:48` — `portion_assumed: item.serving_grams <= 0`.

**Where it currently dies.** `apps/mobile/app/capture.tsx` around line 1331 builds the log payload with `food_item_id` and `quantity_grams` and does not include `portion_assumed`.

**The marker to reuse, verbatim.** `src/components/capture/DetectedCard.tsx:147-163` renders:

```tsx
<AppText
  style={{
    color: T.mut,
    fontSize: 9,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 2,
  }}
>
  portion is a guess
</AppText>
```

`app/recipe/[id].tsx:93` renders the same. Use the same words and treatment in the diary — the theme token there is `instrument.mut`.

**Totals must not change.** The flag is a label. Nothing about kcal, macros or day totals changes. If a test of totals moves, something is wrong.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `api/internal/database/migrations/000031_food_logs_portion_assumed.up.sql` | Create | Add the column |
| `api/internal/database/migrations/000031_food_logs_portion_assumed.down.sql` | Create | Drop it |
| `api/internal/foodlog/model.go` | Modify | `PortionAssumed bool` field |
| `api/internal/foodlog/` handler + request structs | Modify | Accept and persist the flag |
| `apps/mobile/src/api/types.ts` | Modify | Flag on the log request and log row types |
| `apps/mobile/app/capture.tsx` | Modify (~1331) | Send the flag at confirm |
| `apps/mobile/src/offline/` queued-log shape + drain | Modify | Carry it through the queue |
| `apps/mobile/src/components/MealRow.tsx` | Modify | Render the marker |
| `apps/mobile/src/components/ResolutionResult.tsx` | Modify (~46-48) | Cached branch hedges too |

---

## Task 1: Server — column, model, and persistence

**Files:**
- Create: `api/internal/database/migrations/000031_food_logs_portion_assumed.up.sql`
- Create: `api/internal/database/migrations/000031_food_logs_portion_assumed.down.sql`
- Modify: `api/internal/foodlog/model.go`
- Modify: the create/append handler and its request struct in `api/internal/foodlog/`
- Test: the existing `api/internal/foodlog/` test files

**Interfaces:**
- Consumes: nothing.
- Produces: `portion_assumed` accepted on the log-create wire and returned on the log row. Task 2 and Task 3 depend on both.

- [ ] **Step 1: Read the precedent first**

Read `api/internal/database/migrations/000028_recipes.up.sql:24-32` and `api/internal/recipes/model.go:50-56`. Match their naming, type, default, comment style and struct-tag style. Do not invent a different shape.

- [ ] **Step 2: Write the failing test**

In the existing `foodlog` test file, add tests that:

1. Create a log with `portion_assumed: true`, read it back, assert it is `true`.
2. Create a log **omitting** the field, read it back, assert it is `false` — **not** null, not absent.
3. Assert the day's total kcal is **unchanged** by the flag: create two logs with identical nutrition, one assumed and one not, and assert the summed kcal equals twice one row's kcal. This pins "the flag is a label, not an input to arithmetic".

Follow the file's existing setup/teardown conventions exactly — read it before writing.

- [ ] **Step 3: Run the test and confirm it fails**

Run: `cd api && set -a && . ./.env && set +a && go test ./internal/foodlog/...`
Expected: FAIL — the field does not exist.

- [ ] **Step 4: Write the migration**

`000031_food_logs_portion_assumed.up.sql`:

```sql
-- A portion the system chose rather than one derived from real data or stated
-- by the user. The hedge shown at capture (DetectedCard, Otto's summary) died
-- at confirm, so the diary rendered a guess as a plain figure indistinguishable
-- from a weighed one — see #138.
--
-- DEFAULT false is the correct reading for every existing row: they predate the
-- flag and nothing recorded that their portions were assumed. Inventing a value
-- for them would be worse than the default.
ALTER TABLE food_logs
    ADD COLUMN portion_assumed BOOLEAN NOT NULL DEFAULT false;
```

`000031_food_logs_portion_assumed.down.sql`:

```sql
ALTER TABLE food_logs DROP COLUMN portion_assumed;
```

- [ ] **Step 5: Add the model field**

In `api/internal/foodlog/model.go`, add to `FoodLog` (place it beside `Provenance`, which is the nearest related concept):

```go
	// PortionAssumed reports that the system chose this portion rather than
	// deriving it from a serving size or receiving it from the user. It is a
	// LABEL, never an input to arithmetic — nutrition and day totals are
	// unaffected by it. Cleared when the user edits the portion by hand.
	PortionAssumed bool `gorm:"not null;default:false" json:"portion_assumed"`
```

- [ ] **Step 6: Accept it on the request structs and persist it**

There are **three** relevant structs in `api/internal/foodlog/service.go`. Handle all of them:

- **`LogRequest`** (~line 53) — the single-log path. Add `PortionAssumed bool \`json:"portion_assumed"\`` and carry it into the constructed `FoodLog`. A request omitting it yields Go's zero value `false`, matching the column default — no pointer, no special handling.
- **`BatchItem`** (~line 412) — the batch path, which is how capture logs several candidates at once (`src/api/useInstantLog.ts:111`). Add the same field. **Missing this would leave every multi-item capture unmarked**, which is the common case for a photo of a plate.
- **`EditRequest`** (~line 241) — see the next step.

- [ ] **Step 7: Clear the flag server-side when an edit overwrites the portion**

Do **not** rely on clients sending `false`. `EditRequest` already establishes exactly this pattern for the entered pair, with this reasoning:

> When only QuantityGrams is supplied, the previously-stored entered pair is nulled — it no longer describes the amount once grams were overwritten directly.

The identical logic applies: a stored `portion_assumed: true` no longer describes a portion the user has just overwritten by hand. Clear it in the same branch, for the same reason, and say so in a comment referencing #138.

Put it server-side rather than in each client because there is more than one client path and a client that forgets leaves a stale, now-false hedge on the row — the exact failure this issue is about, in miniature.

Add a test: a log created with `portion_assumed: true`, then edited with a new `quantity_grams`, reads back `false`.

- [ ] **Step 8: Run the tests**

Run: `cd api && set -a && . ./.env && set +a && go test ./internal/foodlog/...`
Expected: PASS.

Then the full Go suite: `cd api && set -a && . ./.env && set +a && go test ./...`
**Re-seed afterwards:** `cd api && set -a && . ./.env && set +a && go run ./cmd/seed`

- [ ] **Step 9: Commit**

```bash
git add api/internal/database/migrations/000031_food_logs_portion_assumed.up.sql api/internal/database/migrations/000031_food_logs_portion_assumed.down.sql api/internal/foodlog/
git commit -m "feat(api): persist portion_assumed on food logs"
```

---

## Task 2: Mobile — send it at confirm, and through the offline queue

**Files:**
- Modify: `apps/mobile/src/api/types.ts`
- Modify: `apps/mobile/app/capture.tsx` (~line 1331)
- Modify: the queued-log shape and drain under `apps/mobile/src/offline/`
- Test: `apps/mobile/app/__tests__/capture.test.tsx` and the offline queue tests

**Interfaces:**
- Consumes: the server accepting `portion_assumed` (Task 1).
- Produces: logs carrying the flag. Task 3 renders it.

- [ ] **Step 1: Write the failing tests**

In `apps/mobile/app/__tests__/capture.test.tsx`, following the file's existing conventions:

1. Confirming a candidate with `portion_assumed: true` sends `portion_assumed: true` in the log payload.
2. Confirming a candidate with `portion_assumed: false` sends `portion_assumed: false`.

**Both are required.** A single test could pass against a payload that hardcodes the value; the pair cannot.

In the offline queue tests, add: a queued log for an assumed candidate still carries `portion_assumed: true` when drained.

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/mobile && npx jest app/__tests__/capture.test.tsx --ci --forceExit`
Expected: FAIL — the payload has no `portion_assumed`.

- [ ] **Step 3: Add the types**

In `apps/mobile/src/api/types.ts`, add `portion_assumed` to the log-create request type and to the logged-row type. On the **row** type make it optional (`portion_assumed?: boolean`) — an older server, or a cached/replayed row, may omit it, and the existing `Candidate` type at line 267 already uses that convention for the same reason.

- [ ] **Step 4: Send it at confirm**

In `apps/mobile/app/capture.tsx`, add `portion_assumed: candidate.portion_assumed` to the payload built around line 1331, alongside `food_item_id` and `quantity_grams`.

- [ ] **Step 5: Carry it through the offline queue**

Add the field to the queued-log shape and to whatever constructs the request on drain. Read the existing queued shape first and follow it — the queue is versioned/persisted, so a field added carelessly can break replay of an already-queued item. If the queued records are versioned, an absent field on an old record must read as `false`, not crash.

- [ ] **Step 6: Run the tests**

Run: `cd apps/mobile && npx jest app/__tests__/capture.test.tsx src/offline --ci --forceExit`
Expected: PASS.

- [ ] **Step 7: Typecheck and full suite**

Run: `cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit`
Report counts.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/api/types.ts apps/mobile/app/capture.tsx apps/mobile/src/offline apps/mobile/app/__tests__/capture.test.tsx
git commit -m "feat(mobile): carry portion_assumed into the log payload and offline queue"
```

---

## Task 3: Mobile — render it in the diary, clear it on edit, fix the cached bubble

**Files:**
- Modify: `apps/mobile/src/components/MealRow.tsx`
- Modify: `apps/mobile/src/components/ResolutionResult.tsx` (~lines 46-48)
- Modify: whichever screen edits a logged portion (find it; the recipe screen's equivalent is `app/recipe/[id].tsx:217-224`)
- Test: `MealRow`'s test file, `ResolutionResult`'s test file, and the edit screen's tests

**Interfaces:**
- Consumes: the flag on the log row (Task 2).
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

Note: the edit-clearing test lives server-side (Task 1) — do not duplicate it here.

For `MealRow` — **both directions**, since a marker that always renders is as wrong as one that never does:

1. Given an assumed row, the text `portion is a guess` is present.
2. Given a plain row, it is **absent** (`queryByText(...)` is null).

For `resultSummary` in `ResolutionResult.tsx` — this pair pins the bug:

3. A **cached** resolution whose candidate has `portion_assumed: true` produces a summary that hedges.
4. A **cached** resolution with no assumed candidate produces the existing unhedged copy, unchanged.

For the edit path: editing a logged portion by hand sends `portion_assumed: false`.

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/mobile && npx jest src/components/__tests__/MealRow src/components/__tests__/ResolutionResult --ci --forceExit`
Expected: FAIL.

- [ ] **Step 3: Render the marker in `MealRow`**

Add an optional prop:

```tsx
  /** The system chose this portion rather than deriving or being told it (#138).
   *  Rendered with the same engraved marker capture uses, so the user learns
   *  one signal rather than three. */
  portionAssumed?: boolean;
```

and render it on the secondary line beside `slot`, using the same treatment as `DetectedCard.tsx:149-162`:

```tsx
        {portionAssumed ? (
          <AppText
            style={{
              color: instrument.mut,
              fontSize: 9,
              fontWeight: "700",
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            portion is a guess
          </AppText>
        ) : null}
```

Then pass it from the diary's row construction. Find every `MealRow` call site that renders a logged row and thread the flag through; leave call sites that render non-log rows (saved meals, pins) alone.

- [ ] **Step 4: Fix the cached summary branch**

In `ResolutionResult.tsx`, the cached branch at ~line 46 returns **before** the `assumedCount` hedging below it. Make it hedge on the same condition. Compute `assumedCount` **above** the cached branch and reuse it, so the two branches cannot drift apart:

```tsx
  const assumedCount = resolution.candidates.filter((c) => c.portion_assumed).length;
  const guessText =
    assumedCount === 1 ? "one portion is a guess" : `${assumedCount} portions are guesses`;

  if (isCachedResult({ match_tier: resolution.provenance })) {
    const name = resolution.candidates[0]?.item.name ?? "that";
    const base = `You're offline — that's ${name}, from a scan you've done before`;
    return assumedCount > 0
      ? `${base} — ${guessText}. Confirm and I'll log it.`
      : `${base}. Confirm and I'll log it.`;
  }
```

Keep the existing explanatory comments above the cached branch — they explain why it deliberately says nothing about when calories arrive, which is still true.

**Do not change the unhedged cached copy's wording** beyond appending the hedge; `app/__tests__/capture.test.tsx:947` matches on `/from a scan you.{0,3}ve done before/i`.

- [ ] **Step 5: Nothing to do for edit-clearing — verify it**

Clearing on edit is handled **server-side** in Task 1 (`EditRequest`), deliberately: there is more than one client path, and a client that forgets would leave a stale hedge on a row the user has just corrected.

Verify the client does not fight it: confirm no mobile code sends `portion_assumed: true` on an edit/PATCH path. If any does, remove it — the server owns this transition.

- [ ] **Step 6: Run the tests**

Run: `cd apps/mobile && npx jest --ci --forceExit`
Expected: PASS. Report counts.

- [ ] **Step 7: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/components/MealRow.tsx apps/mobile/src/components/ResolutionResult.tsx apps/mobile/app apps/mobile/src
git commit -m "feat(mobile): mark guessed portions in the diary and hedge the cached summary"
```

---

## Definition of done

- [ ] `cd apps/mobile && npx tsc --noEmit` clean; `npx jest --ci --forceExit` green.
- [ ] `cd api && go test ./...` green (and `food_items` re-seeded afterwards).
- [ ] A log created with an assumed portion reads back `portion_assumed: true`; one without reads `false`.
- [ ] The diary row shows `portion is a guess` for an assumed row and nothing for a plain one.
- [ ] Day totals are unchanged by the flag.
- [ ] A hand-edited portion clears the flag (server-side, via `EditRequest`).
- [ ] A cached resolution's bubble hedges exactly when its rows do.

## Out of scope

- Backfilling historical rows — nothing recorded whether their portions were assumed.
- Any change to how portions are chosen.
- Filtering or weighting assumed portions in analytics or targets.
