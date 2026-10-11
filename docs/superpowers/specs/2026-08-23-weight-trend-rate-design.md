# Estimate-framed weight-trend rate — design

**Issue:** #45 (final open piece). **Guardrails:** #23 (closed; policy in `api/internal/guardrails`).
**Date:** 2026-08-23. **Status:** agreed in brainstorming, awaiting review.

## What this is

A **rate of change** shown beneath the Trends chart — "About 0.4 kg per week,
based on 9 readings over the last 42 days."

It describes what has already happened. It is not a projected value, not a
goal ETA, and not a date. That choice is the design's foundation: a rate is
the hardest of the three to misread as a promise, it degrades honestly as
data gets noisy, and it needs no goal to be set.

**Explicitly out of scope:** projected values, projection bands/cones on the
chart, and goal ETAs. Each is a separate decision, not a deferred part of
this one.

## Decisions taken, with their reasons

### 1. Rate of change, not a projected value

§9 says "trend prediction". A projected value is the literal reading and was
rejected: it is the most promise-like of the options and wrong in the most
visible way. A goal ETA is worse still — it compounds trend error with
goal-weight assumptions and reads as a commitment about a date.

### 2. Gate: 4+ readings spanning 14+ days

Both a count and a span, measured on **the points actually fitted**, not on
the requested range.

Count alone would let four weigh-ins in one morning produce a "weekly rate".
Span alone would let two readings a month apart do it. Requiring both is the
smallest rule that rejects the ways this goes obviously wrong.

Rejected: a statistical-significance test on the fit. More principled and
self-tuning, but it hides the rate from a genuinely noisy user with no way to
explain why, and is much harder to test.

### 3. The instrument rule is PER-METRIC, not uniform

This is a deliberate departure from `bodyCompositionSeries.ts`, which refuses
to compute any figure across an instrument change. Two reasons:

- **Magnitude.** Vendors disagree about body fat by 20+ points — the artefact
  that module exists to prevent ("Renpho's 48.9% minus Omron's 25.7% as 23
  points of muscle lost"). They disagree about *weight* by a few hundred
  grams, well inside the noise a weekly rate already tolerates.
- **`source` describes the weigh-in, not the tape.** A waist measurement is
  always typed by hand, but its row inherits whatever instrument produced
  that day's weight. Splitting a tape series on `source` would be splitting
  on something unrelated to how it was measured.

So: **weight and tape measurements fit across all sources. Composition
percentages fit on the trailing same-instrument run only.** A weight series
spanning instruments says so beside the figure rather than being suppressed.

**Evidence this matters.** In production, the last 90 days hold 17 readings
over 16 days — a long `manual` run ending in 2 `scale_screenshot` rows. A
uniform trailing-run rule would fit on those 2 points, fail the gate, and
show nothing. HealthKit sync (#369) now writes a third source, so
interleaving increases from here.

### 4. Ordinary least squares, not first-minus-last

First-minus-last is determined entirely by two readings, so a single bloated
morning swings it wildly. OLS over (time, value), slope converted to per-week.

### 5. Guardrail: `AtRisk`, NOT `Evaluate`

Routing through `guardrails.Evaluate` was the initial recommendation and it
is wrong. `Evaluate` branches on `Restrictive`, and neither value works:

- `Restrictive: true` → a **not**-at-risk user (the common case) hits the
  `!risk && Restrictive` branch, which returns **Soften**, replacing the text
  with "Nice work today — you're on track." Nobody losing weight would ever
  see their rate.
- `Restrictive: false` → every branch returns `Allow`. The guardrail is
  decorative.

The matrix is built for messages that *steer* ("you've eaten enough"), not
for a descriptive statistic about the user's own measurements.

**Use the exported `guardrails.AtRisk(signals)` directly and apply our own
action.** This preserves the single definition of "at risk" — the thing #23
exists to stop drifting, and the reason a bespoke kg/week threshold was
rejected — without abusing a matrix designed for steering copy.

At-risk → suppress the rate, surface support. Otherwise → show it.

### 6. Server decides; client renders

`GET /v1/weight/trend?metric=<key>&range=<1W|1M|3M|1Y>`

```json
{ "status": "ok" | "insufficient_data" | "suppressed",
  "rate_per_week": -0.4,
  "basis": { "readings": 9, "days": 42 },
  "spans_instruments": false,
  "show_support": false }
```

`basis` describes **the points actually fitted**, not the requested range. For
a composition percentage that means the trailing same-instrument run, so
`readings` and `days` can both be smaller than the range holds — which is the
point: the figure states the evidence behind it, not the window asked for.

`spans_instruments` is only ever true for weight and tape measurements, since
composition percentages are fitted within a single instrument run by
construction (decision 3).

The server returns **structured facts, not composed text**. The reason is
units: the server stores kg and cm, but an imperial user must read lb and
inches, and the client already owns that conversion (`displayNumber`,
`unitLabel`). A server-composed sentence would be wrong for those users.

This does not weaken the guardrail. The *decision* stays server-side, and
`status: "suppressed"` carries **no rate at all** — so a client bug cannot
leak a number the policy withheld.

`Signals` are computed from food-logging history by the caller, as
`guardrails` requires.

**How, specifically.** The only existing producer is
`coach.SignalsFrom(coach.Context)`, and a `coach.Context` comes from
`Grounder.BuildContext`, which fetches dashboard, logs, memory and weights.
Reproducing that computation in `tracking` would create a second definition
of risk — the exact drift decision 5 exists to prevent.

So `tracking` depends on a narrow interface it defines itself:

```go
type SignalsSource interface {
    SignalsFor(ctx context.Context, userID uuid.UUID) (guardrails.Signals, error)
}
```

implemented once in `coach` over `Grounder` + `SignalsFrom`. `tracking` never
imports `coach`, the risk computation stays single-sourced, and tests inject a
fake.

**Accepted cost:** a trend request grounds a full coach context, which is
heavier than the figure warrants. Acceptable because the client caches per
(metric, range) and the Trends screen is not hot. If it becomes a problem the
fix is a cheaper `SignalsFor` implementation behind the same interface, not a
second risk definition.

**Failure mode:** if `SignalsFor` errors, the endpoint returns
`status: "suppressed"` with no rate. Risk state unknown must not read as
"no risk" — the guardrail fails closed.

## Copy rules

> "About 0.4 kg per week — based on 9 readings over the last 42 days."

Past tense. Names its own basis. Makes no claim about the future.

**Excluded, and testable as exclusions:** any future-tense verb, any date,
any "on track to", any goal reference. Rounded to one decimal — more digits
are false precision on this data.

The framing lives in ONE pure, unit-aware client function, which is what
makes these rules assertions rather than conventions.

## Known cost

The trailing-same-instrument-run logic currently exists only in TypeScript.
This design ports it to Go, creating a second source of truth for an
invariant the codebase treats as load-bearing. Contained by making the Go
version a pure function with its own tests, and cross-referencing the
invariant in both files. Accepted deliberately over the alternative
(client-computed rate), which would have put the safety decision downstream
of client-supplied input.

## Testing

**Server** — the rate is a pure function over points:
- gate: 3 readings rejected; 4 readings spanning 10 days rejected
- OLS against a hand-computed series
- the per-metric instrument rule from decision 3, both classes
- suppression when `AtRisk` fires

**Client** — the copy function:
- estimate framing, including the exclusions above
- imperial conversion and rounding
- `insufficient_data` and `suppressed` renderings

Everything mutation-checked. One matters more than the rest: **flip
suppression off and confirm a test goes red**, so the guardrail is proven
rather than assumed.

## Not addressed here

- Whether a rate should ever appear outside Trends (Today, coach).
- Backfilling a rate into notifications or the weekly summary.
- Any projection of future values, in any form.
