# Post-log correction & edit loop — design

**Issue:** #20 · **Date:** 2026-07-31 · **Milestone:** R1

## Why

R1's bar is "someone who isn't you can onboard and log unaided, safely". A beta
user who cannot fix a wrong AI estimate either gets stuck or quietly stops
trusting the numbers. Logging is well covered; *fixing* a log is not.

## What already exists

More of #20 is built than the issue implies, but not where the issue looks.

| Capability | State |
|---|---|
| `PATCH /logs/:id` (`EditLog`) — edit food, portion, slot, time | built; macros recomputed server-side, never client-supplied |
| `DELETE /logs/:id` | built |
| `correction_phrase` → `food_aliases` write | built server-side, **unreachable** — no client sends it |
| `app/meal.tsx` sheet — portion, slot, repeat, delete | built |
| Undo-toast idiom (`useInstantLog` → toast → delete) | built, used only for fresh instant-logs |
| Personal Food Memory | **derived from logs**, not a stored mapping — fixing a log fixes memory for free |
| `GET /foods?q=` | built, index-only (alias → full-text → embedding), **no LLM** |

## The four gaps

1. **No way to change which food a log is.** `meal.tsx` receives stringified
   route params and never sees `food_item_id`. Portion and slot only.
2. **The original phrase is never persisted.** `LogFood` sets
   `Description: item.Name` — the *resolved* name, not what the user typed. So
   `correction_phrase` has nothing to fill it with, and the teach-the-index
   loop cannot work at all.
3. **`food_aliases` has no `user_id`.** One user correcting "rice" → quinoa
   changes resolution for every user, on the first correction, with no
   threshold — and the alias tier scores `1.0`, the highest, so a wrong alias
   is maximally sticky. Prod row count is 0 and there is no seed data
   anywhere, so this is a personal-correction table that is accidentally
   global. Cheapest possible moment to fix it.
4. **No undo** on edit, and none on delete-from-detail.

## Decisions

| Question | Decision |
|---|---|
| Re-run inference or manual edit? | **Manual pick by default, re-run opt-in.** Free index search is the default path; an explicit "Ask Kora again" tap spends the AI call. Corrections cluster exactly where the model was already wrong, so an automatic re-run risks being wrong twice at cost. |
| Alias scope? | **Per-user**, nullable `user_id` (NULL = curated/global). |
| Signal strength before an alias applies? | **First correction, immediately.** This question only had force while aliases were global; scoping them per-user dissolves it. Undo is the escape hatch. |
| How to get the wrong phrase? | **Persist `input_phrase` on the log** at create time. |
| Undo scope? | Toast-lifetime undo that reverts the log **and retracts the alias the edit created**. A silently-persisting alias the user explicitly took back is precisely the trust erosion #20 exists to prevent. |
| Slicing? | Two PRs — backend, then mobile branched off `main` **after** PR1 merges. Not stacked. |

## Data model

Migration `000020_log_corrections`. Next free number; prod is v19 and the chain
is verified clean.

```sql
ALTER TABLE food_logs    ADD COLUMN input_phrase TEXT;
ALTER TABLE food_aliases ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX idx_food_aliases_user_alias ON food_aliases (user_id, lower(alias));
CREATE UNIQUE INDEX idx_food_aliases_unique ON food_aliases (user_id, lower(alias), food_item_id);
```

Both columns are additive and nullable — nothing to backfill, and the down
migration is two `DROP COLUMN`s.

- **`food_logs.input_phrase`** — the raw text the user said or typed. Set only
  on resolve-sourced logs (`source` = text/voice). NULL for manual, memory,
  barcode, photo and batch logs. `Description` keeps its current meaning (the
  resolved food's name); the two are deliberately different fields.
- **`food_aliases.user_id`** — NULL = curated/global (none exist today),
  non-NULL = personal.
- The unique index closes the check-then-insert race in the current
  `AddAlias`. Postgres treats NULL `user_id` as distinct per row, so global
  aliases are not deduped by it. Acceptable while zero exist; recorded in the
  migration rather than reaching for `NULLS NOT DISTINCT` for a case that does
  not occur.

## API

### `GET /logs/:id` (new)

Returns the full `FoodLog`. Needed because the correction sheet requires
`food_item_id`, `source` and `input_phrase`, none of which survive the route
params. Another user's log returns 404, not 403 — consistent with `Delete`.

### `PATCH /logs/:id`

- **Remove** client-supplied `correction_phrase` from `EditRequest`. The server
  derives it from the log's own `input_phrase`, so a client cannot mint an
  alias for a phrase the user never uttered. This deletes a field that exists
  and is tested today; server-derived is the same value, unforgeable, and the
  client no longer has to remember anything.
- **Add** `retract_correction bool`.
- **Response** becomes `{"data": <FoodLog>, "meta": {"alias_recorded": bool}}`
  via a new additive `httpx.OKWithMeta`. No other endpoint changes shape. This
  exists so the toast cannot claim "Kora will remember" when the best-effort
  alias write failed.

**Alias write** — on food change, when `input_phrase` is non-NULL: automatic,
immediate, personal, no threshold. Still best-effort: a failure logs and does
not fail the edit, as today.

**Alias retraction** — when `retract_correction` is true, delete the personal
alias `(user_id, current.input_phrase, current.food_item_id)` *before* applying
the revert. The key is the food being reverted **away from** — that is the one
the correction taught.

### `nutrition.Repository.Resolve`

Gains a leading `userID uuid.UUID`; `uuid.Nil` means global-only. Three call
sites: `ai/resolver.go:248`, `ai/resolver.go:314` (both already hold the user
ID) and `nutrition/handler.go:27` (reads it from the auth context).

Tier 1 becomes: personal aliases, then global — both scored `1.0`, personal
added first so it wins the existing dedup.

### Re-run

No new endpoint. The client posts the corrected phrase to the existing
`POST /resolve/text` and PATCHes the chosen candidate.

### `POST /logs`

`LogRequest` gains `input_phrase`, populated by the text and voice capture
flows.

## Mobile

`app/meal.tsx` becomes the correction sheet. It keeps painting immediately from
the existing route params — no blank sheet — then reconciles against a new
`useLog(id)` fetch.

- **Change food** — the food name row becomes tappable, opening a search picker
  backed by a new `useFoodSearch` hook over `GET /foods?q=`. Selecting PATCHes
  `food_item_id`; macros return recomputed.
- **"Ask Kora again"** — rendered only when `input_phrase` is non-null. Opens an
  input prefilled with the original phrase, posts to `POST /resolve/text`, and
  presents candidates in `capture.tsx`'s existing presentation.
- **Undo** — `toast.show({ message, actionLabel: "Undo" })`, the `useInstantLog`
  idiom. Edit-undo PATCHes back the retained prior values, adding
  `retract_correction: true` when `meta.alias_recorded` was true. Delete-undo
  re-POSTs the retained record.

### Design fidelity

`design-system/ui_kits/kora/MealDetail.jsx` has steppers, delete and save but
**no food-change affordance**. The correction UI is new ground: extend within
the mockup's visual language (FoodTile, Overline section headers, existing
Button variants) rather than match it pixel-for-pixel.

### Stated limitations

- **Delete-undo mints a new log id.** Anything holding the old id will not
  follow. Invisible for a diary entry in practice; a true restore needs the
  soft-delete design that was ruled out as more than R1 requires.
- **Photo logs get no re-run and no alias.** A photo carries no user phrase, so
  there is nothing to teach the index with.
- **Undo is toast-lifetime only.** It does not survive an app restart, and it
  covers only the immediately preceding edit. Correcting a log twice leaves the
  first correction's alias in place — the second undo retracts only the second
  alias. Alias management UI is out of scope for R1.

## Error handling

- Alias write and alias retraction are best-effort; both log and neither fails
  the edit.
- `GET /logs/:id` on another user's log → 404.
- A `food_item_id` that does not exist → 400 `food_item_id not found` (the
  existing `EditLog` branch, which already distinguishes this from a missing
  log).
- Food search failure surfaces inline in the picker; the sheet stays open with
  the prior value intact.
- Re-run failure surfaces inline and leaves the log untouched.

## Testing

TDD — tests first, and each behavioural test gets a break-it-to-prove-it check
that reverts the **whole** behaviour, not one line. A partial revert can leave
an early return that hides the bug and lets the test pass anyway.

**Migration** — verified against a genuinely **fresh** database migrated to v20,
not an incremental apply. This is the failure mode that took CI down for weeks.

**Go**
- Personal alias beats global for the same phrase.
- Another user's personal alias is invisible.
- Alias written on food change when `input_phrase` is set; **not** written when
  it is NULL.
- Retraction deletes the row keyed on the food being reverted away from, and
  leaves other aliases intact.
- `GET /logs/:id` returns 404 for another user's log.
- `alias_recorded` in `meta` reflects the actual write outcome.

**Mobile**
- Picker PATCHes `food_item_id`.
- "Ask Kora again" is absent when `input_phrase` is null.
- Undo issues the reverting PATCH carrying `retract_correction`.

**Commands**
- `cd api && go vet ./... && go test -race -p 1 -count=1 ./...`
- `cd apps/mobile && npx tsc --noEmit && npm test`
- Do **not** run `go run ./cmd/seed` — it breaks two nutrition tests.

## Acceptance criteria (from #20)

| Criterion | Met by |
|---|---|
| User can change food + portion of any past log, macros recompute server-side | food picker + existing `EditLog` recompute |
| A correction on a memory-backed food updates the remembered mapping | personal alias write; Memory is log-derived, so the log edit updates it directly |
| Undo restores the prior state | edit-undo PATCH + alias retraction; delete-undo re-POST |
| Delete removes the log from dashboard/diary totals | existing `DELETE /logs/:id` |

## Out of scope

Soft delete and revision history; alias management UI; cross-user or curated
alias curation; confidence tiers (#21, separate); a threshold before a
correction takes effect (dissolved by per-user scoping).
