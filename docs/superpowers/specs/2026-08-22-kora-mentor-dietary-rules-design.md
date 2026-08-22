# Personal Mentor — structured dietary rules and enforcement

## Problem

`mentor_profiles.dietary_preferences` and `.allergies` are free text. The Coach
grounder already loads them and renders them into every turn's prompt, so both
the `nutrition-guidance` and `plan-meals` skills see them. That is the whole
mechanism: a sentence in a prompt.

Three consequences:

- Nothing in code knows "I don't eat beef" names beef, so nothing can check a
  generated plan against it. Compliance depends on the model.
- `guardrails.Evaluate` screens answers for restrictive language only. There is
  no equivalent asking "does this answer name an excluded food or an allergen?"
- The food layer never sees the profile at all. `/v1/foods` and
  `/v1/resolve/text` rank an excluded food normally, so it can be suggested and
  auto-logged.

For a preference the failure is annoying. For an allergy it is a safety defect.

## Decision

Preferences become a structured rule set that the code can enforce, split by
severity: **allergies hard-block, preferences flag**. An allergy is a medical
constraint and a false negative is unacceptable; a preference is a choice and
suppressing an otherwise good answer over it is worse than annotating it.

Reminders are out of scope. Commitments already project to the device and
schedule through expo-notifications with an offline check-in outbox
(`docs/personal-mentor-rollout.md`); that is the intended architecture and this
work does not change it.

## Data model

### `mentor_food_rules` (migration 000043)

One row per constraint.

| Column | Meaning |
|---|---|
| `id` | UUID primary key |
| `user_id` | owner, `ON DELETE CASCADE` |
| `subject` | canonical token: `beef`, `peanut`, `gluten` |
| `kind` | `allergy` · `exclusion` · `preference` |
| `severity` | `block` · `flag` |
| `label` | what the user typed, for display |
| `source` | `user` · `pattern` · `coach` |
| `confirmed_at` | NULL means proposed and not yet in force |

`UNIQUE (user_id, subject)` — one rule per food per user; a second statement
about the same subject updates the existing row rather than stacking.

Severity is stored, not derived from `kind` at read time. Derivation would make
every consumer re-implement the mapping, and it forecloses a user marking a
non-allergy exclusion as strict (religious or ethical exclusions are absolute
for the people who hold them, and guessing otherwise on their behalf is the
wrong default).

One table rather than separate allergy and exclusion tables: they differ only in
severity and user-facing copy, and splitting them duplicates every query and
every join.

### `mentor_profiles.diet_pattern`

`vegetarian` · `vegan` · `jain` · `halal` · `eggetarian` · `pescatarian` · `''`.

A pattern is a preset that expands into `mentor_food_rules` rows with
`source='pattern'` when written. Enforcement therefore reads one place. The
alternative — a pattern flag the matcher special-cases — would mean every gate
carries a second code path that the rule path already covers.

### `food_items.diet_tags TEXT[]`

Derived facts about a food: `contains-beef`, `contains-peanut`,
`contains-dairy`, `vegetarian`. GIN index for `diet_tags && $1` containment.

Populated during ingest. The curated converters already build each dish from a
weighted ingredient list — `in_dishes_convert.py` composes Pakhala bhata from
`rice_raw`, `curd`, `water` — so they emit an `ingredients` array into the JSON
and tags are derived from it. That is real derivation and stays auditable, the
same principle the macros already follow.

Foods with no ingredient data (OFF, FNDDS, AFCD) fall back to name and alias
matching. That fallback is conservative by construction: it matches allergen
*families*, so a false positive costs a swapped suggestion while a false
negative could cost a reaction.

## The `internal/diet` package

The synonym taxonomy lives in Go, not in the database: it is code-shaped,
unit-testable, and adding a synonym should be a reviewed change rather than a
migration and a data edit.

- `taxonomy.go` — canonical subjects with aliases (`beef` → steak, veal,
  sirloin, mince) and allergen families (`peanut`, `tree nut`, `dairy`, `egg`,
  `gluten`, `soy`, `fish`, `shellfish`, `sesame`).
- `Parse(text string) []Rule` — free text to candidate rules. Migrates the
  prose already stored on existing profiles instead of discarding it, and backs
  the extraction path below.
- `Compile(rules []Rule) Profile` — the per-turn compiled rule set.
- `Match(text string) []Subject` — conservative matcher, shared by tagging and
  screening so a food and an answer are judged by identical logic.
- `Screen(text string, p Profile) []Violation` — violations in generated text.
- `TagsFor(name, brand string, ingredients []string) []string` — ingest tagging.

`nutrition.Normalize` is not reused: it singularises for food-index matching,
which would fuse distinct subjects, and sharing it would make a food-search
change silently rewrite dietary rules. `recipes.normalizeTag` sets the
precedent for keeping a domain's normaliser its own.

## Enforcement

`Grounder` already loads the mentor profile; `coach.Context` gains
`DietProfile diet.Profile`, compiled once per turn and shared by every gate.

**1. Prompt.** `Context.Render()` replaces the prose sentence with an explicit
block: `Hard constraints, never recommend: beef, peanut (allergy). Avoid unless
asked: mushroom.` Cheapest gate and it catches most cases, but it is guidance,
not enforcement, which is why gates 2 and 3 exist.

**2. Output screen.** `diet.Screen` runs on every Coach and Planner answer,
beside `guardrails.Evaluate` and in the same seam.

- A `block` violation re-asks once with the violated constraint restated. If
  the retry also violates, the user gets an honest message naming the
  constraint rather than the plan. Silently returning a violating plan is the
  failure this exists to prevent; silently returning nothing is nearly as bad.
- A `flag` violation passes through with `Answer.DietFlags` populated, so the
  client can annotate the item and offer a swap.

For the planner path the screen runs after `reviewPlan`, so it judges the text
the user will actually see.

**3. Food layer.** Resolve and search drop `block`-tagged candidates and
de-rank `flag`-tagged ones, so an excluded food cannot reach a suggestion or an
auto-log in the first place.

## Capture

Typing into a settings box is not the main path. When a user says "I don't eat
beef" in chat, the Coach extracts a **proposed** rule (`confirmed_at` NULL)
surfaced for one-tap acceptance, reusing the `mentor_commitment_proposals`
pattern that already works. Nothing enters force without confirmation, which
keeps the existing "user-confirmed" property of mentor context true.

Endpoints: `GET/PUT/DELETE /v1/mentor/food-rules`. The profile's free-text
fields stay — they are how a user says something the taxonomy has no token for —
but on write they also produce parsed candidate rules.

## Backfill

- Existing profiles: `diet.Parse` over stored `dietary_preferences` and
  `allergies`, written as proposed rules. Nothing becomes enforcing without the
  user confirming it.
- Existing foods: a `cmd/dietag` pass over `food_items`, idempotent and
  re-runnable, alongside the seed Job the same way `cmd/embed` already runs.

## Testing

- `diet`: table-driven tests for `Parse`, `Match`, `Screen` and `TagsFor`,
  including the negative cases that matter — "beef is a common iron source, but
  you avoid it" must not screen as a violation, while "Monday: beef stir-fry"
  must.
- `coach`: an answer violating a `block` rule re-asks and, on a second
  violation, does not reach the user; a `flag` violation reaches the user with
  flags attached.
- `nutrition`: blocked tags absent from resolve candidates; flagged tags
  de-ranked but present.
- Migration up/down against a real PostgreSQL, matching existing practice.

## Deployment

Migration 000043 is additive and applies through the existing `migrate`
initContainer. The API is backward compatible: a user with no rules behaves
exactly as today. Mobile ships after, since the rules UI and flag annotation
depend on the endpoints.

Kora keeps its migrations in `api/internal/database/migrations/`, not in
`tesserix-k8s/db-schema-bootstrap`, per kora#118. This follows the repository's
established pattern rather than forking convention mid-feature.
