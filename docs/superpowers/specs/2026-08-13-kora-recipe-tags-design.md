# Recipe Tags — Design

**Date:** 2026-08-13
**Relates to:** #25 (recipes, shipped), #146 (social recipes, parked), #31 (meal planner, parked)

## Problem

Recipes shipped with no way to organise or find them. The list is
reverse-chronological only, and the cap is 100 per user — well past the point
where scrolling stops working. There is no way to answer "what vegetarian
dinners do I have?".

Tags are also the groundwork for two parked features: public recipe search in
#146 needs something better than name matching, and the meal planner (#31)
wants slot affinity and dietary constraints it can filter a candidate pool by.

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
```

The composite primary key is the whole design: it enforces per-recipe
de-duplication in the database rather than in application code, and needs no
surrogate id. `ON DELETE CASCADE` matches `recipe_ingredients`.

No `position` column. Tags are a set, not a sequence; they render
alphabetically so the same recipe always looks the same.

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

## AI suggestion

`parseSystemPrompt` gains a `tags` field in its JSON schema, and the
`extracted` struct gains `Tags []string`. Suggested tags describe **cuisine,
meal type and dietary character** — for example `indian`, `dinner`,
`vegetarian`, `high-protein`.

Constraints on the prompt change:

- **No extra provider call.** Same request, more fields in the response. Cost
  and latency are unchanged, which is why this is worth doing at all.
- The nutrition invariant is untouched: the prompt still must not ask for, and
  the parser still must discard, any macro figure. Tags are descriptive
  metadata, not numbers.
- Suggested tags are normalised through the same `normalizeTag` and capped at
  10 before they reach the draft, so the model cannot inject junk.
- Tags arrive in the draft as **suggestions the user edits before saving** —
  the review sheet is already the confirmation step, so this needs no new
  approval surface.

Photo parsing gets the same treatment where `Decompose` runs; if the model
returns no tags, the recipe simply has none.

## API

`RecipeView` gains `tags []string` (alphabetical). `SaveRecipeRequest` and
`Draft` accept `tags []string`.

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
  suggestions from the caller's existing tags, remove via the chip.
- **Parse review sheet**: suggested tags appear as chips, each removable, plus
  a field to add more, before the recipe is saved.
- Errors surface via toast (#83).

## Error handling

- A tag that normalises to empty is dropped silently — the user typed
  punctuation, not a tag; failing the whole save over it would be hostile.
- More than 10 tags → `httpx.ValidationError` naming the limit.
- A tag over 30 characters is truncated at 30 rather than rejected, then
  normalised.
- Malformed `?tags=` (empty segments, trailing commas) is tolerated: segments
  are normalised and empties dropped. A filter is a read; it should be
  forgiving.

## Testing

- **`normalizeTag` is pure** and gets table-driven tests: casing, surrounding
  and internal whitespace, punctuation, hyphen retention, over-length
  truncation, empty result, unicode.
- Service: de-duplication within a recipe; the 10-tag cap; wholesale
  replacement on update; tags surviving save → read.
- Repository: AND filter across two tags; filter matching nothing; tag counts
  scoped to the owner; cascade on recipe delete.
- Parse: model-supplied tags normalised and capped; a model returning no tags
  yields a recipe with none; junk tags dropped.
- Handler: `?tags=` parsing including the malformed cases above.
- Mobile: Jest for the chip row, toggling, AND narrowing, the filtered empty
  state, and tag editing in both the detail screen and the review sheet.

## Out of scope

Tag rename or merge across recipes; a global curated tag taxonomy; tag-based
search of *public* recipes (that belongs to #146); tag suggestions drawn from
other users; ingredient-level tags.
