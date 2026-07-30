# Coach Nudge Enrichment Implementation Plan (PR 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `GET /v1/coach/nudges` the `kind` and `title` fields the CoachScreen mockup needs, add an ED-risk-gated weight-trend nudge, and close a latent guardrail hole where a softened nudge would keep its contradictory title.

**Architecture:** `guardrails.Nudge`/`Decision` gain a `Title` that the Protective policy sanitises alongside `Text`, so title-safety lives inside the tested policy package rather than in each caller. `coach.Context` gains a deterministic 30-day `WeightTrend` sourced from `tracking.Repository.WeightSeries`. The weight-trend candidate is *gated* on `!guardrails.AtRisk(signals)` rather than marked restrictive, because a restrictive candidate would be softened into a fixed reframe and lose the trend for every non-at-risk user.

**Tech Stack:** Go 1.26, Gin, GORM, testify/require. Tests run against a real Postgres via `TEST_DATABASE_URL`.

## Global Constraints

- Nudge text is deterministic and real-numbers-only. Every value traces back to a repository read. Never invent food suggestions or forecasts.
- Every candidate authored in `candidateNudges` stays `Restrictive: false`. The additive invariant in `nudges.go` is deliberate — see `TestBuildNudges_NoSurvivingRestrictiveUnderRisk`.
- `Nudge.Reason` is an internal audit string and is never rendered to users. Do not repurpose it as a title.
- Run Go tests in the **foreground**, never backgrounded.
- `TEST_DATABASE_URL` default: `postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable`. Tests `t.Skip` when Postgres is absent.
- Do **not** run `go run ./cmd/seed` — it breaks two nutrition tests locally.
- Single-line commit messages, conventional-commit prefix, no signatures, no `Co-Authored-By` trailer.
- Work on branch `kora-coach-nudge-enrichment` off `main`.

---

### Task 1: Sanitise `Title` inside the guardrails policy

`Evaluate` currently replaces `Text` with a fixed reframe on `Soften` but knows nothing about a title. Once `coach.Nudge` carries a title, the first restrictive candidate anyone adds would render "**Fibre is low**" above "Nice work today — you're on track." Fix the policy first so the hole never opens.

**Files:**
- Modify: `api/internal/guardrails/policy.go`
- Test: `api/internal/guardrails/policy_test.go`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `guardrails.Nudge{Title, Text string, Restrictive bool}` and `guardrails.Decision{Action, Title, Text string, ShowSupport bool, Reason string}`. `Evaluate(n Nudge, s Signals) Decision` keeps its signature. On `Soften`, `Decision.Title == guardrails.SoftenedTitle` and `Decision.Text == softenedText`. On `Suppress`, both `Title` and `Text` are `""`. On `Allow`, both pass through unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `api/internal/guardrails/policy_test.go`:

```go
func TestEvaluate_SoftenNeutralisesTitleAndText(t *testing.T) {
	n := Nudge{Title: "Fibre is low", Text: "under target 4 days", Restrictive: true}

	d := Evaluate(n, Signals{}) // zero Signals == no data == not at risk

	require.Equal(t, Soften, d.Action)
	require.Equal(t, SoftenedTitle, d.Title)
	require.NotEqual(t, "Fibre is low", d.Title)
	require.NotEqual(t, "under target 4 days", d.Text)
}

func TestEvaluate_SuppressClearsTitleAndText(t *testing.T) {
	n := Nudge{Title: "Fibre is low", Text: "under target 4 days", Restrictive: true}

	d := Evaluate(n, Signals{FastingStreakDays: 3}) // at risk

	require.Equal(t, Suppress, d.Action)
	require.Empty(t, d.Title)
	require.Empty(t, d.Text)
	require.True(t, d.ShowSupport)
}

func TestEvaluate_AllowPassesTitleThrough(t *testing.T) {
	n := Nudge{Title: "Protein", Text: "55g to go", Restrictive: false}

	d := Evaluate(n, Signals{})

	require.Equal(t, Allow, d.Action)
	require.Equal(t, "Protein", d.Title)
	require.Equal(t, "55g to go", d.Text)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && go test ./internal/guardrails/ -run 'TestEvaluate_(Soften|Suppress|Allow)' -v`

Expected: FAIL — compile error, `unknown field Title in struct literal of type Nudge` and `undefined: SoftenedTitle`.

- [ ] **Step 3: Add the fields and sanitisation**

In `api/internal/guardrails/policy.go`, add the exported constant next to `softenedText`:

```go
// softenedText is the fixed positive reframe returned for Soften
// decisions in this first slice of the policy.
const softenedText = "Nice work today — you're on track."

// SoftenedTitle is the neutral title paired with softenedText. A Soften
// decision must replace the candidate's title as well as its text:
// keeping the original would render a contradiction such as
// "Fibre is low" above "Nice work today — you're on track."
const SoftenedTitle = "Today"
```

Add `Title` to `Nudge`:

```go
// Nudge is a candidate coach/insight message before it is shown.
type Nudge struct {
	Title       string
	Text        string
	Restrictive bool // true if it steers toward eating less / stopping (e.g. "you've eaten enough")
}
```

Add `Title` to `Decision`:

```go
// Decision is the result of applying the Protective policy to a Nudge.
type Decision struct {
	Action Action
	// Title is the safe title to show: SoftenedTitle for Soften, the
	// original for Allow, "" for Suppress. It is sanitised in lockstep
	// with Text so the two can never contradict each other.
	Title       string
	Text        string // the safe text to show (reframed for Soften; original for Allow; "" for Suppress)
	ShowSupport bool   // surface a supportive resource instead
	Reason      string
}
```

Update all four branches of `Evaluate` to set `Title`:

```go
func Evaluate(n Nudge, s Signals) Decision {
	risk := AtRisk(s)

	switch {
	case risk && n.Restrictive:
		return Decision{
			Action:      Suppress,
			Title:       "",
			Text:        "",
			ShowSupport: true,
			Reason:      reasonSuppressRestrictiveUnderRisk,
		}
	case risk && !n.Restrictive:
		return Decision{
			Action: Allow,
			Title:  n.Title,
			Text:   n.Text,
			Reason: reasonAllowUnderRisk,
		}
	case !risk && n.Restrictive:
		return Decision{
			Action: Soften,
			Title:  SoftenedTitle,
			Text:   softenedText,
			Reason: reasonSoftenNoRisk,
		}
	default:
		return Decision{
			Action: Allow,
			Title:  n.Title,
			Text:   n.Text,
			Reason: reasonAllowNoRisk,
		}
	}
}
```

Also update the doc comment above `Evaluate` so it documents title handling:

```go
// Evaluate applies the Protective policy to a candidate nudge given a
// user's signals. Title and Text are sanitised together so they can never
// contradict:
//
//   - risk + restrictive  -> Suppress, ShowSupport=true, Title="", Text=""
//   - risk + not restrictive -> Allow, original title and text
//   - no risk + restrictive -> Soften, SoftenedTitle + fixed positive reframe
//   - no risk + not restrictive -> Allow, original title and text
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && go test ./internal/guardrails/ -v`

Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 5: Verify the coach package still compiles**

Run: `cd api && go build ./...`

Expected: success. `coach/service.go:141` builds a `guardrails.Nudge` without a `Title` — that is intentional and still valid, since Ask answers are not titled cards.

- [ ] **Step 6: Commit**

```bash
git add api/internal/guardrails/policy.go api/internal/guardrails/policy_test.go
git commit -m "fix(guardrails): sanitise nudge title alongside text so softened nudges cannot contradict"
```

---

### Task 2: Add a deterministic 30-day weight trend to `Context`

**Files:**
- Modify: `api/internal/coach/grounding.go`
- Test: `api/internal/coach/grounding_test.go`

**Interfaces:**
- Consumes: `tracking.Repository.WeightSeries(ctx, userID, from, to) ([]tracking.WeightEntry, error)` — already exists at `api/internal/tracking/repository.go:66`. `tracking.WeightEntry` has `WeightKg float64` and `LoggedAt time.Time`.
- Produces:
  - `coach.WeightSource` interface with `WeightSeries(ctx context.Context, userID uuid.UUID, from, to time.Time) ([]tracking.WeightEntry, error)`
  - `coach.WeightTrend{DeltaKg float64, Days int, Valid bool}` on `Context.WeightTrend`
  - `coach.NewGrounder(dash dashboard.Service, logs LogSource, mem memory.Service, weights WeightSource) Grounder` — **signature gains a 4th parameter**
  - `const weightWindowDays = 30`

- [ ] **Step 1: Write the failing tests**

Append to `api/internal/coach/grounding_test.go`:

```go
type fakeWeightSource struct {
	entries []tracking.WeightEntry
	err     error
}

func (f fakeWeightSource) WeightSeries(_ context.Context, _ uuid.UUID, _, _ time.Time) ([]tracking.WeightEntry, error) {
	return f.entries, f.err
}

func TestWeightTrendFrom_DeltaOverWindow(t *testing.T) {
	base := time.Date(2026, 7, 1, 8, 0, 0, 0, time.UTC)
	entries := []tracking.WeightEntry{
		{WeightKg: 80.0, LoggedAt: base},
		{WeightKg: 79.1, LoggedAt: base.AddDate(0, 0, 10)},
		{WeightKg: 78.2, LoggedAt: base.AddDate(0, 0, 20)},
	}

	tr := weightTrendFrom(entries)

	require.True(t, tr.Valid)
	require.InDelta(t, -1.8, tr.DeltaKg, 0.001)
	require.Equal(t, 20, tr.Days)
}

func TestWeightTrendFrom_InvalidBelowTwoEntries(t *testing.T) {
	require.False(t, weightTrendFrom(nil).Valid)
	require.False(t, weightTrendFrom([]tracking.WeightEntry{{WeightKg: 80}}).Valid)
}

func TestWeightTrendFrom_GainIsPositiveDelta(t *testing.T) {
	base := time.Date(2026, 7, 1, 8, 0, 0, 0, time.UTC)
	entries := []tracking.WeightEntry{
		{WeightKg: 78.0, LoggedAt: base},
		{WeightKg: 79.0, LoggedAt: base.AddDate(0, 0, 7)},
	}

	tr := weightTrendFrom(entries)

	require.True(t, tr.Valid)
	require.InDelta(t, 1.0, tr.DeltaKg, 0.001)
}
```

If `grounding_test.go` does not already import them, add `"context"`, `"time"`, `"github.com/google/uuid"`, and `"github.com/tesserix/kora/api/internal/tracking"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && go test ./internal/coach/ -run TestWeightTrendFrom -v`

Expected: FAIL — `undefined: weightTrendFrom`.

- [ ] **Step 3: Implement the trend type and helper**

In `api/internal/coach/grounding.go`, add `"github.com/tesserix/kora/api/internal/tracking"` to the imports, then add near `recentWindowDays`:

```go
// weightWindowDays is the trailing window used for the weight trend. It is
// deliberately longer than recentWindowDays: a 7-day weight delta is mostly
// water-weight noise, so the trend is stated over a month.
const weightWindowDays = 30
```

Add the type and helper:

```go
// WeightTrend is the observed change in logged weight across the trailing
// weightWindowDays. DeltaKg is signed: negative means weight went down.
// Valid is false when there are too few entries to state a trend at all —
// callers must not present an invalid trend as a zero change.
type WeightTrend struct {
	DeltaKg float64
	Days    int
	Valid   bool
}

// WeightSource is the read used to compute WeightTrend.
// tracking.Repository satisfies it; tests can supply a fake.
type WeightSource interface {
	WeightSeries(ctx context.Context, userID uuid.UUID, from, to time.Time) ([]tracking.WeightEntry, error)
}

// weightTrendFrom derives a WeightTrend from an ascending-by-logged_at
// series. Fewer than two entries is not a trend, so it reports Valid:
// false rather than a misleading zero delta.
func weightTrendFrom(entries []tracking.WeightEntry) WeightTrend {
	if len(entries) < 2 {
		return WeightTrend{}
	}
	first, last := entries[0], entries[len(entries)-1]
	days := int(last.LoggedAt.Sub(first.LoggedAt).Hours() / 24)
	return WeightTrend{
		DeltaKg: last.WeightKg - first.WeightKg,
		Days:    days,
		Valid:   true,
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && go test ./internal/coach/ -run TestWeightTrendFrom -v`

Expected: PASS (3 tests).

- [ ] **Step 5: Wire the source into `Context` and `Grounder`**

Add the field to `Context` (after `Usual`):

```go
	Usual             memory.Memory
	WeightTrend       WeightTrend
```

Add the dependency to `Grounder` and its constructor:

```go
// Grounder wires the read-only sources BuildContext aggregates.
type Grounder struct {
	Dash    dashboard.Service
	Logs    LogSource
	Mem     memory.Service
	Weights WeightSource
}

// NewGrounder constructs a Grounder from its concrete dependencies.
func NewGrounder(dash dashboard.Service, logs LogSource, mem memory.Service, weights WeightSource) Grounder {
	return Grounder{Dash: dash, Logs: logs, Mem: mem, Weights: weights}
}
```

In `BuildContext`, after the `usual` read and before `summarizeRecent`, add the weight read. A weight-read failure must **not** fail the whole context — the trend is one optional card, while nudges and Q&A must keep working:

```go
	weightFrom := windowStartDays(now, loc, weightWindowDays)
	weightTrend := WeightTrend{}
	if g.Weights != nil {
		entries, err := g.Weights.WeightSeries(ctx, userID, weightFrom, now)
		if err == nil {
			weightTrend = weightTrendFrom(entries)
		}
	}
```

Add `WeightTrend: weightTrend,` to the returned `Context` literal.

Generalise the window helper so both windows share one boundary rule, and keep `windowStart` as a thin wrapper so existing callers and their comment stay valid:

```go
// windowStartDays returns the local-midnight (in loc) start of the trailing
// days-long window ending on now's local calendar day.
func windowStartDays(now time.Time, loc *time.Location, days int) time.Time {
	nowLocal := now.In(loc)
	return time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), 0, 0, 0, 0, loc).
		AddDate(0, 0, -(days - 1))
}
```

Then replace `windowStart`'s body with `return windowStartDays(now, loc, recentWindowDays)`, leaving its existing doc comment in place.

- [ ] **Step 6: Update the router wiring**

`api/internal/server/router.go:169` currently reads:

```go
		coachGrounder := coach.NewGrounder(dashSvc, logRepo, memSvc)
```

Change it to pass the tracking repository already constructed at line 115:

```go
		coachGrounder := coach.NewGrounder(dashSvc, logRepo, memSvc, trackingRepo)
```

- [ ] **Step 7: Run the coach and server suites**

Run: `cd api && go build ./... && go test ./internal/coach/ ./internal/server/ -v 2>&1 | tail -30`

Expected: PASS. Any existing `NewGrounder(` call in tests must gain a 4th argument — pass `fakeWeightSource{}` where a test has no weight fixture.

- [ ] **Step 8: Commit**

```bash
git add api/internal/coach/grounding.go api/internal/coach/grounding_test.go api/internal/server/router.go
git commit -m "feat(coach): ground a deterministic 30-day weight trend on Context"
```

---

### Task 3: Add `Kind` and `Title` to coach nudges

**Files:**
- Modify: `api/internal/coach/nudges.go`
- Test: `api/internal/coach/nudges_test.go`

**Interfaces:**
- Consumes: `guardrails.Nudge{Title, Text, Restrictive}` and `guardrails.Decision{Title, Text, ...}` from Task 1.
- Produces:
  - `coach.NudgeKind` string type with `NudgeKindProtein = "protein"`, `NudgeKindFibre = "fibre"`, `NudgeKindWeightTrend = "weight_trend"`
  - `coach.Nudge{Kind NudgeKind, Title, Text, Reason string}` with JSON tags `kind`, `title`, `text`, `reason`
  - `candidateNudges` returns `[]candidate` where `candidate{kind NudgeKind, nudge guardrails.Nudge}`

**Important — do not "fix" the implementation to satisfy old tests.** `TestBuildNudges_ProteinGapAdditive` currently asserts `r.Nudges[0].Text` contains `"protein"`. The contract intentionally moves that noun into `Title`, so that assertion must move to `Title`. Update the test, not the copy.

- [ ] **Step 1: Write the failing tests**

Add to `api/internal/coach/nudges_test.go`:

```go
func TestBuildNudges_ProteinCarriesKindAndTitle(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{
			Consumed: dashboard.Totals{ProteinG: 65},
			Targets:  dashboard.Totals{Kcal: 2000, ProteinG: 120},
		},
		AvgIntakeKcal: 1800,
	}

	r := BuildNudges(c, SignalsFrom(c))

	require.NotEmpty(t, r.Nudges)
	require.Equal(t, NudgeKindProtein, r.Nudges[0].Kind)
	require.Equal(t, "Protein", r.Nudges[0].Title)
	require.Contains(t, r.Nudges[0].Text, "55")
	require.Contains(t, r.Nudges[0].Text, "120")
}

func TestBuildNudges_FibreCarriesKindAndTitle(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{
			Consumed: dashboard.Totals{ProteinG: 120},
			Targets:  dashboard.Totals{Kcal: 2000, ProteinG: 120, FiberG: 30},
		},
		RecentDaily: []DailyTotal{
			{FiberG: 10}, {FiberG: 11}, {FiberG: 9},
		},
		AvgIntakeKcal: 1800,
	}

	r := BuildNudges(c, SignalsFrom(c))

	var fibre *Nudge
	for i := range r.Nudges {
		if r.Nudges[i].Kind == NudgeKindFibre {
			fibre = &r.Nudges[i]
		}
	}
	require.NotNil(t, fibre, "expected a fibre nudge")
	require.Equal(t, "Fibre is low", fibre.Title)
}
```

Then update the existing `TestBuildNudges_ProteinGapAdditive` assertion:

```go
	require.NotEmpty(t, r.Nudges)
	require.Equal(t, "Protein", r.Nudges[0].Title)
	require.Contains(t, r.Nudges[0].Text, "55")
	require.NotEmpty(t, r.Nudges[0].Reason)
	require.False(t, r.ShowSupport)
```

And in `TestBuildNudges_NoProteinGapWhenTargetMet`, assert on kind instead of the word:

```go
	for _, n := range r.Nudges {
		require.NotEqual(t, NudgeKindProtein, n.Kind)
	}
```

Check the rest of `nudges_test.go` for any other assertion matching nudge text against `"protein"` or `"fibre"` and move each to `Kind` or `Title`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && go test ./internal/coach/ -run TestBuildNudges -v`

Expected: FAIL — `undefined: NudgeKindProtein`, and `r.Nudges[0].Kind` / `.Title` undefined.

- [ ] **Step 3: Implement kinds, titles, and the candidate carrier**

In `api/internal/coach/nudges.go`, add above `Nudge`:

```go
// NudgeKind classifies a nudge so the client can pick an icon and accent
// without the server shipping presentation details.
type NudgeKind string

const (
	NudgeKindProtein     NudgeKind = "protein"
	NudgeKindFibre       NudgeKind = "fibre"
	NudgeKindWeightTrend NudgeKind = "weight_trend"
)
```

Replace `Nudge`:

```go
// Nudge is a coach message that survived the Protective guardrail policy,
// ready to show to the user.
type Nudge struct {
	Kind  NudgeKind `json:"kind"`
	Title string    `json:"title"`
	Text  string    `json:"text"`
	// Reason explains which policy branch fired. It is an internal audit
	// string — never render it to users.
	Reason string `json:"reason"`
}
```

Add the candidate carrier, since `guardrails.Nudge` has no notion of kind:

```go
// candidate pairs a policy-evaluable nudge with the kind it will carry
// once it survives evaluation.
type candidate struct {
	kind  NudgeKind
	nudge guardrails.Nudge
}
```

Rewrite `BuildNudges`'s loop to carry kind and take the sanitised title from the decision:

```go
func BuildNudges(c Context, s guardrails.Signals) NudgeResult {
	candidates := candidateNudges(c, s)

	nudges := make([]Nudge, 0, len(candidates))
	for _, cand := range candidates {
		d := guardrails.Evaluate(cand.nudge, s)
		if d.Action == guardrails.Suppress {
			continue
		}
		nudges = append(nudges, Nudge{
			Kind:   cand.kind,
			Title:  d.Title,
			Text:   d.Text,
			Reason: d.Reason,
		})
	}

	return NudgeResult{
		Nudges:      nudges,
		ShowSupport: guardrails.AtRisk(s),
	}
}
```

Update `candidateNudges` (the `s` parameter is used in Task 4):

```go
func candidateNudges(c Context, s guardrails.Signals) []candidate {
	var candidates []candidate

	if n, ok := proteinGapNudge(c); ok {
		candidates = append(candidates, candidate{kind: NudgeKindProtein, nudge: n})
	}
	if n, ok := fiberLowStreakNudge(c); ok {
		candidates = append(candidates, candidate{kind: NudgeKindFibre, nudge: n})
	}

	return candidates
}
```

Give the two existing builders titles and fuller text:

```go
func proteinGapNudge(c Context) (guardrails.Nudge, bool) {
	gap := c.Today.Targets.ProteinG - c.Today.Consumed.ProteinG
	if gap <= 0 {
		return guardrails.Nudge{}, false
	}
	return guardrails.Nudge{
		Title: "Protein",
		Text: fmt.Sprintf("%s / %sg — %sg to go",
			fmtNum(c.Today.Consumed.ProteinG), fmtNum(c.Today.Targets.ProteinG), fmtNum(gap)),
		Restrictive: false,
	}, true
}

func fiberLowStreakNudge(c Context) (guardrails.Nudge, bool) {
	streak := fiberBelowTargetStreak(c)
	if streak < minFiberBelowTargetStreakDays {
		return guardrails.Nudge{}, false
	}
	return guardrails.Nudge{
		Title:       "Fibre is low",
		Text:        fmt.Sprintf("Under target %d days running", streak),
		Restrictive: false,
	}, true
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && go test ./internal/coach/ -v 2>&1 | tail -30`

Expected: PASS, including `TestBuildNudges_NoSurvivingRestrictiveUnderRisk`.

- [ ] **Step 5: Commit**

```bash
git add api/internal/coach/nudges.go api/internal/coach/nudges_test.go
git commit -m "feat(coach): add kind and title to nudges for client card rendering"
```

---

### Task 4: Add the ED-risk-gated weight-trend nudge

The card is gated on `!guardrails.AtRisk(s)` rather than marked `Restrictive: true`. Marking it restrictive would make `Evaluate` return `Soften` for every non-at-risk user, replacing the trend text with the fixed reframe and destroying the card for exactly the audience it is for.

**Files:**
- Modify: `api/internal/coach/nudges.go`
- Test: `api/internal/coach/nudges_test.go`

**Interfaces:**
- Consumes: `Context.WeightTrend` (Task 2), `NudgeKindWeightTrend` and `candidate` (Task 3).
- Produces: `weightTrendNudge(c Context) (guardrails.Nudge, bool)`.

- [ ] **Step 1: Write the failing tests**

Add to `api/internal/coach/nudges_test.go`:

```go
func weightTrendContext(trend WeightTrend, avgKcal float64, fastingStreak int) Context {
	return Context{
		Today: dashboard.Summary{
			Consumed: dashboard.Totals{ProteinG: 120},
			Targets:  dashboard.Totals{Kcal: 2000, ProteinG: 120},
		},
		AvgIntakeKcal:     avgKcal,
		FastingStreakDays: fastingStreak,
		WeightTrend:       trend,
	}
}

func hasKind(nudges []Nudge, k NudgeKind) bool {
	for _, n := range nudges {
		if n.Kind == k {
			return true
		}
	}
	return false
}

func TestBuildNudges_WeightTrendShownWhenNotAtRisk(t *testing.T) {
	c := weightTrendContext(WeightTrend{DeltaKg: -1.8, Days: 30, Valid: true}, 1800, 0)

	r := BuildNudges(c, SignalsFrom(c))

	require.True(t, hasKind(r.Nudges, NudgeKindWeightTrend))
	for _, n := range r.Nudges {
		if n.Kind == NudgeKindWeightTrend {
			require.Equal(t, "Weight trend", n.Title)
			require.Contains(t, n.Text, "1.8")
			require.Contains(t, strings.ToLower(n.Text), "down")
		}
	}
	require.False(t, r.ShowSupport)
}

func TestBuildNudges_WeightTrendHiddenWhenAtRisk_FastingStreak(t *testing.T) {
	c := weightTrendContext(WeightTrend{DeltaKg: -1.8, Days: 30, Valid: true}, 1800, 3)

	r := BuildNudges(c, SignalsFrom(c))

	require.True(t, r.ShowSupport)
	require.False(t, hasKind(r.Nudges, NudgeKindWeightTrend),
		"weight-loss framing must never be shown to an at-risk user")
}

func TestBuildNudges_WeightTrendHiddenWhenAtRisk_LowIntake(t *testing.T) {
	c := weightTrendContext(WeightTrend{DeltaKg: -1.8, Days: 30, Valid: true}, 1100, 0)

	r := BuildNudges(c, SignalsFrom(c))

	require.True(t, r.ShowSupport)
	require.False(t, hasKind(r.Nudges, NudgeKindWeightTrend))
}

func TestBuildNudges_WeightTrendHiddenWhenAtRisk_ObsessiveLogging(t *testing.T) {
	c := weightTrendContext(WeightTrend{DeltaKg: -1.8, Days: 30, Valid: true}, 1800, 0)
	c.LogsPerDay = 12

	r := BuildNudges(c, SignalsFrom(c))

	require.True(t, r.ShowSupport)
	require.False(t, hasKind(r.Nudges, NudgeKindWeightTrend))
}

func TestBuildNudges_NoWeightTrendWhenInvalid(t *testing.T) {
	c := weightTrendContext(WeightTrend{}, 1800, 0)

	r := BuildNudges(c, SignalsFrom(c))

	require.False(t, hasKind(r.Nudges, NudgeKindWeightTrend))
}

func TestBuildNudges_WeightGainPhrasedAsUp(t *testing.T) {
	c := weightTrendContext(WeightTrend{DeltaKg: 1.2, Days: 30, Valid: true}, 1800, 0)

	r := BuildNudges(c, SignalsFrom(c))

	require.True(t, hasKind(r.Nudges, NudgeKindWeightTrend))
	for _, n := range r.Nudges {
		if n.Kind == NudgeKindWeightTrend {
			require.Contains(t, strings.ToLower(n.Text), "up")
		}
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && go test ./internal/coach/ -run TestBuildNudges_Weight -v`

Expected: FAIL — no weight-trend nudge is produced.

- [ ] **Step 3: Implement the gated builder**

In `api/internal/coach/nudges.go`, add the weight-trend candidate to `candidateNudges`, gated on risk:

```go
func candidateNudges(c Context, s guardrails.Signals) []candidate {
	var candidates []candidate

	if n, ok := proteinGapNudge(c); ok {
		candidates = append(candidates, candidate{kind: NudgeKindProtein, nudge: n})
	}
	if n, ok := fiberLowStreakNudge(c); ok {
		candidates = append(candidates, candidate{kind: NudgeKindFibre, nudge: n})
	}
	// The weight trend is gated on risk rather than marked Restrictive:
	// a restrictive candidate would be Softened into the fixed reframe for
	// every non-at-risk user, destroying the card for its whole audience.
	// Gating keeps weight-loss framing away from at-risk users while
	// leaving it intact for everyone else.
	if !guardrails.AtRisk(s) {
		if n, ok := weightTrendNudge(c); ok {
			candidates = append(candidates, candidate{kind: NudgeKindWeightTrend, nudge: n})
		}
	}

	return candidates
}
```

Add the builder. It states the observed delta only — no forecast:

```go
// weightTrendNudge surfaces the observed weight change over the trailing
// weightWindowDays. It states only what was logged: no projection, no goal
// framing. Callers must gate it on !guardrails.AtRisk — see candidateNudges.
func weightTrendNudge(c Context) (guardrails.Nudge, bool) {
	tr := c.WeightTrend
	if !tr.Valid || tr.DeltaKg == 0 {
		return guardrails.Nudge{}, false
	}
	direction := "Up"
	magnitude := tr.DeltaKg
	if tr.DeltaKg < 0 {
		direction = "Down"
		magnitude = -tr.DeltaKg
	}
	return guardrails.Nudge{
		Title:       "Weight trend",
		Text:        fmt.Sprintf("%s %skg over %d days", direction, fmtNum(magnitude), tr.Days),
		Restrictive: false,
	}, true
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && go test ./internal/coach/ -v 2>&1 | tail -30`

Expected: PASS, all coach tests.

- [ ] **Step 5: Commit**

```bash
git add api/internal/coach/nudges.go api/internal/coach/nudges_test.go
git commit -m "feat(coach): add weight-trend nudge gated off ED-risk signals"
```

---

### Task 5: Verify the wire format and run the full suite

**Files:**
- Test: `api/internal/coach/handler_test.go`

**Interfaces:**
- Consumes: everything above. `GET /v1/coach/nudges` returns `{"nudges":[{"kind","title","text","reason"}],"show_support":bool}`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

First update the existing `TestHandlerNudges_Returns200WithNudges` in this file — its `NewGrounder` call needs the 4th argument. It already builds a tracking repository for `dashSvc`, so hoist it:

```go
	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
```

Then append the new test. The response is wrapped in httpx's `{"data": {...}}` envelope, and the mobile client depends on exact snake_case keys:

```go
func TestHandlerNudges_ResponseIncludesKindAndTitle(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true})
	router := newTestRouter(userID, NewHandler(svc))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/coach/nudges", nil)
	router.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			Nudges []Nudge `json:"nudges"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.NotEmpty(t, body.Data.Nudges,
		"a fresh user with a protein target and no logs should get a protein-gap nudge")

	first := body.Data.Nudges[0]
	require.Equal(t, NudgeKindProtein, first.Kind)
	require.Equal(t, "Protein", first.Title)
	require.NotEmpty(t, first.Text)

	// Assert the raw wire keys: round-tripping through Go types above would
	// pass regardless of JSON casing, so this is what actually pins the
	// snake_case contract the mobile client codes against.
	raw := w.Body.String()
	require.True(t, strings.Contains(raw, `"kind"`), "raw body should contain \"kind\", got: %s", raw)
	require.True(t, strings.Contains(raw, `"title"`), "raw body should contain \"title\", got: %s", raw)
	require.False(t, strings.Contains(raw, `"Kind"`), "raw body should not contain PascalCase \"Kind\", got: %s", raw)
	require.False(t, strings.Contains(raw, `"Title"`), "raw body should not contain PascalCase \"Title\", got: %s", raw)
}
```

All imports used here (`encoding/json`, `net/http`, `net/http/httptest`, `strings`, `tracking`, etc.) are already present in this file.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && go test ./internal/coach/ -run TestNudgesHandler_ResponseIncludesKindAndTitle -v`

Expected: FAIL before the assertions are satisfied.

- [ ] **Step 3: Make it pass**

No production change should be required — Tasks 1–4 already produce these fields. If it fails, the JSON tags on `coach.Nudge` are wrong; fix the tags, not the test.

- [ ] **Step 4: Run vet and the full suite exactly as CI does**

Start a fresh Postgres matching CI, run migrations, then the suite:

```bash
docker rm -f kora-pg-test 2>/dev/null
docker run -d --name kora-pg-test \
  -e POSTGRES_DB=kora -e POSTGRES_USER=kora -e POSTGRES_PASSWORD=kora_dev \
  -p 55432:5432 pgvector/pgvector:pg15
until docker exec kora-pg-test pg_isready -U kora >/dev/null 2>&1; do sleep 1; done
cd api
DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go run ./cmd/migrate
go vet ./...
TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test -race -p 1 ./...
```

Expected: `go vet` clean; every package `ok`, zero `FAIL`. Run in the foreground.

- [ ] **Step 5: Clean up and commit**

```bash
docker rm -f kora-pg-test
git add api/internal/coach/handler_test.go
git commit -m "test(coach): assert nudges wire format carries kind and title"
```

---

## Done criteria

- `go vet ./...` clean; `go test -race -p 1 ./...` fully green against a fresh Postgres.
- `GET /v1/coach/nudges` serialises `kind`, `title`, `text`, `reason` plus `show_support`.
- Weight-trend nudge appears for a healthy user with ≥2 weight entries in 30 days, and is absent under every one of the four `AtRisk` thresholds.
- A softened nudge can no longer carry a contradictory title.
- `Reason` is unchanged in meaning and still never rendered.
