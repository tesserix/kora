# Plan: Console integration (milestone 13)

Executes kora#507 and kora#508, plus the documentation correction both call
for. kora#509 is a platform-side tracking issue with no code in this repo; it
is addressed by a comment, not a task.

## Context

The Tesserix platform console is getting a Kora-rail AI page. Two of its tabs
need numbers only Kora holds (#507) and a third needs AI cost attributable per
user, which requires Kora to stamp the acting user on gateway requests (#508).

Verified against the code on 2026-08-28 before planning:

- `resolveoutcome.AllKinds` declares exactly ten kinds; `Rates.FirstTryRate()`
  returns `(0, false)` on a zero denominator and excludes cache and alias hits.
- `platformadmin` mounts the platformauth group in `routes.go` and renders
  §4.1's `{data, pagination}` envelope through `page()` in `envelope.go`.
- `platformadmin.Money{Amount, Currency}` already exists (health.go).
- `agentgateway.go` already forwards the verified Firebase JWT as
  `X-Kora-End-User-Token` via `delegatedUserOptions(ctx)`, proven by
  `TestAgentGatewayProviderDelegatesTheVerifiedEndUserIdentity`.
- `user.ResolveMiddleware` sets the uid on the **gin** context only; the uid is
  dropped at the Resolver→Provider boundary and never reaches `context.Context`.
- `user.ListForAdmin` is unpaginated by explicit decision and deliberately does
  NOT filter `ai_usage_events` to `outcome='ok'`.

## Global Constraints

- **§4.1 envelope.** Any paged list renders `{data, pagination}` via
  `platformadmin.page()`. `data` is an allocated slice, never nil — a nil slice
  marshals to `null` and defeats a consumer's `?? []`.
- **§4.2 money.** Money is `{amount: <integer minor units>, currency: "<ISO-4217>"}`.
  Never encode a currency in a field name. Use `platformadmin.Money`.
- **§4.3 timestamps.** Every `*_at` / `*_since` is ISO 8601 UTC with an explicit
  offset, rendered through `platformadmin.stamp()`.
- **platformauth, never bffauth.** New routes join the `g` group in
  `routes.go`. `internal/server/platform_admin_routes_test.go` asserts each
  group rejects the other's caller.
- **Never fail a request over telemetry.** Attribution must not introduce an
  error path into an AI call. `ai.OutcomeSink.Record` returns no error by
  design; `billing.Meter.Record`'s error is discarded at all four call sites.
- **Absent is not zero.** An unavailable rate is an absent JSON value, never
  `0.0`. A missing user is a missing header, never a zero UUID or empty string.
- **`user_id IS NOT NULL` on every per-user aggregate.** Deleted users' retained
  rows (#106) and the food-index backfill's embeds (#97) both write NULL and
  neither is a person.
- **Counts only.** No food logs, coach turns, `target_*` values, or
  `firebase_uid` on any new admin response.
- **Do not touch `internal/platformauth/signature.go` or its
  `testdata/vectors.json`.** They are byte-identical to mark8ly's and the
  client's, and are the only thing standing between us and a silent 401.
- `/v1/admin/ai-metrics` is NOT covered by the CI conformance suite, which only
  checks the endpoint kinds declared in `admin-conformance.json`. The Go tests
  are the only enforcement of the constraints above for this endpoint. Do not
  add `ai-metrics` to `admin-conformance.json` — the suite would 404 on an
  endpoint kind it has no definition for.
- No prettier. Go code is formatted with `gofmt` only.

---

## Task 1 — Stamp the acting user's UUID on gateway requests (#508)

Give the AgentGateway provider the acting user's `users.id` UUID, so the
platform ledger can attribute AI cost per user.

### Why a context value, not a parameter

`ai.Provider`'s methods take only a `context.Context`. Threading a `userID`
parameter through every provider method and every call site is precisely the
"per call site" approach #508 forbids: a new call type would ship unattributed
by omission. The gateway file already solves this exact problem once, for the
end-user token, with a context value read at request-construction time. Mirror
it.

### Files

**`api/internal/user/middleware.go`**

`ResolveMiddleware` currently does `c.Set(contextUserID, uid)`. Additionally
stamp the request's `context.Context` so the value survives into every
downstream `ctx`, including the one handed to `ai.Resolver` and thence to the
provider:

```go
c.Request = c.Request.WithContext(WithID(c.Request.Context(), uid))
```

Add the context plumbing in the same file, next to the existing gin helpers:

- an unexported context key type (do not use a bare string key)
- `func WithID(ctx context.Context, id uuid.UUID) context.Context`
- `func IDFromRequestContext(ctx context.Context) (uuid.UUID, bool)`

Name the reader distinctly from the existing gin-context `IDFromContext(c
*gin.Context)`, which stays exactly as it is — every current caller keeps
working untouched.

**`api/internal/ai/providers/agentgateway.go`**

Add a header constant beside the existing four:

```go
gatewayUserHeader = "X-Kora-User-Id"
```

Add, directly beneath `delegatedUserOptions`:

```go
// userAttributionOptions stamps the acting user's Kora UUID so the platform
// ledger can attribute cost per user (kora#508).
//
// The UUID and nothing else. The gateway does not need to know who someone is
// to attribute what they spent, and a pseudonymous id keeps the telemetry
// pipeline out of the personal-data path.
//
// Absence is a real case and stays legible: cmd/embed's backfill has no user
// by construction, and sends no header rather than a zero UUID -- a
// placeholder would make "no user made this call" indistinguishable from "we
// failed to record who did".
func userAttributionOptions(ctx context.Context) []option.RequestOption {
	id, ok := user.IDFromRequestContext(ctx)
	if !ok {
		return nil
	}
	return []option.RequestOption{option.WithHeader(gatewayUserHeader, id.String())}
}
```

Then compose it with the existing per-request options so BOTH are applied at
every gateway call. `provider.options` is currently assigned
`delegatedUserOptions`; replace that with a composed function returning the
concatenation of both option sets. Keep `delegatedUserOptions` and its existing
test intact.

Check the import direction before writing: if `internal/user` importing or
being imported by `internal/ai/providers` would create a cycle, put the context
key and its two accessors in a small leaf package instead (mirroring how
`internal/auth` holds `WithVerifiedToken`/`VerifiedTokenFromContext` for the
token), and have `user.ResolveMiddleware` call into it. Report which shape you
used and why.

### Tests

In `api/internal/ai/providers/agentgateway_test.go`, following the existing
`TestAgentGatewayProviderDelegatesTheVerifiedEndUserIdentity` pattern
(`httptest.NewServer` capturing `r.Header.Clone()`):

1. A context carrying a user id sets `X-Kora-User-Id` to that UUID's canonical
   string form.
2. A bare `context.Background()` sets **no** `X-Kora-User-Id` header at all —
   assert the header is absent, not empty. This is the `cmd/embed` case.
3. A context carrying BOTH a verified token and a user id sets both headers —
   proving the composition did not drop the pre-existing one.

In `api/internal/user/` (middleware test file), assert `ResolveMiddleware`
makes the uid readable from `c.Request.Context()`, and that the pre-existing
gin-context `IDFromContext` still works.

### Verification

`cd api && go build ./... && go test ./internal/ai/... ./internal/user/... ./internal/server/...`

Do NOT modify `cmd/embed`. Its correct behaviour here is to change nothing: it
builds a bare `context.Background()`, so the header is absent for free. Confirm
this by reading it; do not add an opt-out.

---

## Task 2 — GET /v1/admin/ai-metrics (#507)

A new read-only endpoint on the platformauth group with two sections.

### Files

**`api/internal/resolveoutcome/repository.go`** — add the window-bounded read
ONLY. `Since(ctx, from)` exists and takes no upper bound; #507 wants one
window. Add `Between(ctx, from, to)` rather than changing `Since`'s signature —
`routes.go`'s health probe and any other caller must keep working. A zero `to`
means "no upper bound".

**`api/internal/platformadmin/repository.go`** — add the paged per-user
aggregate here, NOT in `resolveoutcome`. It joins `ai_usage_events`, and having
the resolveoutcome package reach into billing's table would invert the
dependency; `platformadmin.Repository` is already the cross-domain admin read
layer. It must:

- filter `user_id IS NOT NULL`
- aggregate attempts, resolves (`kind='resolved'`), corrections
  (`kind='alias'`), budget refusals (`kind='budget'`), and last activity
  (`max(created_at)`) from `food_resolution_outcomes`
- LEFT JOIN the `ai_usage_events` per-user call count, itself filtered
  `user_id IS NOT NULL` and NOT filtered to `outcome='ok'`
- apply the sort and then cut the page **inside** the query — this endpoint is
  not a re-mount of the unpaginated `ListForAdmin`
- return the total row count for the §4.1 pagination block

**`api/internal/platformadmin/ai_metrics.go`** (new) — the handler.

Response shape:

```json
{
  "data": {
    "window": { "from": "...", "to": "..." },
    "outcomes": {
      "attempts": 0,
      "by_kind": { "cache": 0, "alias": 0, "...all ten...": 0 },
      "needs_human": 0,
      "first_try_rate_pct": 91.3
    },
    "users": [ { "user_id": "...", "attempts": 0, "resolves": 0,
                 "corrections": 0, "budget_refusals": 0, "ai_calls": 0,
                 "last_activity_at": "..." } ]
  },
  "pagination": { "page": 1, "limit": 50, "total": 0 }
}
```

Rules this handler must hold:

- `by_kind` is built by iterating `resolveoutcome.AllKinds` and supplying zero
  for absent kinds, so a kind cannot silently vanish from the aggregate.
  `Rates.ByKind` omits kinds that did not occur — its doc comment says callers
  rendering a fixed set must supply the zeroes themselves.
- `first_try_rate_pct` uses `*float64` with `json:"...,omitempty"`-style
  absence: when `FirstTryRate()` returns `ok=false`, the field is **absent from
  the JSON**, never `0.0`. Note `omitempty` on a `*float64` omits only nil, so
  a genuine 0.0 rate still renders — verify that in a test.
- `ai_calls` counts calls, not actions. Say so in the field's doc comment: one
  tap emits several rows when a fallback leg is abandoned.
- Timestamps render through `stamp()`. `last_activity_at` is nullable — a user
  with no outcomes has none.
- Window comes from `parseQuery`'s `From`/`To`; paging from its `Page`/`Limit`,
  which clamp rather than refuse.
- No money on this endpoint. Cost is the gateway's and is out of scope (#508).

**`api/internal/platformadmin/routes.go`** — mount
`g.GET("/ai-metrics", NewAIMetricsHandler(outcomes, deps.DB, deps.Logger).Metrics)`
on the existing platformauth group `g`. Extend the "Not mounted, deliberately"
comment block only if something changes about it; do not restructure the file.

### Tests

`api/internal/platformadmin/ai_metrics_test.go`, following the existing
handler-test patterns in that package:

- all ten kinds present in `by_kind` even when only one kind has rows
- empty window ⇒ `first_try_rate_pct` **absent** from the marshalled JSON
  (assert on the raw JSON bytes, not on a decoded struct)
- a genuine 0% rate ⇒ field **present** with value 0
- rows with `user_id IS NULL` excluded from the users section
- `ai_calls` includes a failed (`outcome != 'ok'`) AI usage row
- paging: sort applied before the cut, `total` is the full count not the page
  length, `limit` clamps at `MaxLimit`
- the §4.1 envelope shape, and `data.users` marshalling as `[]` not `null` when
  empty

Add `/v1/admin/ai-metrics` to the platformauth route list in
`api/internal/server/platform_admin_routes_test.go` so the cross-group
rejection tests cover it.

### Verification

`cd api && go build ./... && go test ./internal/platformadmin/... ./internal/resolveoutcome/... ./internal/server/...`

---

## Task 3 — Correct docs/admin-contract.md

The status table and two surrounding sections are stale. Fix all of it, in
place, matching the page's existing voice.

1. **"What is implemented" table.**
   - inbox: no longer "feedback queue only" — it also serves the unresolved-food
     queue (`.WithUnresolvedFoods(outcomes)`).
   - health: no longer "Postgres and Redis" only — add the unresolved-food
     backlog probe (#434/#459) and the AI budget probe (#485/#501), noting the
     budget's money travels on the §4.2 money channel.
   - `POST /admin/inbox/{id}/actions/{id}`: now implemented (#484/#496), not
     "no actions declared".
   - Add a row for `GET /v1/admin/ai-metrics` (#507), marked as Kora's own
     endpoint rather than a contract endpoint, and noting it is unreachable
     from the console until tesserix-home#403 lands (#509).
2. **"Conformance is still blocked" section.** This is wrong. Replace it:
   `@tesserix/admin-conformance@0.3.0` exists and runs in CI at
   `.github/workflows/ci.yml`, driven by `admin-conformance.json` at the repo
   root. Record the two traps worth knowing: `--declaration` is required
   because the step runs from `api/` while the declaration is at the root, and
   exit 1 ("Kora deviates") must never be conflated with exit 2 ("the suite
   could not run"). Note that only the endpoint kinds declared in that file are
   checked, so `ai-metrics` is enforced solely by this repo's Go tests.
3. **"Kora is not yet registered."** Per #509, do not assert either way from
   the merge state — say what must be verified in the deployed console
   (`FEDERATION_PRODUCTS` must include `kora`) and that this is checked live,
   not inferred from a merge.
4. Add #484, #496, #501, #507, #509 to the issue list at the top.

No code changes in this task. Do not touch the §-numbered contract prose that
describes the platform spec itself — only Kora's own status claims.

### Verification

`cd api && go build ./...` (should be unaffected) and re-read the page for
internal consistency: no remaining sentence contradicting the corrected table.
