# Recipes (#25) — Design

**Date:** 2026-08-13
**Issue:** #25 — feat: custom recipes (photo / paste / URL → reusable macros)
**Programme:** sub-project 1 of 5 toward #47 (family / household meal sharing, full scope)

## Why this exists

#47 at full scope — households sharing recipes, plans and shopping lists, with one
cook logging for many — is five independent subsystems, not one. Its stated
dependency #31 (AI meal planner) itself depends on #25 (recipes). Nothing
downstream can reference a shared, portionable dish until a servings-aware
loggable unit exists. Recipes is therefore built first.

Agreed decomposition and build order:

| # | Sub-project | Issue |
|---|-------------|-------|
| 1 | **Recipes** — paste/photo → ingredients + per-serving macros, loggable | #25 |
| 2 | Meal planner — AI day/week plan against macro targets | #31 |
| 3 | Shopping list — aggregate plan ingredients into a canonical list | #31 |
| 4 | Household — `groups` flavour with shared recipes/plans/lists | #47 |
| 5 | Log-once-for-many — per-member portions fan out to each diary | #47 |

Each gets its own spec → plan → implementation cycle. This document covers 1.

## Scope decisions

Settled before design; recorded here so later sub-projects inherit them.

- **v1 creation inputs: paste + photo.** URL import is deferred. #25 itself flags
  the URL strategy (schema.org JSON-LD vs LLM extraction) as unresolved, and it
  carries the worst failure tail: scraping, paywalls, junk markup. It returns as
  its own slice once the paste path's extraction prompt is proven.
- **Household privacy (relevant from sub-project 4): shared assets only.**
  Recipes, plans and lists are shared; individual diaries and macros stay
  private behind the existing `share_progress` consent gate in
  `compare.ProgressForMembers`. Noted now because it constrains the recipe
  ownership model below.
- **Child accounts: deferred.** Adults only. Child accounts drag in App Store
  age ratings and consent law — a milestone of its own, and an App Review risk
  next to the R1 F&F beta (#109).

## Ownership and the household seam

`recipes.user_id` is the owner. Sub-project 4 will add sharing by household, not
by rewriting ownership — a shared recipe stays owned by its author and becomes
*visible* to household members. Nothing in this design stores a household id or
assumes one; the seam is that every read path takes a "which recipes can this
user see" predicate that is, for now, `user_id = ?`.

## Architecture

New package `api/internal/recipes` with the four-file layer split used by
`savedmeals` and `groups`: `model.go`, `repository.go`, `service.go`,
`handler.go` (+ `errors.go` if needed), wired into the authed `/v1` group in
`api/internal/server/router.go`.

### Why not extend `savedmeals`

The two look alike and answer different questions:

| | `savedmeals` | `recipes` |
|---|---|---|
| Question | "log this exact plate again" | "this dish yields N servings — log me 1.5" |
| Portioning | fixed grams per item | grams scaled by servings requested / servings yielded |
| Ingredients | always a resolved `food_item_id` | may be unresolved raw text |
| Origin | hand-built by the user | AI-ingested draft, then confirmed |
| Limits | 50 per user, meal-slot tagged | slot chosen at log time, not at save time |

Merging them puts two lifecycles into one 242-line service. They stay separate
and both reuse `nutrition.Repository` and `units.ResolveEntered`, so unit
handling cannot drift between them.

## Data model — migration `000028`

```sql
CREATE TABLE recipes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  servings   integer NOT NULL CHECK (servings > 0),
  source     text NOT NULL CHECK (source IN ('manual','paste','photo')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_recipes_user ON recipes (user_id);

CREATE TABLE recipe_ingredients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id      uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position       integer NOT NULL,
  food_item_id   uuid NULL REFERENCES food_items(id),
  raw_text       text NOT NULL,
  grams          double precision NOT NULL DEFAULT 0,
  entered_amount double precision NULL,
  entered_unit   text NULL,
  portion_assumed boolean NOT NULL DEFAULT false,
  match_score    double precision NULL,
  match_tier     text NULL
);
CREATE INDEX ix_recipe_ingredients_recipe ON recipe_ingredients (recipe_id);
```

**`food_item_id` is nullable on purpose.** AI extraction will regularly produce
an ingredient the food index cannot resolve. The recipe must still save, holding
that ingredient as `raw_text` with **zero** macro contribution and surfacing it
to the user as needing attention. The two failure modes this rules out are
silently dropping the ingredient (macros quietly too low, user never told) and
fabricating a match (macros wrong, user actively misled).

**`match_score`/`match_tier` are nullable and mean "AI-resolved with this
confidence".** NULL means the user picked the food themselves, which carries no
model confidence to record — distinct from a low score, and rendered
differently.

**`raw_text` is stored even when resolution succeeds.** It is what the user or
the model actually wrote, and it is what a later re-resolution attempt needs —
the same reason `food_logs.input_phrase` exists alongside `description`.

**GORM zero-time trap.** `created_at`/`updated_at` are tagged
`gorm:"autoCreateTime"` / `gorm:"autoUpdateTime"`. A bare `time.Time` with no
tag inserts Go's zero time and overrides the SQL `DEFAULT now()` — this cost an
Important review finding on `groups` (`HANDOFF-social.md`).

## Macros are computed, never stored

Per-serving macros are derived on read:

```
total_X    = Σ over resolved ingredients of (grams / 100) × food.X_per_100g
per_serving_X = total_X / recipe.servings
```

Identical in shape to `savedmeals.List`. No macro column exists on either table.

Two reasons. First, the food index gets corrected — `log_corrections`
(migration `000020`) exists precisely because it does — and a stored figure
would silently drift out of sync with the row it came from. Second, it makes
#25's acceptance criterion "editing servings recomputes per-serving macros" a
plain integer update with no recomputation code at all.

Unresolved ingredients contribute nothing to any total. The response reports
`unresolved_count` so the client states the total is partial rather than
implying completeness.

## AI ingestion: parse returns a draft, never persists

Two endpoints, deliberately split.

### `POST /v1/recipes/parse`

Accepts pasted text (JSON) or a photo (multipart, bounded by
`http.MaxBytesReader` before multipart parsing, mirroring
`resolve.maxPhotoBodyBytes`). Returns an **unsaved draft**.

- **paste** → `ai.Router.GenerateText(systemPrompt, userPrompt)` with a strict
  JSON-schema prompt yielding `{name, servings, ingredients:[{text, amount, unit}]}`.
  A response that does not parse as that schema is a parse failure, not a
  partial success.
- **photo** → `ai.Router.IdentifyPhoto` then `ai.Router.Decompose`, both of which
  already return exactly the shapes needed (`[]Guess`, `[]IngredientGuess`).
- each extracted ingredient name is then run through the existing resolution
  path to obtain `ai.ResolvedCandidate`s.

Every provider call is metered through the existing `ai.Usage` sink with a
`CallType` of `parse_recipe_text` / `parse_recipe_photo`, and records failures
as well as successes. #81 is the standing lesson here: recording only successes
made a never-working path indistinguishable from a never-attempted one.

### `POST /v1/recipes`

Persists only what the user confirmed in the review sheet. The parse endpoint
writes nothing, so an abandoned parse leaves no rows.

### Confidence flags persist onto the row

Per-ingredient `match_score`, `tier` and `portion_assumed` travel from the draft
into the stored ingredient and back out on every read.

This is deliberate. Open issue #138 is exactly the bug where `portion_assumed`
stops at the confirm screen and the diary then presents a guessed portion as
fact. A recipe is a guess that gets re-logged for months — the worst possible
place to repeat it. A recipe detail view must be able to say "this ingredient's
portion is an estimate" long after the parse that produced it.

### Nutrition never comes from the model

The LLM supplies identity and portion phrases only. Every kcal and macro figure
originates in a `nutrition.FoodItem` row, as package `ai`'s own header states.
The parse prompt does not ask for macros, and any the model volunteers are
discarded.

## Logging a recipe

`POST /v1/recipes/:id/log { servings, meal_slot, logged_at }`

Fans out to N `food_logs` rows — one per **resolved** ingredient — with

```
log_grams = ingredient.grams × (requested_servings / recipe.servings)
```

reusing the existing batch path behind `POST /v1/logs/batch` that
`useInstantLog.logMeal` already drives. Unresolved ingredients are skipped and
returned in `skipped[]` so the client can tell the user what was left out.

**No synthetic single-row recipe log.** The diary, `log_corrections`, `memory`
and every macro computation operate on food-item rows; a synthetic row would be
invisible to the food index and uncorrectable. Saved meals already fan out this
way, so the diary behaves consistently with what ships today.

`source` on each created log is `recipe`, so recipe-driven logs are
distinguishable in analytics from hand-entered ones.

## HTTP surface

All under the authed `/v1` group, all responses in the standard `{data}`
envelope via `httpx.OK` (not raw `c.JSON` — the `groups.Create` handler's raw
call is a known wart, not a pattern to copy).

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/recipes` | list the caller's recipes with per-serving macros |
| POST | `/v1/recipes` | create from a confirmed draft |
| GET | `/v1/recipes/:id` | detail with ingredients and flags |
| PUT | `/v1/recipes/:id` | replace name/servings/ingredients wholesale |
| DELETE | `/v1/recipes/:id` | delete |
| POST | `/v1/recipes/parse` | AI draft from paste or photo; persists nothing |
| POST | `/v1/recipes/:id/log` | fan out to food logs |

`PUT` replaces wholesale, mirroring `savedmeals.Repository.Replace` — no
per-ingredient PATCH surface. Ingredient edits are rare and always arrive from a
full-form editor, so a diff protocol would add a second consistency model for no
gain.

Every mutating route is scoped by `user.IDFromContext`; a recipe belonging to
another user is a 404, never a 403, so ids are not enumerable.

## Mobile

- `src/api/hooks.ts`: `useRecipes`, `useRecipe`, `useCreateRecipe`,
  `useUpdateRecipe`, `useDeleteRecipe`, `useParseRecipe`, `useLogRecipe`.
  Read hooks fill the offline food cache via `cacheFoodsQuietly`, as
  `useSavedMeals` already does for its nested foods.
- `app/recipes.tsx` — list; `app/recipe/[id].tsx` — detail and editor.
- A parse-review sheet modelled on `capture-review.tsx`, showing per-ingredient
  confidence and assumed-portion state, and letting the user fix or drop any
  ingredient before saving.
- A "Recipes" tab alongside the existing saved/pinned/usual tabs in
  `app/log.tsx`.
- Every mutation surfaces its error via the toast path, not a silently disabled
  button — issue #83 is the standing bug for `isPending`-gated buttons left
  permanently disabled with no error surface.

## Error handling

- Invalid input → `httpx.ValidationError` → 400 with a specific message
  (`servings must be at least 1`, `at least one ingredient is required`,
  `name is too long`).
- Unknown or foreign recipe id → 404.
- Unrecognised entered unit → the shared `units.UnrecognisedUnitMessage`, so
  recipes, saved meals and food logs all say the same thing.
- **Parse failure** → 502 with a message the sheet renders as "Couldn't read
  that recipe — enter it manually", dropping the user into the manual editor
  rather than an empty error state. Parse is best-effort by nature; a dead end
  there must not be a dead end for the task.
- Provider timeout is a parse failure, not a 500, and is metered with
  `ai.OutcomeTimeout`.

## Testing

Go, table-driven, matching the density of the existing `*_test.go` files:

- **service** — stubbed `ai.Router` and in-memory food repo, no network.
  Servings arithmetic; unresolved ingredients contributing zero;
  `portion_assumed` surviving save → read → log; parse-failure mapping;
  entered-unit resolution happening exactly once, server-side.
- **repository** — against the real schema. Wholesale replace; cascade delete;
  ingredient ordering by `position`; the nullable `food_item_id` join.
- **handler** — auth scoping (another user's recipe is 404), validation
  rejections, multipart size limit, envelope shape.

Jest for the hooks and the review sheet, including the unresolved-ingredient
rendering and the mutation error path.

Coverage target 80%+, per the repo standard.

## Out of scope

URL import (deferred slice); allergen checks (#36); pantry-aware substitution
(#33); sharing of any kind (sub-project 4); shopping lists (sub-project 3).
