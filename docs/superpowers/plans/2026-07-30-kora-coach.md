# Kora Thin In-Kora Coach — Implementation Plan (#51)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship a backend coach in Kora — deterministic grounded nudges + an LLM Q&A grounded over the user's own aggregates, every user-facing message gated by `guardrails.Evaluate`, no fabricated numbers.

**Architecture:** New `api/internal/coach/` package (handler → service). Grounding is a deterministic `Context` assembled from existing services (`dashboard`, `foodlog`, `memory`); numbers never originate in the LLM. Nudges are rule-based + guardrail-filtered (no LLM). Q&A calls Gemini via a new `ai.Provider.GenerateText`, budget-gated by `ai.Meter`, then guardrail-gated. `guardrails.AtRisk` is exported so the coach can surface support under risk.

**Tech Stack:** Go 1.26, Gin, GORM, `google.golang.org/genai` (Gemini), OpenAI-compatible SDK (fallback), `stretchr/testify`. Design spec: `docs/superpowers/specs/2026-07-30-kora-coach-design.md`.

## Global Constraints
- Tests run **FOREGROUND** (background runs stall). Single-line commit messages, no signature, no Co-Authored-By.
- Repo Go-test idiom: real Postgres via `TEST_DATABASE_URL` (default `postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable`); `t.Skipf` (skip, never fail) if unavailable; isolate with unique-name rows + `t.Cleanup(func(){ db.Exec("DELETE FROM <table> WHERE id = ?", id) })`. **Never** truncate globally; **never** run `cmd/seed` or full `go test ./...` (breaks nutrition tests). Scope runs to the package under test.
- Immutable/props-only; small focused files; named constants (no magic numbers).
- Response envelope: success `httpx.OK(c, data)` → `{"data": ...}`; error `httpx.Error(c, status, code, message)` → `{"error","message"}`; service errors via `httpx.RespondServiceError(c, err)`.
- Protective posture: never author a restrictive nudge; always additive framing.

## File Structure
| File | Responsibility |
|---|---|
| `api/internal/ai/provider.go` (mod) | Add `GenerateText` to `Provider` interface |
| `api/internal/ai/providers/gemini.go` (mod) | Implement `GenerateText` (free-text `GenerateContent`) |
| `api/internal/ai/providers/openai.go` (mod) | Implement `GenerateText` (chat, no schema) |
| `api/internal/ai/router.go` (mod) | Implement `GenerateText` (primary→fallback) |
| `api/internal/ai/resolver_test.go` (mod) | Extend in-package fake Provider |
| `api/internal/guardrails/policy.go` (mod) | Export `AtRisk` |
| `api/internal/coach/grounding.go` (new) | `Context`, `BuildContext`, `Render` |
| `api/internal/coach/signals.go` (new) | `SignalsFrom(Context)` |
| `api/internal/coach/nudges.go` (new) | `Nudges(Context, Signals)` → survivors + showSupport |
| `api/internal/coach/service.go` (new) | `Service`, `Ask` (LLM Q&A), `NudgeList` |
| `api/internal/coach/handler.go` (new) | `Handler`, two endpoints |
| `api/internal/coach/*_test.go` (new) | per-unit tests |
| `api/internal/server/router.go` (mod) | wire coach routes |
| `api/cmd/api/main.go` + `router.go Deps` (mod) | thread provider + meter into router |

---

### Task 1: `ai.Provider.GenerateText` (free-text generation)

**Files:**
- Modify: `api/internal/ai/provider.go`, `api/internal/ai/providers/gemini.go`, `api/internal/ai/providers/openai.go`, `api/internal/ai/router.go`
- Test: `api/internal/ai/router_test.go` (create if absent) + update fake in `api/internal/ai/resolver_test.go`

**Interfaces — Produces:**
```go
// on ai.Provider
GenerateText(ctx context.Context, systemPrompt, userPrompt string) (string, Usage, error)
```

- [ ] **Step 1: Read** `provider.go` (interface), `providers/gemini.go` (`Transcribe` + private `generateJSON` for the `GenerateContent` idiom + `modelFlash`), `providers/openai.go` (`generateJSON`/`buildParams` chat idiom), `router.go` (`Embed` delegation + budgets), and the fake `Provider` in `resolver_test.go`. Confirm exact `Usage` fields and constructor patterns.
- [ ] **Step 2: Write the failing test** — `router_test.go`: a fake primary Provider whose `GenerateText` returns `("hi", Usage{Provider:"fake",Model:"m"}, nil)`; assert `Router{Primary: fake}.GenerateText(ctx,"sys","user")` returns `"hi"`. Add a second case where primary errors and a fallback returns text → Router returns the fallback's text. Use the existing fake-Provider style from `resolver_test.go`.
- [ ] **Step 3: Run FOREGROUND → FAIL (compile):** `cd api && go test ./internal/ai/... -run TestRouterGenerateText` — expect a compile error (`GenerateText` undefined) or fail.
- [ ] **Step 4: Implement:**
  - `provider.go`: add the method to the `Provider` interface.
  - `gemini.go`: `GenerateText` = plain `client.Models.GenerateContent(ctx, modelFlash, contents, &genai.GenerateContentConfig{SystemInstruction: ...})` with the system prompt as system instruction and `userPrompt` as the sole text part; return the response text + a `Usage{Provider:"gemini", Model: modelFlash, CallType:"coach", TokensIn/Out from resp usage metadata, LatencyMs}`. Mirror `Transcribe`’s response-text extraction.
  - `openai.go`: `GenerateText` = `client.Chat.Completions.New` with `SystemMessage(systemPrompt)+UserMessage(userPrompt)`, **no** response_format schema; return `choices[0].message.content` + `Usage`.
  - `router.go`: `GenerateText` delegates to `Primary`; on error, if `Fallback != nil` try it within `fallbackBudget` (mirror `Embed` at `router.go:121`).
  - `resolver_test.go`: add `GenerateText` to the in-package fake Provider (return `("", Usage{}, nil)` or a canned string) so the package still compiles.
- [ ] **Step 5: Run FOREGROUND → PASS:** `cd api && go test ./internal/ai/...` then `cd api && go vet ./internal/ai/...` (clean). (Gemini/openai live calls are not tested here — no API key in CI; the Router delegation test + compile is the gate.)
- [ ] **Step 6: Commit** — `git add api/internal/ai && git commit -m "feat(api): add Provider.GenerateText free-text generation for coach (#51)"`

---

### Task 2: export `guardrails.AtRisk`

**Files:**
- Modify: `api/internal/guardrails/policy.go`
- Test: `api/internal/guardrails/policy_test.go`

**Interfaces — Produces:** `func AtRisk(s Signals) bool`

- [ ] **Step 1: Read** `policy.go` — the private `atRisk(s Signals) bool` (~line 120) and its callers in `Evaluate`.
- [ ] **Step 2: Write the failing test** — in `policy_test.go`:
```go
func TestAtRisk(t *testing.T) {
    require.True(t, AtRisk(Signals{AvgIntakeKcal: 1100}))
    require.True(t, AtRisk(Signals{FastingStreakDays: 3}))
    require.False(t, AtRisk(Signals{}))                 // zero value = no data
    require.False(t, AtRisk(Signals{AvgIntakeKcal: 2000}))
}
```
- [ ] **Step 3: Run FOREGROUND → FAIL:** `cd api && go test ./internal/guardrails/... -run TestAtRisk` — expect `undefined: AtRisk`.
- [ ] **Step 4: Implement** — rename private `atRisk` to exported `AtRisk` (update its call site inside `Evaluate`). Keep behavior identical.
- [ ] **Step 5: Run FOREGROUND → PASS:** `cd api && go test ./internal/guardrails/...` + `go vet ./internal/guardrails/...` clean.
- [ ] **Step 6: Commit** — `git add api/internal/guardrails && git commit -m "feat(api): export guardrails.AtRisk for coach support surfacing (#51)"`

---

### Task 3: coach grounding + signals

**Files:**
- Create: `api/internal/coach/grounding.go`, `api/internal/coach/signals.go`
- Test: `api/internal/coach/grounding_test.go`, `api/internal/coach/signals_test.go`

**Interfaces — Consumes:** `dashboard.Service.ForDay`, `foodlog.Repository` (`ListForUserSince`, `DailyKcal`), `memory.Service.Build`, `guardrails.Signals`.
**Produces:**
```go
package coach

const recentWindowDays = 7

type Fact struct{ Label, Value string }        // one grounding data point (a citation)

type Context struct {
    Today        dashboard.Summary
    RecentDaily  []DailyTotal                   // last recentWindowDays, oldest→newest
    AvgIntakeKcal float64
    AvgProteinG   float64
    LogsPerDay    float64
    DaysLogged    int
    FastingStreakDays int
    Usual        memory.Memory
}
type DailyTotal struct{ Day time.Time; Kcal, ProteinG, FiberG float64; LogCount int }

func (c Context) Render() string          // compact text block for the LLM prompt
func (c Context) Facts() []Fact           // structured citations

// Grounder wires the read-only sources (interfaces so tests can fake them).
type Grounder struct { Dash *dashboard.Service; Logs LogSource; Mem *memory.Service }
type LogSource interface {
    ListForUserSince(ctx context.Context, userID uuid.UUID, since time.Time) ([]foodlog.FoodLog, error)
    DailyKcal(ctx context.Context, userID uuid.UUID, from, to time.Time, loc *time.Location) (map[string]float64, error) // confirm exact sig in Step 1
}
func (g *Grounder) BuildContext(ctx context.Context, userID uuid.UUID, now time.Time, loc *time.Location) (Context, error)

func SignalsFrom(c Context) guardrails.Signals
```

- [ ] **Step 1: Read** `dashboard/service.go` (`Summary`, `Totals` exact field names — Kcal/Protein/Fiber), `foodlog/repository.go` (`ListForUserSince`, `DailyKcal`, `LoggedDaysDesc` exact sigs + `FoodLog` fields), `memory/service.go` (`Build` sig + `Memory` shape), `guardrails/policy.go` (`Signals` fields). Adjust the `Context`/`LogSource` field names above to match the real structs before writing code.
- [ ] **Step 2: Write failing tests** — `signals_test.go` (pure, no DB):
```go
func TestSignalsFrom(t *testing.T) {
    c := coach.Context{
        RecentDaily: []coach.DailyTotal{{Kcal: 1000, LogCount: 1}, {Kcal: 1200, LogCount: 2}},
        AvgIntakeKcal: 1100, LogsPerDay: 1.5, FastingStreakDays: 0,
    }
    // Today.Targets.Kcal used for deficit; set via a constructed Summary in the real test.
    s := coach.SignalsFrom(c)
    require.InDelta(t, 1100, s.AvgIntakeKcal, 0.01)
    require.InDelta(t, 1.5, s.LogsPerDay, 0.01)
}
```
`grounding_test.go` (DB, skip-if-absent, unique-name rows + cleanup): seed a user + a few `food_logs` across 2 days via `foodlog.Repository`, call `BuildContext`, assert `RecentDaily` length, `AvgIntakeKcal`/`LogsPerDay` match the seeded data, and `Render()` contains the target and today's kcal. Follow `foodlog/service_test.go` for `testDB`/seed/cleanup.
- [ ] **Step 3: Run FOREGROUND → FAIL:** `cd api && go test ./internal/coach/... ` — expect compile failure (package/functions undefined).
- [ ] **Step 4: Implement** `grounding.go` + `signals.go`:
  - `BuildContext`: `Today = Dash.ForDay(...)`; pull last `recentWindowDays` via `Logs.ListForUserSince(now-7d)` aggregated per local day into `RecentDaily`; compute averages, `LogsPerDay`, `DaysLogged`; `FastingStreakDays` = consecutive most-recent days with zero kcal; `Usual = Mem.Build(...)`.
  - `Render()`: compact deterministic lines, e.g. `"Today: 1450/2000 kcal, protein 65/120g, fibre 12g. 7d avg intake 1600 kcal over 6 logged days. Usual foods: ..."`. Only real numbers.
  - `Facts()`: label/value pairs for today’s consumed vs targets + 7d averages.
  - `SignalsFrom`: `RecentDeficitPct` = mean of `clamp(1 - dayKcal/targetKcal,0,1)` over days with a positive target; `AvgIntakeKcal`, `LogsPerDay` from Context; `FastingStreakDays` passthrough.
- [ ] **Step 5: Run FOREGROUND → PASS:** `cd api && go test ./internal/coach/...` + `go vet ./internal/coach/...` clean.
- [ ] **Step 6: Commit** — `git add api/internal/coach && git commit -m "feat(api): coach grounding context + guardrail signals (#51)"`

---

### Task 4: deterministic nudges

**Files:**
- Create: `api/internal/coach/nudges.go`
- Test: `api/internal/coach/nudges_test.go`

**Interfaces — Consumes:** `Context`, `SignalsFrom`, `guardrails.Evaluate`, `guardrails.AtRisk` (Task 2).
**Produces:**
```go
type Nudge struct { Text, Reason string }
type NudgeResult struct { Nudges []Nudge; ShowSupport bool }
func BuildNudges(c Context, s guardrails.Signals) NudgeResult
```

- [ ] **Step 1: Read** `guardrails/policy.go` (`Nudge`, `Evaluate`, `Decision`, `Action` consts) and Task 3’s `Context`/`Facts`.
- [ ] **Step 2: Write failing tests** — `nudges_test.go` (pure):
```go
func TestBuildNudges_ProteinGapAdditive(t *testing.T) {
    c := /* Context with today protein 65 of target 120 */
    r := coach.BuildNudges(c, coach.SignalsFrom(c))
    require.NotEmpty(t, r.Nudges)
    require.Contains(t, r.Nudges[0].Text, "protein")
}
func TestBuildNudges_NoSurvivingRestrictiveUnderRisk(t *testing.T) {
    // Context that triggers risk (avg intake <= 1200). Assert no nudge steers toward eating less,
    // and ShowSupport is true.
    c := /* risk Context */
    r := coach.BuildNudges(c, coach.SignalsFrom(c))
    require.True(t, r.ShowSupport)
    for _, n := range r.Nudges { require.NotContains(t, strings.ToLower(n.Text), "enough") }
}
```
- [ ] **Step 3: Run FOREGROUND → FAIL:** `cd api && go test ./internal/coach/... -run TestBuildNudges`.
- [ ] **Step 4: Implement** `BuildNudges`: build additive candidates from `Context` — protein gap (`target-consumed > 0` → `"{gap}g protein to go"`, `Restrictive:false`), fibre-below-target streak (`"fibre low {n} days"`, `Restrictive:false`) — named-constant thresholds. Run each through `guardrails.Evaluate(candidate, s)`; keep `Allow`/`Soften` using `Decision.Text` (Reason = `Decision.Reason`); drop `Suppress`. `ShowSupport = guardrails.AtRisk(s)`. Never author a `Restrictive:true` candidate.
- [ ] **Step 5: Run FOREGROUND → PASS:** `cd api && go test ./internal/coach/...` + `go vet` clean.
- [ ] **Step 6: Commit** — `git add api/internal/coach && git commit -m "feat(api): deterministic guardrail-gated coach nudges (#51)"`

---

### Task 5: Q&A service (LLM, grounded + gated)

**Files:**
- Create: `api/internal/coach/service.go`
- Test: `api/internal/coach/service_test.go`

**Interfaces — Consumes:** Task 1 `ai.Provider.GenerateText`, `ai.Meter`, `ai.EstimateCostUSD`, Task 3 grounding, Task 4 `BuildNudges`, `guardrails`.
**Produces:**
```go
type Answer struct { Text string; Citations []Fact; ShowSupport bool }
type Service struct { g *Grounder; provider ai.Provider; meter ai.Meter }
func NewService(g *Grounder, p ai.Provider, m ai.Meter) *Service
func (s *Service) Ask(ctx context.Context, userID uuid.UUID, now time.Time, loc *time.Location, question string) (Answer, error)
func (s *Service) Nudges(ctx context.Context, userID uuid.UUID, now time.Time, loc *time.Location) (NudgeResult, error)
```

- [ ] **Step 1: Read** `ai/resolver.go` (the `WithinBudget`→call→`Record` pattern + `Meter`), `ai/pricing.go` (`EstimateCostUSD`), Task 3/4 outputs.
- [ ] **Step 2: Write failing tests** — `service_test.go` with a **fake `ai.Provider`** (canned `GenerateText`) + `stubMeter` (copy the shape from `ai/resolver_test.go`), DB-backed grounding (skip-if-absent, unique rows + cleanup):
```go
func TestAsk_GroundedAnswerReturnsCitations(t *testing.T) {
    // seed user + logs; fake provider returns "You have 55g protein to go."
    a, err := svc.Ask(ctx, uid, now, loc, "how's my protein?")
    require.NoError(t, err)
    require.NotEmpty(t, a.Text)
    require.NotEmpty(t, a.Citations)
}
func TestAsk_OverBudgetDegradesGracefully(t *testing.T) {
    // stubMeter.WithinBudget -> false; assert no provider call, friendly Text, err == nil
}
func TestAsk_EmptyQuestion(t *testing.T) {
    _, err := svc.Ask(ctx, uid, now, loc, "  ")
    require.Error(t, err) // ValidationError
}
```
- [ ] **Step 3: Run FOREGROUND → FAIL:** `cd api && go test ./internal/coach/... -run TestAsk`.
- [ ] **Step 4: Implement** `Ask`: validate question (non-empty → else `httpx`-compatible `ValidationError`); `BuildContext`+`SignalsFrom`; `meter.WithinBudget` false → return `Answer{Text: "I've hit today's usage limit — try again later.", ShowSupport: guardrails.AtRisk(s)}, nil`; else build system prompt (spec §Data flow, strict "only CONTEXT numbers / never invent / additive") + `Context.Render()`, call `provider.GenerateText`, `meter.Record(usage, ai.EstimateCostUSD(usage))`; gate via `guardrails.Evaluate(guardrails.Nudge{Text: raw, Restrictive:false}, s)` → `Answer{Text: decision.Text, Citations: ctx.Facts(), ShowSupport: decision.ShowSupport || guardrails.AtRisk(s)}`. `Nudges` = thin wrapper: `BuildContext` → `BuildNudges`.
- [ ] **Step 5: Run FOREGROUND → PASS:** `cd api && go test ./internal/coach/...` + `go vet` clean.
- [ ] **Step 6: Commit** — `git add api/internal/coach && git commit -m "feat(api): grounded coach Q&A service, budget+guardrail gated (#51)"`

---

### Task 6: handlers + route wiring

**Files:**
- Create: `api/internal/coach/handler.go`
- Test: `api/internal/coach/handler_test.go`
- Modify: `api/internal/server/router.go`, `api/cmd/api/main.go` (thread provider + meter into `Deps`)

**Interfaces — Consumes:** Task 5 `Service`; `httpx`, `user.IDFromContext`, `user.LocFromContext`.

- [ ] **Step 1: Read** `foodlog/handler.go` + `foodlog/handler_test.go` (handler struct, `resolveUser`, envelope, fake-auth test idiom), `dashboard` handler construction in `server/router.go`, and `router.go Deps` + `cmd/api/main.go` provider/meter construction.
- [ ] **Step 2: Write failing test** — `handler_test.go`: `gin.New()`, middleware sets `c.Set("user_id", uid)` + `c.Set("user_loc", time.UTC)`, register `GET /v1/coach/nudges` and `POST /v1/coach/ask` with a `Service` built over a fake provider + DB. Assert: nudges → 200 with `data.nudges`; ask with `{"question":""}` → 400 `invalid_input`; ask with a real question → 200 with `data.answer` + `data.citations`.
- [ ] **Step 3: Run FOREGROUND → FAIL:** `cd api && go test ./internal/coach/... -run TestHandler`.
- [ ] **Step 4: Implement:**
  - `handler.go`: `Handler{svc *Service}`, `NewHandler(svc)`, `Nudges(c *gin.Context)` and `Ask(c *gin.Context)` — read `user.IDFromContext`/`user.LocFromContext`, bind `{Question string}` for Ask, `now := time.Now()`, call service, `httpx.OK`/`httpx.RespondServiceError`.
  - `router.go`: add `Provider ai.Provider` (and reuse existing meter or build `billing.NewMeter(deps.DB)`) to `Deps`; inside the `if deps.DB != nil && deps.Verifier != nil` block build `coach.NewService(coach.NewGrounder(dashSvc, logRepo, memSvc), deps.Provider, meter)` and register `v1.GET("/coach/nudges", h.Nudges)` + `v1.POST("/coach/ask", h.Ask)`. Reuse the already-constructed `dashboardHandler`/`logRepo`/memory service where present; construct what’s missing.
  - `main.go`: set `Provider` on `Deps` from the already-built Gemini/Router provider.
- [ ] **Step 5: Run FOREGROUND → PASS:** `cd api && go test ./internal/coach/...` + `cd api && go build ./...` (whole module compiles) + `go vet ./internal/coach/... ./internal/server/...` clean. Do NOT run full `go test ./...`.
- [ ] **Step 6: Commit** — `git add api/internal/coach api/internal/server api/cmd/api && git commit -m "feat(api): wire coach endpoints /v1/coach/{nudges,ask} (#51)"`

---

## Self-Review
- **Spec coverage:** nudges (T4) + Q&A (T5) + grounding/no-fabrication (T3, citations in T5/T6) + guardrails gating (T2 export, applied in T4/T5) + runs-in-Kora (all Go, no external engine) + budget discipline (T5) + wiring (T6). Mobile UI, RAG/migration, multi-turn = out of scope per spec. ✅
- **Placeholders:** field names in T3’s `Context`/`LogSource` are explicitly reconciled against real structs in T3 Step 1 (the repo’s established "read first" pattern); all test code and rules are concrete. ✅
- **Type consistency:** `Context`, `Fact`, `SignalsFrom`, `BuildNudges`/`NudgeResult`, `Answer`, `Service.Ask/Nudges`, `Provider.GenerateText`, `guardrails.AtRisk` used consistently across tasks. ✅
