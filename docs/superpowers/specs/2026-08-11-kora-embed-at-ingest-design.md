# Kora — Embed at Ingest, and Stop `cmd/embed` Failing Quietly

**Date:** 2026-08-11
**Status:** Approved design, ready for planning

## Problem

Embeddings are the only source of sub-0.70 resolver match scores. Without one, a food is reachable
only by text match. Two gaps leave rows unembedded, both found while filling 71 stragglers by hand
on 2026-08-11 (the index is now 7,900/7,900).

**1. Nothing embeds a food at ingest.** `nutrition.ResolveBarcode` short-circuits on a local hit,
so only the OpenFoodFacts fetch path inserts a new row — and it inserts without an embedding. A
product the user scans is invisible to the embedding tier until an ArgoCD sync happens to run the
seed Job. Confirmed: the two OFF rows created 2026-08-09 (the user's milk and mocha) were both
missing embeddings two days later.

**2. `cmd/embed` reports success when it embedded nothing.** Reading
`api/cmd/embed/main.go:44-77`: a per-row failure is logged and `continue`d; if an entire batch
fails, it logs and `break`s — and then falls through to `log.Printf("cmd/embed: embedded %d food
items", embedded)` and exits 0. The final line reports only successes and never mentions failures,
so a run that embedded zero rows looks identical to a healthy one and the Kubernetes Job reports
`Succeeded`. This is how 69 USDA rows created 2026-08-02 went unembedded through that day's seed
run without anyone noticing. Those same rows embedded without incident on 2026-08-11, so the
original failure was transient — a rate limit or quota blip — and a retry would have absorbed it.

## Goals

- A newly scanned product is embedding-searchable without waiting for the next sync.
- A run that fails to embed rows says so, and the Job goes red.
- Transient failures self-heal instead of needing a human.

## Non-goals

The resolver's inline `provider.Embed` calls on the text hot path
(`internal/ai/resolver.go:376`, `:469`), which cost latency and an API call on every text resolve —
that is a separate, third piece of work. Also out of scope: any change to the seed Job's
`seed && ingest && embed` chaining.

## Part 1 — embed at ingest

### Where it hooks in

`ResolveBarcode` in `api/internal/nutrition/barcode.go`. It returns early on a local hit, so the
insert path runs only for a food Kora has genuinely never stored. That makes it the single correct
trigger point, and it fires exactly once per new food.

### The import constraint

`ai` imports `nutrition` (the resolver holds a `nutrition.Repository`), so `nutrition` cannot
import `ai`. Rather than move the trigger up into `internal/resolve/handler.go` — which would
scatter the responsibility away from the code that owns the insert — `nutrition` declares its own
narrow interface:

```go
type Embedder interface {
	Embed(ctx context.Context, text string) ([]float32, error)
}
```

`ai`'s provider returns `([]float32, Usage, error)`, so `cmd/api/main.go` wires it with a small
adapter. The dependency is injected through a functional option, following the established pattern
of `ai.Resolver.WithPortionSource` (`internal/ai/resolver.go:98`).

**A nil `Embedder` is valid and means "do not embed."** Every existing construction site — tests,
`cmd/embed`, `cmd/ingest` — keeps working untouched, and the behaviour degrades to exactly what
happens today.

### Async, and the failure property that carries the design

After a successful insert, the embed runs in a goroutine using
`context.WithTimeout(context.Background(), …)` — explicitly **not** the request context, which is
cancelled as soon as the scan response is written.

On failure it logs a warning and leaves `embedding` NULL.

That is the entire safety argument: a failed ingest-time embed costs nothing, because the row stays
in `RowsMissingEmbedding` (`internal/nutrition/repository.go:414`) and the next `cmd/embed` pass
picks it up. **Ingest-time embedding is an optimisation; `cmd/embed` remains the guarantee.** No
retry logic belongs on this path — retrying here would duplicate what Part 2 already does properly.

## Part 2 — `cmd/embed` stops lying

Four changes to `api/cmd/embed/main.go`:

1. **Retry each row** before counting it failed: **3 attempts**, with exponential backoff starting
   at 500ms (so ~0.5s and ~1s of waiting in the worst case per row). The 2026-08-02 failure was
   transient and would have self-healed. Three attempts is chosen over more because the whole-batch
   bail-out already covers a sustained outage — retrying 100 rows five times each against a dead
   provider would just make the Job take longer to tell you the same thing.
2. **Count failures** alongside successes.
3. **Report both** — `embedded N, failed M`. Reporting only successes is what made "embedded 0"
   indistinguishable from a healthy run.
4. **Exit non-zero when M > 0.** The seed Job runs `seed && ingest && embed`, so a non-zero exit
   fails the Job and shows red in ArgoCD, which is the point.

**The existing exit-0-without-an-API-key stays** (`cmd/embed/main.go:25-29`). That is deliberate
degradation for environments with no key, not a failure, and turning it red would be noise.

The existing whole-batch bail-out stays too — it prevents an infinite loop, since failed rows are
never marked done and would otherwise keep returning from `RowsMissingEmbedding` forever — but it
now exits non-zero rather than reporting success.

### Testability

`os.Exit` cannot be asserted against, so the work moves into
`run(...) (embedded int, failed int, err error)` and `main` becomes the thin shell that maps the
result to an exit code. This mirrors `cmd/backfillunits`, which already separates its pure core
from its `main`.

## Error handling

- Ingest-time embed failure: logged, row left NULL, next `cmd/embed` pass retries. Never surfaced
  to the user — a scan must not fail because an embedding did.
- The ingest goroutine always carries a timeout, so it cannot outlive the process indefinitely.
- `cmd/embed` retries transient failures; genuinely persistent ones exit non-zero.
- A missing API key remains a clean exit 0.

## Testing

**Part 1.** With a fake `Embedder`: a successful embed sets the column; a *failing* embed leaves it
NULL so the next pass retries — that second case is the one that matters, since it is the property
the whole async design rests on. Plus: a nil `Embedder` inserts normally and embeds nothing.

**Part 2.** Table tests on the retry (transient-then-success, persistent-failure), on `run`'s
counting of embedded versus failed, and on the exit-code decision as a pure function.

## Known limitation

A scanned product is embedding-searchable a moment after the scan, not during it. A user who scans
a brand-new product and immediately searches for it by a loosely-related phrase may not match it on
that first attempt. Making it synchronous would fix that at the cost of a Gemini round-trip on
every first-time scan, which is a worse trade for a case measured in seconds.
