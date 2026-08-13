# Social Recipes — Design

**Date:** 2026-08-13
**Relates to:** #25 (recipes, shipped), #47 (household sharing), #31 (meal planner)
**Status:** new programme, inserted ahead of the meal planner

## Why this exists, and why now

Recipes shipped on 2026-08-13. Designing the meal planner (#31) immediately
exposed their weakness: the planner's deterministic candidate pool is built
from the user's own recipes, saved meals and log history, so for a new user it
is **empty**. That is the entire reason the planner needs an AI gap-fill leg.

Letting people publish recipes and save each other's fills that pool
organically, cheaply, and with real food rather than model output. The two
features feed each other, which is why this is sequenced ahead of #31.

## Scope decisions

- **Asymmetric follow graph and public recipes.** Chosen over reusing the
  existing mutual-friendship graph. Kora therefore runs **two** social models:
  `internal/social` (mutual friendship — friends, compare, groups, challenges)
  and this one (asymmetric follow — recipe distribution). Every future social
  feature must state which it means. This is a real, permanent cost and was
  accepted deliberately.
- **Sequenced before the meal planner (#31).** #31's spec is written and
  committed on `feat/kora-meal-planner`; it is parked, not abandoned.
- **Safety is in scope from slice 1.** Publishing to strangers without
  reporting and blocking is not a shippable state.

## Decomposition — three slices

| # | Slice | Ships |
|---|-------|-------|
| 1 | **Publish & discover** — visibility on recipes, browse/search public recipes, save-as-fork, report, block | A user can publish a recipe, find someone else's, and save it. Usable with no graph at all. |
| 2 | **Follow graph** — follow/unfollow, follower/following lists, author profile | Following someone surfaces their published recipes in one place. |
| 3 | **Feed** — recipes from people you follow, paginated | The social product proper. |

The order is forced by dependency: publishing is useful without follows,
follows are useless without published content, a feed is meaningless without
both. Each slice gets its own implementation plan.

**This spec covers all three, in the depth each needs. Slice 1 is specified to
implementation detail; slices 2 and 3 to interface detail, to be expanded when
their plans are written.**

---

# Slice 1 — Publish & discover

## Data model — migration `000030`

```sql
-- Visibility on the existing recipes table. Default private: publishing is an
-- explicit, reversible act, never a side effect of creating a recipe.
ALTER TABLE recipes
    ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
        CHECK (visibility IN ('private','public')),
    ADD COLUMN published_at TIMESTAMPTZ NULL,
    -- Attribution for a forked copy. Points at the recipe this was saved from.
    -- ON DELETE SET NULL: the original author deleting their recipe must not
    -- delete the copies people saved.
    ADD COLUMN forked_from_recipe_id UUID NULL REFERENCES recipes(id) ON DELETE SET NULL,
    -- Snapshot of the original author, so attribution survives the original
    -- being deleted, unpublished, or the author changing their display name.
    ADD COLUMN forked_from_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN forked_from_author_name TEXT NOT NULL DEFAULT '';

-- Public recipes are read by strangers; this index carries the browse path.
CREATE INDEX ix_recipes_public ON recipes (published_at DESC)
    WHERE visibility = 'public';

CREATE TABLE recipe_reports (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id   UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason      TEXT NOT NULL CHECK (reason IN ('spam','inappropriate','dangerous','copyright','other')),
    detail      TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','actioned','dismissed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_recipe_reports_once ON recipe_reports (recipe_id, reporter_id);
CREATE INDEX ix_recipe_reports_open ON recipe_reports (created_at DESC) WHERE status = 'open';

CREATE TABLE user_blocks (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_blocks_not_self CHECK (blocker_id <> blocked_id)
);
CREATE UNIQUE INDEX ux_user_blocks_pair ON user_blocks (blocker_id, blocked_id);
```

`forked_from_author_name` is a deliberate denormalisation. Attribution must
survive the original recipe being deleted and the original author being
deleted — a foreign key alone cannot carry a name through
`ON DELETE SET NULL`.

## Saving is a fork, never a reference

Saving another user's public recipe **copies** the recipe and all its
ingredients into the saver's own rows, with `forked_from_*` set for
attribution.

This is the single most important decision in the slice:

- Your copy is yours. Editing servings or ingredients does not mutate the
  original, and the original changing does not silently change your macros.
- **The meal planner (#31) references recipes by FK with `ON DELETE CASCADE`.**
  If a plan could point at another user's recipe, that user deleting it would
  silently gut your week. Forking makes this structurally impossible.
- Unpublishing is therefore not a retraction. Copies already saved remain,
  because they are the saver's own rows. **The publish screen must say this
  before the user publishes.** Anything else would be a false promise.

The copy carries over ingredients including `portion_assumed`, `match_score`
and `match_tier` — a forked recipe must not launder a guessed portion into
something that looks measured. #138's rule applies across the fork boundary.

## Visibility rules — one predicate, one place

A recipe is readable by a user when:

```
recipe.user_id = viewer          -- your own, any visibility
OR (recipe.visibility = 'public'
    AND NOT blocked_either_way(recipe.user_id, viewer))
```

`blocked_either_way` is symmetric: a block hides the blocker's content from the
blocked user **and** vice versa. One-directional blocking lets a blocked user
keep watching, which is not what blocking means to the person who used it.

**This predicate lives in exactly one place** — a repository method every read
path calls. The #25 final review found the "one visibility predicate" claim was
directionally true but literally false, with the ownership filter inlined
across five repository methods. Do not repeat that here: the predicate is one
function, and adding a read path means calling it, not copying it.

Writes are never affected by visibility: only the owner may update or delete,
regardless of who can read.

## HTTP surface

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/recipes/:id/publish` | set visibility public, stamp `published_at` |
| POST | `/v1/recipes/:id/unpublish` | back to private; existing forks unaffected |
| GET | `/v1/recipes/public` | browse public recipes, newest first, paginated |
| GET | `/v1/recipes/public/search?q=` | search public recipes by name |
| GET | `/v1/recipes/public/:id` | read one public recipe |
| POST | `/v1/recipes/public/:id/save` | fork into the caller's own recipes |
| POST | `/v1/recipes/public/:id/report` | report content |
| POST | `/v1/users/:id/block` | block a user |
| DELETE | `/v1/users/:id/block` | unblock |
| GET | `/v1/blocks` | list who the caller has blocked |

Existing `/v1/recipes*` routes are unchanged and stay owner-scoped.

A recipe that is private, or whose author is blocked either way, is a **404**
on every public path — never a 403. A 403 confirms the recipe exists, which
leaks exactly what blocking is meant to prevent.

Admin takedown reuses the existing `/v1/admin` group (`internal/admin`), which
already carries `bffauth` and mutation auditing: an admin can force a recipe
private and mark reports actioned. No new admin auth surface.

## Rate limiting and abuse

- Publishing, saving, reporting and blocking are all mutations by
  authenticated users; each is capped per user per day at the handler layer.
  Without this, "publish" is a spam vector the moment the app is public.
- One report per user per recipe, enforced by `ux_recipe_reports_once`.
- Blocking is unlimited — a user must never be rate-limited out of protecting
  themselves.

## Search

`GET /v1/recipes/public/search` searches recipe **name** only, using the same
Postgres full-text approach `nutrition` already uses for foods
(`to_tsvector('simple', ...)`), against a normalised name column. Ingredient
search is out of scope for slice 1: it needs a different index and produces
much noisier results.

## Mobile

- A **Discover** entry point beside Recipes: browse and search public recipes.
- Recipe detail for someone else's recipe: read-only, with **Save**,
  **Report**, and **Block author**. Attribution is shown on any forked copy
  ("Saved from *name*").
- The owner's own detail screen gains **Publish** / **Unpublish**, with the
  publish confirmation stating plainly that copies people have already saved
  will remain if it is later unpublished.
- Reporting is a sheet with the five reasons and an optional detail field.
- Blocking asks for confirmation and explains it is mutual and reversible.
- Every mutation surfaces errors via toast (#83).

## Error handling

- Publishing a recipe with **zero resolved ingredients** is a 400. A recipe
  whose macros are entirely unknown is not something to put in front of
  strangers.
- Saving your own recipe is a 400 with a clear message, not a silent no-op.
- Saving the same recipe twice creates a second copy — copies are ordinary
  recipes and the user may legitimately want two. The UI notes an existing copy
  rather than blocking.
- Report on an already-reported recipe returns 200, not a duplicate-key 500.
- The recipe count cap (`maxRecipes`, currently 100) applies to forks; hitting
  it returns the existing "recipe limit reached" validation error.

## Testing

- **The visibility predicate gets its own dense tests**: own private, own
  public, other public, other private, blocked-by, blocking, and both — each
  asserting read and 404 behaviour.
- Fork tests: ingredients copied including `portion_assumed`/`match_score`;
  original edit does not affect the copy; original delete does not affect the
  copy; attribution survives author deletion.
- Rate-limit tests per mutation.
- Handler tests: 404-not-403 for every unreadable case.
- Mobile: Jest for discover, save, report, block, publish/unpublish flows.

---

# Slice 2 — Follow graph (interface level)

```sql
CREATE TABLE user_follows (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_follows_not_self CHECK (follower_id <> followee_id)
);
CREATE UNIQUE INDEX ux_user_follows_pair ON user_follows (follower_id, followee_id);
CREATE INDEX ix_user_follows_followee ON user_follows (followee_id);
```

Asymmetric and unconfirmed: following needs no acceptance, which is what makes
it different from `internal/social`'s friendship. A block removes any follow in
both directions and prevents re-following.

Endpoints: `POST/DELETE /v1/users/:id/follow`, `GET /v1/users/:id/followers`,
`GET /v1/users/:id/following`, `GET /v1/users/:id/profile` (display name,
counts, their public recipes).

A profile exposes **only** display name, follower/following counts and public
recipes. No email, no macro targets, no diary, no weight — none of it is
social. The existing `share_progress` consent gate governs progress data and is
not weakened by this feature.

# Slice 3 — Feed (interface level)

`GET /v1/feed` — public recipes from followed users, newest first, keyset
pagination on `(published_at, id)`. Excludes blocked users in both directions
via the same predicate. Empty state points at Discover.

No ranking, no algorithm: reverse-chronological. Ranking is a product decision
that needs usage data Kora does not have.

---

## Out of scope for this programme

Comments, likes, and ratings on recipes; images on recipes; direct messaging;
push notifications for social events; verified authors; a web presence for
public recipes. Each is its own feature and none is required for the loop of
publish → discover → save.
