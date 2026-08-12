# Handoff — Recipes (#25), 2026-08-13

Branch `feat/kora-recipes`, 25 commits off `main` (`c48669d`). Sub-project 1 of 5
toward #47 (family/household meal sharing, full scope).

## What this is

#47 at full scope is five independent subsystems, not one. Its stated dependency
#31 (meal planner) itself depends on #25 (recipes), and nothing downstream can
reference a shared, portionable dish until a servings-aware loggable unit
exists. Agreed decomposition and build order:

| # | Sub-project | Issue | Status |
|---|-------------|-------|--------|
| 1 | **Recipes** — paste/photo → ingredients + per-serving macros, loggable | #25 | **this branch** |
| 2 | Meal planner — AI day/week plan against macro targets | #31 | next |
| 3 | Shopping list — aggregate plan ingredients | #31 | |
| 4 | Household — `groups` flavour with shared recipes/plans/lists | #47 | |
| 5 | Log-once-for-many — per-member portions fan out to each diary | #47 | |

Scope decisions settled up front, inherited by the later sub-projects: **paste +
photo only** for v1 (URL import deferred — #25 itself flags the strategy as
unresolved and it carries the worst failure tail); **shared assets only** for
household privacy (recipes/plans/lists shared, diaries stay behind the existing
`share_progress` consent gate); **child accounts deferred** (age ratings and
consent law are a milestone of their own, and an App Review risk next to the R1
F&F beta, #109).

Spec: `docs/superpowers/specs/2026-08-13-kora-recipes-design.md`
Plan: `docs/superpowers/plans/2026-08-13-kora-recipes.md` (carries inline
CORRECTION notes where the plan itself proved wrong — read those before reusing it)

## Done and verified

Backend `api/internal/recipes/` (model / repository / service / parse / log /
handler) over migration `000028`, seven `/v1/recipes*` routes, plus mobile
hooks, list and detail screens, and the parse-review sheet.

- Go: build, vet, `go test ./... -race` green across 30 packages.
- Mobile: `tsc --noEmit` clean, Jest 162 suites / 1320 tests.
- **Driven on device** (iPhone 17 Pro sim): More → Recipes reachable, empty
  state, parse sheet, text entry, pending state.
- **Live AI verified**: paste parse through the production `ai.Router` in 7.16s
  against real Gemini — `TestParseText_ThroughRouter_Smoke` (`-tags smoke`).

Live parse of a real recipe against the 7,881-food index resolved all seven
ingredients, four with measured portions and three honestly flagged as
estimates:

```
"200g red lentils"   -> Lentils, pink or red, raw   200.0g  measured
"1 tbsp vegetable oil"-> Vegetable oil                14.0g  measured
"1 medium onion"     -> Onion, raw                  110.0g  ESTIMATED
"2 cloves garlic"    -> Garlic, raw                   6.0g  measured
"1 tsp ground turmeric"->Turmeric, ground              3.0g  ESTIMATED
"400ml water"        -> Water                       400.0g  measured
"salt to taste"      -> Salt                          6.0g  ESTIMATED
```

## Three defects only the live run caught

Every unit test passed throughout all three. They all stub the AI provider, so
none of them exercised the real provider chain. **This is the lesson worth
carrying into sub-projects 2-5: an AI feature is not verified until it has run
against the real provider through the real Router.**

1. **`Router.GenerateText` used `IdentifyText`'s 1.5s budget** (Critical,
   `9ed1a18`). Recipe extraction measurably takes ~6s, so the primary was killed
   at 1.5s, the NVIDIA fallback was attempted, and the request 502'd at 25s. The
   feature could not work in production at all. Fixed with a separate
   `generateBudget` (25s); `textBudget` deliberately left at 1.5s because the
   food-resolve hot path depends on that fast failover. **`coach` had the same
   latent bug** (`internal/coach/service.go:137` also calls `GenerateText`) and
   inherits the fix — its Q&A was almost certainly always running on the
   fallback.
2. **The `parse_failed` 502 → manual-editor fallback did not fire against a real
   502** (Important, `a63c0ae`). A passing Jest test asserted it worked; the
   mock's error shape disagreed with what `apiFetch` actually throws. Now keyed
   off HTTP status, and the mock was corrected to match production — that second
   half matters as much as the fix.
3. **Plural units silently discarded the stated quantity** (Important,
   `c856210`). `ParsePhrase("2 cloves")` returned the unit verbatim; serving-unit
   matching is exact, so it missed `"clove"` and fell back to a one-serving
   estimate — "2 cloves garlic" logged as 3g instead of 6g. An AI emits plurals
   constantly, so this was the common case. Fixed in `ParsePhrase` only;
   `ResolveEntered` deliberately untouched because `foodlog` and `savedmeals`
   depend on it.

## Three plan defects caught by review

Corrected in the plan document so sub-projects 2-5 do not inherit them:

- The plan claimed a map-based GORM `Updates` bypasses `autoUpdateTime`. **False
  on gorm v1.31.2** — proved by deliberately breaking the code and watching the
  test still pass. The explicit `gorm.Expr("now()")` workaround and its comment
  were removed.
- The plan added a new `Deps.AIProvider` field; `Deps.Provider` already existed
  and `main.go` assigned both the same instance. Collapsed onto `Provider`.
- The plan's `useParseRecipe` photo branch used `apiFetch`, which forces a JSON
  `Content-Type` and corrupts the multipart boundary. `apiFetchMultipart` is
  correct, per the existing `useResolvePhoto` precedent.

## Reusable primitives (lean on these for sub-projects 2-5)

- **The household seam**: `recipes.user_id` is the owner and every read path is
  scoped by it. Sub-project 4 adds household *visibility* without rewriting
  ownership — a shared recipe stays owned by its author.
- **Unresolved ingredients are a first-class state**, not an error:
  `recipe_ingredients.food_item_id` is nullable, the ingredients read is a
  **LEFT JOIN** (an INNER JOIN silently shrinks the recipe), the row contributes
  zero macros, and `RecipeView.unresolved_count` tells the client the totals are
  partial. `raw_text` is stored even when resolution succeeds, so a later
  re-resolution pass is possible once the food index grows.
- **Macros are never stored** — totals and per-serving figures are computed on
  every read from live food rows, so a food-index correction shows up
  immediately. "Editing servings recomputes macros" is therefore a plain integer
  update with no recomputation code.
- **Logging fans out** to one `food_logs` row per resolved ingredient
  (`grams × requested/yield`), reusing `foodlog.CreateBatch`. No synthetic
  "recipe" row: the diary, `log_corrections`, and memory all operate on
  food-item rows, and a synthetic row would be invisible to the food index and
  uncorrectable. `CreateBatchRequest` gained an optional `Source` (defaults to
  `"memory"`, so every pre-existing caller is byte-identical).
- **`foodlog.ValidMealSlot`** is now the single source of truth for meal slots;
  do not re-declare the map.
- **`portion_assumed` persists onto the row** and is surfaced everywhere,
  including the recipe detail months later. Issue #138 is the standing bug for
  what happens when a guessed portion is rendered as fact.

## Environment traps (cost real time this session)

- **`go test ./...` truncates `food_items`.** The nutrition tests wipe the dev
  food index, which silently breaks live resolve afterwards — every ingredient
  comes back unresolved and the feature looks broken when it is not. Re-seed:
  `cd api && set -a && . ./.env && set +a && go run ./cmd/seed`.
- **The inverse is also true**: a seeded index makes `internal/nutrition`'s
  embedding tests and one `internal/ai` test fail. Confirmed identical on
  `main@c48669d` — it is a shared-dev-DB sensitivity, not a regression. Worth
  its own fix (the tests should own their fixture rather than assume a clean
  table).
- **`main.go` does not load `.env`.** Run the API as
  `set -a; . ./.env; set +a; go run ./cmd/api` or it dies on
  `DATABASE_URL is required`.
- **The food index has zero embeddings** (issue #97's backfill is incomplete),
  so resolution runs on alias + full-text only. Note `parse.go` passes a nil
  query vector to `nutrition.Repository.Resolve`, which disables the embedding
  tier outright — recipe ingredient resolution is weaker than the app's main
  resolve path by construction. Worth revisiting once #97 lands.
- **Mobile lint is broken repo-wide and pre-existing**: eslint 10.8.1 no longer
  provides `eslint/config`, which `apps/mobile/eslint.config.js` requires, so
  `npx eslint` fails on every file including untouched ones. No mobile code has
  been linted for as long as that has been true. Deserves its own fix.
- **gofmt** non-compliance is pre-existing in `ai`, `billing`, `challenges`,
  `nutrition`, `pins`, `savedmeals`, `user`. `internal/recipes/` is clean.
- The dev rig still needs the relaunch dance from
  `HANDOFF-phase3plus.md` (the app hung on splash until a
  `simctl terminate` + `launch`). `idb` tap driving works but is flaky; tap
  points = px/3, and it mangles some typed text.

## Deferred, with reasons

- **URL import** (#25's third input) — its own slice once the paste prompt is
  proven in real use.
- **Re-resolution of unresolved ingredients** — a background retry once the food
  index grows. `raw_text` is stored specifically to make this possible.
- **Embedding tier for recipe ingredient resolution** — see the nil query vector
  above; blocked on #97.
- **A canonical-name endpoint** is no longer needed: the parse draft now carries
  the matched food's `name` (server-populated, ignored on write).
- Minor: the unresolved/estimated row visual language is hand-duplicated across
  `RecipeParseSheet`, `recipe/[id].tsx` and `capture/DetectedCard` — worth an
  extraction.
- Minor: `IngredientRow`'s React key can collide for two unresolved ingredients
  with identical `raw_text` and grams; include the index.
- Minor: upper-bound validation constants (`maxRecipes`, `maxIngredients`, …)
  are untested.

## Likely next moves

1. **Sub-project 2, the meal planner (#31)** — the natural continuation, and the
   reason recipes was built first. Plans reference recipes as loggable items.
2. Fix the mobile eslint config — nothing has been linted in a while.
3. Give the nutrition tests their own fixture so they stop fighting the dev food
   index.
4. Revisit `generateBudget` once real latency data exists; 25s is sized from a
   single ~6s measurement plus headroom.
