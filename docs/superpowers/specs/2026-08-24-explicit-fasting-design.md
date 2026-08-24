# Explicit fasting intervals — design

**Issue:** #407. **Guardrail:** #23 (policy in `api/internal/guardrails`).
**Date:** 2026-08-24. **Status:** agreed in brainstorming, awaiting review.

## What this is

Start-fast / end-fast controls on the diary screen, producing a stored interval.

Kora currently *infers* fasting from an **absence** — consecutive complete days
with zero logged kcal. An absence is ambiguous by construction: not logging, not
eating, and forgetting are indistinguishable to the server. That ambiguity has
already caused one production bug (#408: one stray log turned seven unlogged
days into a reported seven-day fast, tripping the ED-risk threshold and silently
suppressing features).

A declared fast is a fact rather than a guess.

## The constraint that shapes everything else

**A declared fast must not become the only input to fasting risk.**

`FastingStreakDays` is not a fasting feature; it is an eating-disorder risk proxy
feeding `guardrails.AtRisk`. If risk counted only *declared* fasts it would go
silent for exactly the people it protects — someone in restriction will not tap
"start fasting". A self-reported safety signal is trustworthy only when the
reporter has no incentive to under-report, and here the incentive runs the other
way.

So declared and inferred stay **separate signals** throughout. See decision 4.

## Decisions

### 1. An ad-hoc interval, not a flag and not a schedule

One row: start, end, still-open. A per-day flag loses the timing, which is most
of the value — the coach could not tell a 16-hour overnight fast from a full day
without food. A recurring schedule (16:8, 5:2) is the full intermittent-fasting
product and reintroduces inference, which is what this issue exists to remove.

Schedules are a deliberate follow-up, not an oversight.

### 2. Storage

New `fasting` package, one table:

```
fasting_intervals
  id, user_id, started_at, ended_at (NULL = open),
  ended_by ('user' | 'food_log' | 'cap'), local_date, created_at
```

`local_date` is the local day the fast **started**, following the stored-local-day
convention `food_logs` and `weight_entries` already use rather than deriving a
day from a timestamp.

**One open fast per user**, enforced by a partial unique index on
`(user_id) WHERE ended_at IS NULL`.

Two traps this repo has already hit apply directly:
- `ON CONFLICT` against a partial unique index needs `clause.TargetWhere` with
  the predicate matching verbatim, or Postgres errors `42P10`.
- Postgres treats NULLs as distinct, so a **wrongly non-partial** index passes
  every naive test. It must be mutation-checked in both directions.

**Starting is idempotent.** If a fast is already open, `POST /v1/fasting/start`
returns it rather than erroring. A double-tap must not produce a 400, and
neither must a client retry.

### 3. Three ways a fast ends — and the cap needs no job

- **Explicitly:** the user taps end. `ended_by = 'user'`.
- **Implicitly:** the next food log closes it at that log's `logged_at`,
  `ended_by = 'food_log'`. Eating is the end of a fast by definition, the data
  already exists, and it costs the user no extra tap. `foodlog` declares a narrow
  `FastingCloser` interface that `fasting` satisfies — the same seam pattern
  `tracking` uses for `SignalsSource`, so the dependency points one way.
- **By cap:** duration is **always**

```
min(ended_at ?? now, started_at + cap) - started_at
```

  with `cap = 48h`.

The cap is applied **at read time**, not by a scheduled job. A row may sit open
in the database indefinitely, but it can never contribute more than the cap to
any signal or any display. That designs out the failure mode rather than
sweeping it up: a forgotten fast cannot accrue into a false risk flag, which is
the stale-state-read-as-real-state bug this project fixed in #408 and #406.

48h is chosen so a genuine 24h+ fast still registers fully against the risk
threshold while an abandoned one plateaus.

### 4. The risk signal: separate, and measured as the LONGEST fast

`guardrails.Signals` gains one field:

```go
DeclaredFastHours float64 // longest single declared fast intersecting the window
```

and one threshold beside the existing four:

```go
riskDeclaredFastHours = 24
```

**Separate from `FastingStreakDays`, deliberately.** Folding them into one number
would conflate "we guessed from an absence" with "they told us", inside a signal
that was just fixed for over-inferring — and the two need different thresholds,
since 24h declared is meaningful and 24h of silence is not. Keeping them apart
also means that when suppression fires you can tell which signal did it, which
#405 showed matters.

**Longest single fast, not total.** Seven 16-hour overnight fasts sum to 112
hours and mean nothing; one 30-hour fast means something. Summing would flag
exactly the routine practice this threshold exists to spare, so the measure is
the maximum. The 16:8 case tops out at 16 and never fires.

A fast counts if its interval **intersects** the 7-day window, using its own
capped duration — a 40-hour fast that ended early in the window is still recent
behaviour worth weighing.

**An OPEN fast counts at its duration so far.** The formula in decision 3 uses
`ended_at ?? now`, so a fast open for 30 hours reports 30 and fires the
threshold while it is still running. That is intended: the point of the signal
is to notice a long fast, and waiting for it to be ended before noticing would
mean never noticing the ones that matter most.

**Plumbing:** `Grounder` gains a `FastingSource` mirroring `WeightSource`, and
`Context` carries the value, so `SignalsFrom` stays a pure function over an
already-fetched context — the property that makes it testable.

### 5. Fasting read errors are NOT swallowed

`BuildContext` swallows `WeightSource` errors on documented reasoning: a failed
weight read must never read as "no change". Fasting errors propagate instead,
like `Dash`, `Logs`, `Mem` and `Mentor`.

The reason is direction of failure. A swallowed fasting error yields
`DeclaredFastHours = 0`, which reads as "no long fast" — failing **open** on a
risk input. The trend endpoint already fails closed when `SignalsFor` errors, so
propagating turns an unknown into a suppression rather than a false all-clear.

**Accepted cost:** a fasting-table outage breaks coach Ask, exactly as a logs
outage does today. This is deliberately inconsistent with the weight path, and
is recorded as a decision rather than left as a detail.

## Surface

One control on the diary screen beside water logging — the existing precedent
for a lightweight non-food entry. It reads **Start fast** when nothing is open
and **End fast** with the elapsed duration when something is.

## Explicitly out of scope

Each excluded for a reason, not by omission:

- **Retroactive declaration.** "I was fasting yesterday" permits rewriting
  history that the risk signals read. Worth having eventually, but editing an
  input to a safety check needs its own thought.
- **Schedules** (16:8, 5:2). A separate issue, per decision 1.
- **Nudge suppression.** An open fast probably should silence meal reminders,
  but that is a second policy touchpoint and belongs in its own change.
- **Coach prose.** The fast reaches the coach as a grounded fact. Whether the
  coach should *talk* about it is a copy decision, deliberately not made inside
  a plumbing change — the same facts-not-sentences split used for active energy
  and resting heart rate.

## Testing

**Pure:** the duration expression — open past the cap, ended before the cap,
open under it. Table-driven.

**Signal** — the layer most worth reviewing:
- 16:8 never fires (16h < 24h)
- one 30-hour fast fires
- **seven short fasts do NOT fire.** This is the false positive the threshold
  exists to prevent, and the test most likely to be broken by a well-meaning
  "sum them" refactor.
- a failed fasting read propagates rather than yielding zero hours

**Integration:**
- starting twice returns the same interval
- a food log closes an open fast at the log's timestamp
- the partial unique index rejects a second open fast — **mutation-checked in
  both directions**, because a wrongly non-partial index passes naively

## Not addressed here

- Whether a declared fast should suppress meal reminders (see out of scope).
- Whether an unusually long declared fast warrants a support surface rather than
  only a suppression. Plausibly yes; needs deliberate thought rather than an
  assumption in either direction.
- Server-side observability for how often suppression fires, by signal, without
  user identity. Raised in #405 and still open; this design adds a fifth reason
  suppression can occur, which strengthens the case.
