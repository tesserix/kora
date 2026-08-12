# Meal Planner (#31) — Design

**Date:** 2026-08-13
**Issue:** #31 — feat: AI meal planner + shopping list
**Programme:** sub-project 2 of 5 toward #47 (family / household meal sharing)

## Where this sits

| # | Sub-project | Issue | Status |
|---|-------------|-------|--------|
| 1 | Recipes — paste/photo → per-serving macros, loggable | #25 | **shipped** (`main`, 2026-08-13) |
| 2 | **Meal planner** — week plan against macro targets | #31 | this spec |
| 3 | Shopping list — aggregate plan ingredients | #31 | |
| 4 | Household — `groups` flavour with shared recipes/plans/lists | #47 | |
| 5 | Log-once-for-many — per-member portions fan out | #47 | |

#31's own dependency note says "plans produce loggable recipes", which is why
recipes was built first. Recipes, saved meals and Personal Food Memory are all
now available as planning material.

## Scope decisions

Settled before design:

- **Hybrid generation.** Assemble from what the user already has, and call the
  model only for gaps. Not pure assembly (too little variety for a new user),
  not pure AI generation (targets become approximate and every plan costs a
  call).
- **A full week.** 7 days × the user's chosen slots.
- **One-tap logging, never automatic.** A plan is a suggestion. Nothing reaches
  the diary until the user taps, so the diary keeps meaning "what I actually
  ate" — which the dashboard, coach, memory and every macro figure depend on.
- **Constraints accepted in v1:** macro targets, which slots to fill, and a
  free-text cuisine/preference steer. **Not** budget, prep time or pantry —
  each needs data the app does not hold (prices, prep times, a pantry; pantry
  is its own issue, #33).

## Implementation is split into two plans

This spec covers one feature, but it is built and reviewed in two passes:

- **Plan A — deterministic planner.** Candidate pool, fitting, persistence,
  the week UI, one-tap logging. Fully usable on its own for any user with
  recipes or logging history.
- **Plan B — AI gap fill.** The single bounded model call that fills slots the
  pool cannot, plus the cuisine steer.

The split exists because the AI leg is the expensive, risky part, and landing
it on top of something already proven is far cheaper to review than untangling
the two. This is the same decomposition that made #47 tractable.

## Architecture

New package `api/internal/mealplans` — `model.go`, `repository.go`,
`service.go`, `fit.go`, `generate.go` (Plan B), `handler.go` — following the
layer split used by `recipes`, `savedmeals` and `groups`.

### Data model — migration `000030`

```sql
CREATE TABLE meal_plans (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    starts_on  DATE NOT NULL,
    days       INTEGER NOT NULL CHECK (days BETWEEN 1 AND 14),
    slots      TEXT[] NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_meal_plans_user ON meal_plans (user_id, starts_on DESC);

CREATE TABLE meal_plan_items (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id        UUID NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
    day_index      INTEGER NOT NULL CHECK (day_index >= 0),
    meal_slot      TEXT NOT NULL,
    position       INTEGER NOT NULL,
    source_kind    TEXT NOT NULL CHECK (source_kind IN ('recipe','saved_meal','food')),
    recipe_id      UUID NULL REFERENCES recipes(id) ON DELETE CASCADE,
    saved_meal_id  UUID NULL REFERENCES saved_meals(id) ON DELETE CASCADE,
    food_item_id   UUID NULL REFERENCES food_items(id),
    -- servings for a recipe; grams for a food; ignored for a saved meal,
    -- which is logged exactly as saved.
    servings       DOUBLE PRECISION NULL,
    grams          DOUBLE PRECISION NULL,
    CONSTRAINT meal_plan_items_one_source CHECK (
        (source_kind = 'recipe'     AND recipe_id     IS NOT NULL AND saved_meal_id IS NULL AND food_item_id IS NULL) OR
        (source_kind = 'saved_meal' AND saved_meal_id IS NOT NULL AND recipe_id     IS NULL AND food_item_id IS NULL) OR
        (source_kind = 'food'       AND food_item_id  IS NOT NULL AND recipe_id     IS NULL AND saved_meal_id IS NULL)
    )
);
CREATE INDEX ix_meal_plan_items_plan ON meal_plan_items (plan_id, day_index, position);
```

**A plan item points at its source; it never snapshots macros.** Three
consequences, all load-bearing:

1. Plan macros are computed from live rows on every read, exactly as recipe
   macros are — so a food-index correction propagates, and no stored figure can
   drift.
2. One-tap logging dispatches into the **existing** log paths by `source_kind`.
   No new logging semantics enter the system.
3. Sub-project 3 expands plan items into ingredients for the shopping list. A
   snapshot would make that impossible without a second source of truth.

`ON DELETE CASCADE` on `recipe_id`/`saved_meal_id` is deliberate: deleting a
recipe removes it from future plans rather than leaving an item pointing at
nothing. `food_item_id` has no cascade because foods are soft-deleted, and a
retired food must still render in a plan the way it still renders in a recipe.

Timestamps use `gorm:"autoCreateTime"` / `autoUpdateTime`. Do **not** add an
explicit `updated_at` expression to map-based `Updates` — gorm v1.31.2 applies
`autoUpdateTime` to map updates (proved during #25; the plan's earlier claim to
the contrary was wrong).

### Macros are computed, never stored

Per item, per day, and per plan, derived on read:

- **recipe** → `recipes` per-serving figures × `servings`
- **saved_meal** → the saved meal's own totals
- **food** → `food_items` per-100g × `grams / 100`

Per-day totals are compared against the user's `target_kcal`,
`target_protein_g`, `target_carbs_g`, `target_fat_g` to produce an adherence
figure. No macro column exists on either table.

## Generation — the hybrid engine

Four stages, in order. Stages 1–2 are Plan A; stage 3 is Plan B.

### 1. Candidate pool (deterministic, no AI)

Built from what the user already has:

- their **recipes** (per-serving macros already computed by #25)
- their **saved meals**
- `memory.Frequent` and `memory.UsualMeals` (90-day log history, already
  derived by `internal/memory`)

Each candidate carries known macros and a slot affinity — a saved meal and a
`memory.Meal` both already record `meal_slot`; a recipe does not, so its
affinity is inferred from how the user has logged it, defaulting to any slot.

### 2. Fitting (deterministic, pure)

Fill each day's requested slots to approach `target_kcal` and
`target_protein_g`, subject to a variety rule: the same candidate may not
repeat within N days (N=2 for v1).

This stage is **pure arithmetic over known numbers** — no DB, no AI, no clock.
It is the heart of the feature and is unit-tested exhaustively in isolation.
Targets are genuinely hit rather than approximated, because every candidate's
macros are known before selection.

Protein is weighted above carbs and fat in the fit: it is the macro users
actually miss, and the existing coach nudges already treat it that way.

### 3. Gap fill — exactly one AI call per generation (Plan B)

Runs only when the pool cannot fill the requested slots (a new user with no
recipes and no history) or the macro error stays above threshold after fitting.

**One `GenerateText` call for the entire week, never one per slot.** It receives
every unfilled slot at once plus the cuisine/preference steer, and returns dish
suggestions, each of which is then resolved through the food index exactly as
recipe parsing resolves an ingredient. A suggestion the index cannot match
leaves the slot **empty and reported** — never fabricated.

The one-call rule is not a nicety. 21 slots at a call each would be
unaffordable under the $5/user cap and far outside the mobile client's 25s
request deadline — the exact failure that made recipe parsing 502 in production
before #25 shipped. The call runs behind the same budget gate and metering
built for recipes, with its own `CallType`.

### 4. Preferences

The free-text cuisine/preference steer feeds **only** the stage-3 call. Stages
1–2 ignore it: the user's own recipes and history already encode their
preferences, and filtering a small pool by free text would mostly produce empty
plans.

## Nutrition invariant

Unchanged from #25 and stated again because stage 3 is a new place to break it:
**every kcal and macro figure originates in a `nutrition.FoodItem` row, a
recipe computed from those rows, or a saved meal computed from those rows.**
The model supplies dish identity only. The gap-fill prompt does not ask for
macros, and any the model volunteers are discarded.

## HTTP surface

All under the authed `/v1` group, `{data}` envelope via `httpx.OK`, 201s as
`c.JSON(http.StatusCreated, gin.H{"data": v})`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/meal-plans/generate` | build an **unsaved draft**; persists nothing |

`/generate` exists in **both** plans and does not change shape between them. In
Plan A it returns a purely deterministic draft, with any slot the candidate pool
could not fill left empty and reported. Plan B fills those same slots via the
single AI call before returning. The request and response contracts are
identical, so the mobile client written in Plan A needs no change when Plan B
lands.
| GET | `/v1/meal-plans` | list the caller's plans |
| POST | `/v1/meal-plans` | persist a confirmed draft |
| GET | `/v1/meal-plans/:id` | detail with per-day macros and adherence |
| PUT | `/v1/meal-plans/:id` | replace name/items wholesale |
| DELETE | `/v1/meal-plans/:id` | delete |
| POST | `/v1/meal-plans/:id/items/:itemId/log` | one-tap log of one planned item |

Generate-returns-a-draft mirrors `/v1/recipes/parse`: an abandoned generation
leaves no rows.

The log endpoint **dispatches by `source_kind`** into paths that already exist
and are already tested:

- `recipe` → `recipes.Service.LogRecipe` (fan-out to one food log per resolved
  ingredient, grams scaled by servings)
- `saved_meal` → the existing batch-log path
- `food` → a single food log

It introduces no new logging semantics. `Source` on the resulting logs is
`"plan"`, registered in `metrics.knownSources` at the same time — the #25
review found `"recipe"` missing there, which silently bucketed every recipe log
into `"other"`.

A plan owned by another user is a **404, never a 403**.

## Mobile

- `src/api/hooks.ts`: `useMealPlans`, `useMealPlan`, `useGenerateMealPlan`,
  `useCreateMealPlan`, `useUpdateMealPlan`, `useDeleteMealPlan`,
  `useLogPlanItem`.
- `app/plans.tsx` — list; `app/plan/[id].tsx` — week view, one day per section,
  each item showing its macros and a log affordance.
- A generation sheet modelled on `RecipeParseSheet`: choose slots, optional
  preference text, show progress while pending, then an editable draft.
- Reachable from the More tab beside Recipes, and from the Log screen.
- Every mutation surfaces errors via toast — never an `isPending`-gated button
  left disabled with no error surface (#83).
- A day whose targets are not met shows the gap plainly. A plan is allowed to be
  imperfect; it is not allowed to look complete when it isn't.

## Error handling

- Invalid input → `httpx.ValidationError` → 400.
- Unknown or foreign plan id → 404.
- **A plan that cannot meet targets is not an error.** It is returned with the
  shortfall reported per day, exactly as a recipe with unresolved ingredients is
  returned with `unresolved_count`.
- Gap-fill provider failure → the draft is still returned with those slots
  empty and flagged. Generation degrades; it does not fail.
- Budget exhausted (429) → the deterministic draft is still returned, with a
  message saying AI suggestions were skipped. The user gets a plan either way.

## Testing

- **`fit.go` is pure** — no DB, no AI, no clock — and gets the densest tests in
  the package: targets met within tolerance, variety rule honoured, empty pool,
  pool smaller than the slot count, targets unreachable, protein weighting.
- **repository** against the real schema: the one-source CHECK rejects a
  malformed item, cascade behaviour, ordering by (day, position).
- **service/handler**: owner scoping (another user's plan is 404), draft
  persists nothing, log dispatch hits the right underlying path per
  `source_kind`.
- **Plan B**: stubbed provider for gap fill, plus a `//go:build smoke` test that
  drives generation through a real `ai.Router` and asserts elapsed time, per the
  standing lesson that stubbed providers hide budget and output-shape defects.
- Mobile: Jest for hooks, week view, and the generation sheet including the
  budget-exhausted path.

## Out of scope

Shopping list (sub-project 3); sharing of any kind (sub-project 4); budget,
prep-time and pantry constraints (#33); auto-logging; plan templates; grocery
prices.
