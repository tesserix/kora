# Kora Medical/ED Guardrails — First Slice Implementation Plan (#23)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the non-medical disclaimer surface + a reusable, tested guardrail policy module encoding a **Protective** posture, so the coach (#51) and insights (#27) can gate every user-facing nudge before it's shown.

**Posture (decided):** Protective — default to NOT nudging toward restriction; suppress restrictive nudges when any ED-risk signal fires; always positive/additive framing ("add 30g protein", never "you've eaten enough"); surface support on risk.

**Architecture:** Two independent pieces. (1) Mobile: a disclaimer at onboarding/goal-setup. (2) Go: `api/internal/guardrails` — a pure policy package (`Evaluate(candidate, signals) → Decision`) that the not-yet-built coach/insights call. Estimate-framing of weight-trend *predictions* is DEFERRED (no prediction feature exists yet — `progress.tsx` shows only a delta badge; nothing to frame). ED-risk *signal computation from logs* is DEFERRED to the consumer (#51/#27) — this slice defines the policy over given signals.

**Tech Stack:** Go 1.26 + testify (backend); React Native/Expo + Jest/RNTL (mobile). Tests run FOREGROUND. Single-line commits, no signature.

## Global Constraints
- Immutable/props-only; small focused files.
- Match existing patterns (see `api/internal/nutrition` for a pure Go package with tests; `apps/mobile/app/onboarding.tsx` for the mobile screen).
- Protective policy values live as named constants (no magic numbers).

---

### Task 1: Non-medical disclaimer at onboarding

**Files:**
- Modify: `apps/mobile/app/onboarding.tsx` (add disclaimer just above the "Get started" `Button`, line ~211)
- Test: `apps/mobile/app/__tests__/onboarding.test.tsx`

**Interfaces:** none exported — a static disclaimer block.

- [ ] **Step 1: Read** `onboarding.tsx` around the submit Button + its existing test for mock/render style. Confirm `AppText` variants + `colors` tokens.
- [ ] **Step 2: Write the failing test** — asserts the disclaimer copy renders on the onboarding screen:
```tsx
it("shows a non-medical disclaimer at goal setup", () => {
  render(<Onboarding />);
  expect(screen.getByText(/not medical advice/i)).toBeTruthy();
});
```
- [ ] **Step 3: Run FOREGROUND → FAIL:** `cd apps/mobile && npm test -- --testPathPattern='onboarding\.test'`
- [ ] **Step 4: Implement** — add above the Button an `AppText variant="footnote" muted` (centered) with copy: `Kora gives general nutrition information, not medical advice. For medical concerns, talk to a healthcare professional.` Use theme tokens; no hard-coded colors.
- [ ] **Step 5: Run FOREGROUND → PASS** + full suite `CI=1 npm test` green + `npx tsc --noEmit` clean.
- [ ] **Step 6: Commit** — `git commit -am "feat(mobile): non-medical disclaimer at onboarding (#23)"`

---

### Task 2: `guardrails` policy package (Protective)

**Files:**
- Create: `api/internal/guardrails/policy.go`
- Create: `api/internal/guardrails/policy_test.go`

**Interfaces — Produces:**
```go
package guardrails

// Nudge is a candidate coach/insight message before it is shown.
type Nudge struct {
    Text        string
    Restrictive bool // true if it steers toward eating less / stopping (e.g. "you've eaten enough")
}

// Signals are per-user risk signals (computed by the caller from logging history).
type Signals struct {
    RecentDeficitPct  float64 // avg daily deficit vs target over last 7d, 0..1
    AvgIntakeKcal     float64 // avg daily intake last 7d
    LogsPerDay        float64 // avg food logs/day last 7d (obsessive-logging proxy)
    FastingStreakDays int
}

type Action string
const (
    Allow    Action = "allow"
    Soften   Action = "soften"   // reframed positively
    Suppress Action = "suppress" // not shown; ShowSupport may be set
)

type Decision struct {
    Action      Action
    Text        string // the safe text to show (reframed for Soften; original for Allow; "" for Suppress)
    ShowSupport bool   // surface a supportive resource instead
    Reason      string
}

// Evaluate applies the Protective policy to a candidate nudge given a user's signals.
func Evaluate(n Nudge, s Signals) Decision
```

**Protective policy (constants + rules):**
- Risk fires if ANY: `RecentDeficitPct >= 0.30`, `AvgIntakeKcal <= 1200`, `LogsPerDay >= 12`, `FastingStreakDays >= 3`.
- If risk fires AND `n.Restrictive` → `Suppress` + `ShowSupport=true`.
- If risk fires AND not restrictive → `Allow` (supportive nudges still ok).
- If no risk AND `n.Restrictive` → `Soften`: reframe to additive (drop "enough/stop/less" framing → e.g. prefix "Nice work today." and strip the restrictive clause) — for the first slice, `Soften` returns a fixed positive reframe: `"Nice work today — you're on track."`
- If no risk AND not restrictive → `Allow` with original text.

- [ ] **Step 1: Read** `api/internal/nutrition/*.go` for the pure-package + testify idiom used in this repo.
- [ ] **Step 2: Write failing tests** (`policy_test.go`) covering the 4 rule branches + each risk threshold boundary:
```go
func TestEvaluate_SuppressesRestrictiveNudgeUnderRisk(t *testing.T) {
    d := Evaluate(Nudge{Text: "You've eaten enough calories.", Restrictive: true},
        Signals{AvgIntakeKcal: 1100})
    require.Equal(t, Suppress, d.Action)
    require.True(t, d.ShowSupport)
    require.Empty(t, d.Text)
}
func TestEvaluate_SoftensRestrictiveNudgeNoRisk(t *testing.T) {
    d := Evaluate(Nudge{Text: "You've eaten enough.", Restrictive: true},
        Signals{AvgIntakeKcal: 2000, RecentDeficitPct: 0.1})
    require.Equal(t, Soften, d.Action)
    require.NotEmpty(t, d.Text)
    require.NotContains(t, d.Text, "enough")
}
func TestEvaluate_AllowsSupportiveNudge(t *testing.T) {
    d := Evaluate(Nudge{Text: "35g protein to go — a yoghurt would do it.", Restrictive: false},
        Signals{AvgIntakeKcal: 2000})
    require.Equal(t, Allow, d.Action)
    require.Equal(t, "35g protein to go — a yoghurt would do it.", d.Text)
}
func TestEvaluate_RiskThresholds(t *testing.T) {
    for _, s := range []Signals{{RecentDeficitPct: 0.30}, {AvgIntakeKcal: 1200}, {LogsPerDay: 12}, {FastingStreakDays: 3}} {
        require.Equal(t, Suppress, Evaluate(Nudge{Restrictive: true}, s).Action)
    }
}
```
- [ ] **Step 3: Run FOREGROUND → FAIL:** `cd api && go test ./internal/guardrails/...`
- [ ] **Step 4: Implement** `policy.go` per the interface + policy above (named constants for thresholds; `atRisk(s Signals) bool` helper).
- [ ] **Step 5: Run FOREGROUND → PASS** + `go vet ./internal/guardrails/...` clean.
- [ ] **Step 6: Commit** — `git commit -am "feat(api): Protective guardrails policy package (#23)"`

---

## Self-Review
- **Coverage:** disclaimer (T1) + guardrail policy module (T2) = the chosen "policy module + disclaimer" slice. Estimate-framing deferred (no prediction feature — documented). ED-risk signal *computation* deferred to consumers (#51/#27) — this slice owns the policy over given signals. ✅
- **Placeholders:** none — concrete copy, concrete thresholds, concrete tests. ✅
- **Types:** `Nudge`/`Signals`/`Decision`/`Action` used consistently across tests + interface. ✅
