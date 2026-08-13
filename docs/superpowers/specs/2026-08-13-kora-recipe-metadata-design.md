# Recipe Metadata: Tags & Steps — Design

**Date:** 2026-08-13
**Relates to:** #25 (recipes, shipped), #146 (social recipes, parked), #31 (meal planner, parked)

## Problem

Two gaps in recipes as shipped, both fixed here because they are the same
change: metadata that the parser already has and either discards or never asks
for.

**No method.** A saved recipe carries ingredients and macros but no cooking
instructions. The parse receives the full pasted text — "Rinse the lentils…
simmer covered for 25 minutes" — extracts the ingredient lines, and **throws
the method away**. The data is already in hand and dropped. A recipe you cannot
cook from is half a recipe, and #146 makes it worse: publishing a recipe to
strangers with no instructions is not a shippable thing.

**No organisation.** The list is reverse-chronological only, capped at 100 per
user — well past where scrolling stops working. There is no way to answer "what
vegetarian dinners do I have?".

Both also serve parked work: public recipe search in #146 needs more than name
matching, and the meal planner (#31) wants dietary constraints it can filter a
candidate pool by.

## Why one piece of work

Tags and steps are both recipe metadata, both ride the **same** parse call,
both need the same migration, and both appear on the same three surfaces (parse
review sheet, recipe detail, recipe list). Splitting them means two migrations,
two edits to the same prompt, and two passes over the same screens for no
review benefit.

## Scope decisions

- **AI-suggested, user-editable.** The parser already reads the whole recipe,
  so it returns suggested tags in the *same* call — no extra provider request,
  no extra cost, no extra latency. The user confirms or edits them in the
  review sheet that already exists. This matters because hand-typed-only tags
  leave most recipes untagged, and a filter over mostly-untagged recipes is
  worse than no filter at all.
- **Normalised free-form.** Any tag is allowed, but it is lowercased, trimmed
  and de-duplicated on save, so `Vegetarian`, `vegetarian ` and `VEGETARIAN`
  collapse to one. Flexible without fragmenting the filter list into
  near-duplicates.
- **Not a controlled vocabulary.** A fixed list never fits everyone and becomes
  a product-maintenance burden. Revisit only if #146 ships and public search
  demands it.

## Data model — migration `000030`

```sql
CREATE TABLE recipe_tags (
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    PRIMARY KEY (recipe_id, tag)
);

-- Carries the filter and the tag-list query.
CREATE INDEX ix_recipe_tags_tag ON recipe_tags (tag);

CREATE TABLE recipe_steps (
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    text      TEXT NOT NULL,
    PRIMARY KEY (recipe_id, position)
);
```

**Tags are a set; steps are a sequence.** That difference is the whole reason
they are two tables rather than one metadata blob. `recipe_tags` keys on
`(recipe_id, tag)` so the database enforces de-duplication and no surrogate id
is needed; tags render alphabetically, so the same recipe always looks the same.
`recipe_steps` keys on `(recipe_id, position)` because order *is* the meaning —
step 3 before step 2 is a different recipe.

`ON DELETE CASCADE` on both matches `recipe_ingredients`.

Steps are stored as an ordered list rather than one text blob so a
step-by-step cook mode, and later publishing in #146, need no re-parsing of
prose. That costs almost nothing now and cannot be retrofitted cheaply.

## Normalisation

A tags-specific `normalizeTag` in `internal/recipes`:

- lowercase, trim
- collapse internal whitespace to single spaces
- keep letters, digits, spaces and hyphens; drop everything else
- reject empty results; cap at 30 characters
- de-duplicate within a recipe (the PK enforces it, but the service returns a
  clean set rather than relying on a constraint violation)

**`nutrition.Normalize` is deliberately NOT reused.** It singularises and
strips punctuation for food-index matching, which would turn `high-protein`
into `high protein` and `greens` into `green`. Tags are a different domain, and
coupling them would mean a change to food matching silently rewriting users'
tags.

Limit: **10 tags per recipe**. Beyond that they stop being a filter and become
noise.

## Steps

An ordered list of plain-text instructions. Limits: **40 steps** per recipe,
**500 characters** per step. A step that is empty after trimming is dropped;
positions are reassigned from list order on every write, so the caller never
has to keep them in sync (the same rule `insertIngredients` already follows).

**Steps never affect macros.** They are descriptive text and are excluded from
every nutrition path. This is stated explicitly because steps are the first
free text on a recipe that a model produced, and the temptation to read
quantities back out of them ("add another 100g") must be refused — quantities
live in ingredients, which are resolved against the food index.

Steps are replaced wholesale with the rest of the recipe on `PUT`, matching
ingredients and tags. No per-step endpoints.

## AI suggestion

`parseSystemPrompt` gains **`tags` and `steps`** in its JSON schema, and the
`extracted` struct gains `Tags []string` and `Steps []string`. Suggested tags
describe **cuisine, meal type and dietary character** — for example `indian`,
`dinner`, `vegetarian`, `high-protein`. Steps are the method as written,
one instruction per entry, verbatim rather than paraphrased: the user pasted
a recipe they chose, and rewriting its method is not the parser's job.

Constraints on the prompt change:

- **No extra provider call.** Same request, more fields in the response. Cost
  and latency are unchanged, which is why this is worth doing at all.
- The nutrition invariant is untouched: the prompt still must not ask for, and
  the parser still must discard, any macro figure. Tags are descriptive
  metadata, not numbers.
- Suggested tags are normalised through the same `normalizeTag` and capped at
  10 before they reach the draft; steps are trimmed, emptied entries dropped,
  and capped at 40 — so the model cannot inject junk or unbounded text.
- Both arrive in the draft as **suggestions the user edits before saving** —
  the review sheet is already the confirmation step, so this needs no new
  approval surface.

**Photo parsing gets tags and steps only if the model supplies them, and it
generally will not.** `ParsePhoto` runs `IdentifyPhoto` then `Decompose`, which
returns ingredients alone. A photo of a finished dish carries no method, and
inventing one from a guessed dish name stacks inference on inference. A
photo-parsed recipe therefore arrives with no steps, and the user writes them.

## API

`RecipeView` gains `tags []string` (alphabetical) and `steps []string`
(ordered). `SaveRecipeRequest` and `Draft` accept both.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/recipes?tags=a,b` | filter the caller's recipes |
| GET | `/v1/recipes/tags` | the caller's distinct tags with recipe counts |

Filtering is **AND** semantics: `?tags=vegetarian,dinner` returns recipes
carrying both. AND is what a filter-chip UI implies — each chip added narrows
the result. OR would widen it, which reads as broken when you tap a second
chip.

An unknown tag returns an empty list, not a 404: a filter that matches nothing
is a valid, expected outcome.

`GET /v1/recipes/tags` returns counts so the UI can order chips by usefulness
and hide tags with no recipes. It is scoped to the caller, like every other
recipe read.

Tags are replaced wholesale with the rest of the recipe on `PUT`, matching how
ingredients already work — no separate tag endpoints, no second consistency
model.

## Mobile

- **Recipes list**: a horizontally scrolling filter-chip row above the list,
  fed by `GET /v1/recipes/tags`, ordered by count. Tapping toggles a chip;
  multiple chips narrow (AND). A "clear" affordance appears once any chip is
  active. The empty state when a filter matches nothing says so and offers to
  clear, rather than showing the generic "no recipes yet".
- **Recipe detail**: tags render as chips, editable — add via a text field with
  suggestions from the caller's existing tags, remove via the chip. Below the
  ingredients, a numbered **Method** section lists the steps, editable in place,
  with add/remove/reorder. A recipe with no steps shows an "Add method"
  affordance rather than an empty heading.
- **Parse review sheet**: suggested tags appear as chips, each removable, plus
  a field to add more. Extracted steps appear as a numbered, editable list —
  the user confirms the method the same way they confirm the ingredients,
  before anything is saved.
- Errors surface via toast (#83).

## Error handling

- A tag that normalises to empty is dropped silently — the user typed
  punctuation, not a tag; failing the whole save over it would be hostile.
- More than 10 tags → `httpx.ValidationError` naming the limit.
- A tag over 30 characters is truncated at 30 rather than rejected, then
  normalised.
- More than 40 steps → `httpx.ValidationError` naming the limit. A step over
  500 characters is truncated, not rejected — a long step is prose, not an
  attack, and losing the user's whole save over it would be hostile.
- An empty or whitespace-only step is dropped silently, and remaining steps
  are renumbered from list order.
- Malformed `?tags=` (empty segments, trailing commas) is tolerated: segments
  are normalised and empties dropped. A filter is a read; it should be
  forgiving.

## Testing

- **`normalizeTag` is pure** and gets table-driven tests: casing, surrounding
  and internal whitespace, punctuation, hyphen retention, over-length
  truncation, empty result, unicode.
- Service: de-duplication within a recipe; the 10-tag cap; the 40-step cap;
  wholesale replacement on update; tags and steps surviving save → read.
- Repository: AND filter across two tags; filter matching nothing; tag counts
  scoped to the owner; **steps returning in position order after an
  out-of-order write**; cascade on recipe delete for both tables.
- Parse: model-supplied tags normalised and capped; steps trimmed, emptied
  entries dropped and capped; a model returning neither yields a recipe with
  neither; junk dropped.
- **A test asserting steps never reach any macro computation** — the totals for
  a recipe with steps must equal the totals for the same recipe without them.
- Handler: `?tags=` parsing including the malformed cases above.
- Mobile: Jest for the chip row, toggling, AND narrowing, the filtered empty
  state, tag editing on both surfaces, and step add/remove/reorder on both.

## Out of scope

Tag rename or merge across recipes; a global curated tag taxonomy; tag-based
search of *public* recipes (that belongs to #146); tag suggestions drawn from
other users; ingredient-level tags. For steps: a step-by-step cook mode with
timers, per-step images, and linking a step to the ingredients it consumes —
each is its own feature, and the ordered-list storage chosen here is what makes
them possible later.
