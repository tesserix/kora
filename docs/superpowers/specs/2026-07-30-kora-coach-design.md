# Kora Thin In-Kora Coach — Design (#51)

**Status:** approved (brainstorming) → ready for implementation plan
**Milestone:** R1 – Friends & family beta
**Scope of this slice:** backend (Go) only. Mobile UI is the next slice against these endpoints.

## Context

A coach is what makes Kora feel different from a plain food tracker, and F&F feedback on it is valuable early. Issue #51 asks for a **thin coach inside Kora** — grounded over the user's own logs/targets, with citations and a "never fabricate numbers" discipline — explicitly *not* the full Australis engine (parked). Acceptance criteria: (1) grounded in the user's real data with no fabricated numbers, (2) runs entirely in Kora with no external engine, (3) passes the medical/ED guardrails (#23).

The guardrails package (`api/internal/guardrails`, shipped in #23) already exists as the output gate for exactly this consumer. This slice builds the coach that uses it.

**Decided in brainstorming:**
- Both surfaces: proactive **nudges** + **Q&A** over history.
- Grounding via a **structured deterministic context block** (no pgvector RAG over logs, no DB migration).
- **Backend only** this slice; mobile UI next.

## Architecture

New package `api/internal/coach/`, handler → service, small focused files:

| File | Responsibility |
|---|---|
| `grounding.go` | Assemble a deterministic `Context` from existing services (dashboard/foodlog/memory). No numbers ever originate in the LLM. |
| `signals.go` | Derive `guardrails.Signals` from the same aggregates. |
| `nudges.go` | Deterministic rule-based nudge candidates → `guardrails.Evaluate` → survivors. No LLM. |
| `service.go` | Orchestration: grounding, nudges, and the grounded Q&A (LLM) path. |
| `handler.go` | Two HTTP handlers; `httpx` envelope; user id/loc from gin context. |
| `*_test.go` | Per-unit tests (see Testing). |

Reused substrate (no duplication): `ai.Provider`/`ai.Router` (LLM), `ai.Meter` (budget), `ai.EstimateCostUSD`, `dashboard.Service.ForDay`, `foodlog` repo (`ListForUserSince`, `DailyKcal`, `LoggedDaysDesc`), `memory.Service.Build`, `guardrails.Evaluate`.

## Endpoints (authed `/v1` group, after `auth.Middleware` + `user.ResolveMiddleware`)

- `GET /v1/coach/nudges` → `{"data": {"nudges": [{"text","reason"}], "showSupport": bool}}`
- `POST /v1/coach/ask` body `{"question": string}` → `{"data": {"answer": string, "citations": [{"label","value"}], "showSupport": bool}}`

Success via `httpx.OK`; errors via `httpx.Error` / `httpx.RespondServiceError`. User via `user.IDFromContext`, timezone via `user.LocFromContext`.

## Data flow

**Grounding (shared).** `grounding.BuildContext(ctx, userID, now, loc)` composes:
- **Today:** `dashboard.Service.ForDay` → consumed vs targets, water, streak.
- **Recent (last 7d, configurable const):** `foodlog.DailyKcal` series → avg intake, protein, logs/day, days-logged; `memory.Service.Build` → usual/frequent foods.
Returns a `Context` struct (structured, for citations) plus a `Render() string` compact text block (for the prompt). Named constants for the window and any thresholds.

**Signals.** `signals.FromContext(Context) guardrails.Signals`:
- `RecentDeficitPct` = mean over last 7d of `clamp(1 - consumed/targetKcal, 0, 1)` (skip days with no target).
- `AvgIntakeKcal`, `LogsPerDay` = 7d means.
- `FastingStreakDays` = consecutive most-recent days with zero logged kcal.

**Nudges (deterministic).** `nudges.Candidates(Context) []guardrails.Nudge` — additive, real-number rules, e.g.:
- protein gap today > 0 → `"{gap}g protein to go"` (`Restrictive:false`)
- fibre below target for N consecutive days → `"fibre low {N} days"` (`Restrictive:false`)
Each candidate → `guardrails.Evaluate(candidate, signals)`; keep `Allow`/`Soften` (use `Decision.Text`), drop `Suppress`. `showSupport = guardrails.AtRisk(signals)`. Protective posture is guaranteed: numbers are real; the gate is mandatory; no restrictive nudge is authored (and any that were would be softened/suppressed).

**Q&A (LLM).** `service.Ask(ctx, userID, now, loc, question)`:
1. Build `Context` + `Signals`.
2. `meter.WithinBudget` — if over, return a graceful degraded answer (`"I've hit today's usage limit — try again later."`, no LLM call, `showSupport = AtRisk`).
3. System prompt: *"You are Kora's coach. Answer ONLY using the numbers in CONTEXT. Never invent or estimate numbers. If the answer isn't in CONTEXT, say you don't have that data. Be supportive and additive; never tell the user to eat less or stop eating."* + `Context.Render()`.
4. `provider.GenerateText(ctx, system, question)` → `meter.Record(EstimateCostUSD(usage))`.
5. Gate: `guardrails.Evaluate(Nudge{Text: answer, Restrictive:false}, signals)` → return `Decision.Text`; `showSupport = Decision.ShowSupport || AtRisk(signals)`.
6. `citations` = the grounding facts included in the context (label/value pairs), proving grounding.

## Changes to existing packages

**`ai.Provider`** — add `GenerateText(ctx context.Context, systemPrompt, userPrompt string) (string, Usage, error)`:
- `providers/gemini.go`: plain `GenerateContent` free-text (mirror `Transcribe`; model = `modelFlash`).
- `providers/openai.go`: `Chat.Completions.New` with no response schema (plain text).
- `router.go`: implement on `Router` (primary → fallback on error/budget, like `Embed`).
- Update the in-package test fake in `ai/resolver_test.go` to satisfy the extended interface (return canned text).

**`guardrails`** — export `AtRisk(s Signals) bool` (promote the existing private `atRisk`; keep `atRisk` as a thin alias or replace call sites). Lets consumers surface support on non-restrictive surfaces under risk without duplicating the risk definition. Add a test.

**Wiring** — `internal/server/router.go`: build `coach.Service` from `deps` (provider, meter, and foodlog/dashboard/memory/tracking repos already constructed there) and register the two routes inside the existing `if deps.DB != nil && deps.Verifier != nil` block. `cmd/api/main.go` already builds the provider (Gemini/Router) + `billing.NewMeter(db)`; thread them into `Deps` if not already present.

## Error handling

- Missing/empty `question` → `httpx.Error(400, "invalid_input", ...)`.
- Over budget → 200 with degraded answer (not an error) — nudges are deterministic and always available.
- LLM/provider error → `httpx.RespondServiceError` (500 `internal_error`); nudges endpoint never calls the LLM so it stays up.
- No data (new user, empty logs) → grounding yields zeroes; Q&A honestly says it lacks data; nudges returns `[]`.

## Testing (repo idiom: real Postgres, `t.Skip` if unavailable, unique-name rows + `t.Cleanup` DELETE-by-id)

- `grounding_test.go`, `signals_test.go` — deterministic, table-driven; boundary cases (no target, zero logs, fasting streak).
- `nudges_test.go` — protein/fibre rules fire on real gaps; **Protective invariant**: no surviving nudge is restrictive; suppressed under risk.
- `service_test.go` — fake `ai.Provider` (canned text) + `stubMeter`: asserts guardrails gating applied, citations returned, "no data" path, over-budget degraded path.
- `handler_test.go` — fake auth middleware sets `user_id`; `httptest`; asserts envelope + 400 on empty question.
- `guardrails/policy_test.go` — add `AtRisk` cases.

## Out of scope (explicit)

Mobile coach UI (next slice); pgvector RAG over logs / any DB migration; multi-turn conversation memory/history persistence (single-shot Q&A this slice); Australis engine extraction (parked, #16).
