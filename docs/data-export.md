# Data export and deletion

Spec §20 promises three things: you own your data, you can get it out, and you
can have it removed. Issue #24. This page is the second one; deletion is
`user.Service.Delete` and is described at the bottom.

## `GET /v1/me/export`

Synchronous. One request returns one JSON document containing everything the
user owns.

The user id comes from `IDFromContext`, exactly as `DELETE /v1/me`'s does —
there is no user id in the request. An export endpoint that accepted one would
be a way to read any account.

### Why synchronous

Kora is pre-launch: one real account, a 10–15 tester beta ahead of it. An
async job would need a job table, a worker and an expiring-link story, none of
which exist, to solve a problem nobody has.

The point at which this stops being right is when one user's rows no longer
fit comfortably in memory. `food_logs` gets there first, and `Content-Length`
in the access log is what shows it happening.

### The envelope

```json
{
  "format_version": 1,
  "exported_at": "2026-08-26T02:00:00Z",
  "user_id": "…",
  "redacted": [{ "table": "…", "column": "…", "reason": "…" }],
  "counts":   { "food_logs": 412, "weight_entries": 0, … },
  "tables":   { "food_logs": [ … ], "weight_entries": [], … }
}
```

**The table map is keyed `tables`, not `data`, and that is load-bearing.** The
mobile `apiFetch` returns `envelope.data ?? envelope` — the repo-wide
convention for unwrapping `httpx.OK`. A top-level `data` key here would be
indistinguishable from that envelope, so the client would silently receive the
table map alone and drop `format_version`, `exported_at`, `counts` and
`redacted`, with nothing failing anywhere. Do not rename it.

`counts` includes the zeroes, and every table in `export.Tables` is present
with `[]` when the user has no rows. "You have none" and "we did not look"
must not be the same thing in a file any more than in a response body.

## Completeness is the thing this is built against

Not size. An export that silently omits a table added six months from now is
worse than no export, because it looks like it worked — the user gets a
plausible file and nobody can tell their fasting history is missing from it.

Deletion does not have this problem: it delegates to `ON DELETE CASCADE`, so a
new user-scoped table is covered the moment it is created. An exporter has to
name things. Two mechanisms stand in:

**Rows are read as maps, via `SELECT *`.** No Go struct mirrors any table, so
a column added to `food_logs` appears in the export with no code change. This
repo has already shipped four instances of "the Go projection gained a field
and the consumer's type never declared it"; a typed exporter would be the
fifth, and the one nobody would notice.

**Every foreign key to `users(id)` must be accounted for.**
`TestEveryUserScopedTableIsExportedOrExcluded` reads the live schema's foreign
keys and fails if a `(table, column)` pair is neither exported
(`export.Tables`) nor explicitly excluded with a reason
(`export.ExcludedColumns`). Adding a user-scoped table without touching
`tables.go` is a red build that names the table.

Supporting tests, each closing a specific near-miss:

| Test | What it catches |
|---|---|
| `TestEveryExportedTableExistsInTheSchema` | a typo, or a table a migration dropped |
| `TestEveryExportedTableActuallyRuns` | a scope clause naming a column the table lacks (a renamed child FK) |
| `TestScopeClausePlaceholderCountMatchesArgs` | a clause naming the user twice, bound once — `friendships` would export half the graph |
| `TestRedactedColumnsExist` | a redaction rule that silently matches nothing while the file still claims the value was withheld |
| `TestTablesHaveNoDuplicates` | a table exported twice, whose count is then right for neither |
| `TestUserScopedTableCountIsWhatWeThink` | the introspection query itself breaking, which would make every test above pass vacuously |

Word boundaries matter in the coverage check: a substring match would let
`member_user_id = ?` satisfy an obligation to export a column called
`user_id`. That near-miss is tested.

## What is withheld, and why it is declared

Two values are dropped. The test is not "is this sensitive" — the whole file is
sensitive and it is going to the person it is about. The test is **could
someone holding this file act as the user, or act on their devices**:

- `users.apple_refresh_token` — exchanges for access to their Apple identity.
- `device_tokens.token` — anyone holding it can push to their device.

They are **dropped, not nulled** (a null is indistinguishable from a column the
user genuinely has no value for), and the `redacted` array names them with the
reason. Withholding a field and saying nothing makes the export quietly untrue,
which is the same defect as omitting a table. The array is present even when
the user has no such row: it describes the export's rules, not their data.

**There are no photos to export.** `resolve/handler.go` reads an uploaded photo
into memory, sends it to the provider and discards it — nothing persists image
bytes. #24 asked for an image-retention setting; there is nothing to retain, and
that is a stronger position than a toggle.

## Deliberately not followed

`notifications.actor_id` — someone else's notification on which this user was
the actor. Their data, not this user's, and the recipient never consented to it
leaving with a third party.

`retired_handles` has no user column at all, by design (kora#449): a retired
handle must not be traceable back to who held it.

## The app

`app/export-data.tsx`, reached from **Profile → Account → Export my data**,
directly above Delete account — two halves of one promise, in the order someone
leaving would want them.

It fetches the document, writes it to the **cache** directory (a transient
hand-off; iOS purging it is the correct outcome — `captureMedia.ts` uses
documents for the opposite reason) and hands the file URI to the system share
sheet. The file is deleted in a `finally`, including when sharing fails:
leaving one person's entire health history in the cache directory is a copy
nobody accounted for.

No new dependency. `Share` is React Native's own and `expo-file-system` was
already here; `expo-sharing` was not needed.

The filename is dated from the document's own `exported_at`, not the device
clock, so the name and the contents can never disagree.

A double press is latched by a **ref**, not the `pending` state — two presses
dispatched in the same tick both read the pre-commit state from their render
closure and both pass. The same guard `delete-account.tsx` uses.

## Deletion, for completeness

`DELETE /v1/me` → `user.Service.Delete`:

- `DELETE FROM users`, and the schema's `ON DELETE CASCADE` takes every
  user-scoped table with it
- Firebase identity removed — the user genuinely can no longer authenticate
- Apple refresh token revoked
- Avatar object removed from GCS, logging `NEEDS MANUAL CLEANUP` on failure
  (there is no lifecycle reaper — kora#457)
- Handle retired permanently, so nobody can reclaim it and inherit their
  social graph

Hard delete, no purge window. An admin-initiated deletion writes a
`kora_admin_events` row; a self-deletion writes none, because that table is
scoped to admin actions.
