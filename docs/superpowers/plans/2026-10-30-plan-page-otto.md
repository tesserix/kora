# Otto on the Plan page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user types a sentence on the Plan page ("my dietitian said 120–130 g protein"). Otto proposes a change to the plan, and the user can apply it to the unsaved draft.

**Architecture:** A new stateless endpoint, `POST /v1/me/plan/otto`, lives in `api/internal/onboarding`. It sends the message and the current draft to `ai.Provider.GenerateText` and parses a JSON change limited to six fields. It applies that change through `Calculate`, so the formula's bounds apply. It drops any change that lowers calories or speeds up the pace for an at-risk user. It returns the reply text and an optional proposal: the new draft, its targets, and an old → new list. On the mobile side, a chat section below the cluster shows the exchanges. "Use this" writes the proposed draft into the route params through `router.setParams`, which is the same path the existing "Body, activity & goal" edit uses. Nothing is saved until the primary button is tapped.

**Tech Stack:** Go (gin, `ai.Provider`, `billing.Meter`, `guardrails`), Expo SDK 57 React Native (expo-router, TanStack Query, Jest).

**Spec:** `docs/superpowers/specs/2026-10-29-onboarding-and-plan-review-design.md`, section 4 ("Otto on the Plan page") and the `POST /v1/me/plan/otto` line under API.

## Global Constraints

- Otto proposes; `Calculate` produces every value. No number from the model reaches the response without going through `Calculate` and its override bounds.
- A target below resting burn must never be proposed by any path. `Calculate` already refuses it, and a refused proposal is dropped, never clamped.
- If `guardrails.AtRisk` is true, any proposal that lowers calories or speeds up the pace is dropped and `show_support` is true. If the signals can't be loaded, treat the user as at risk.
- Each message is one AI request: `meter.WithinBudget` runs before the provider call, and `meter.Record` runs after it with call type `plan_otto`. A failure to record never fails the request.
- Stateless: no chat history is stored or sent. Each request carries only the message and the current draft.
- The rest of the page works if Otto fails. Otto errors never block Save.
- Ignition rules (`Skill("sketch-findings-kora")`): no new orange accent on this screen, Menlo numerals, safety and failure text at least 11px in sentence case.
- The endpoint works before `onboarded_at` is set, because the Plan page is the last onboarding step.
- Fixed copy (verbatim):
  - Budget used up: `You've used your Otto allowance for now. You can still edit the numbers directly.`
  - Otto failed: `Otto couldn't answer. You can still edit the numbers directly.`
  - Out of bounds (server reply): `That would take your plan outside what Kora can safely set, so I've left it as it is.`
  - At risk (server reply): `I'll keep your calories where they are for now. If eating feels hard at the moment, it can help to talk it through with someone you trust.`
  - AI disclosure under the chat: `Otto is AI and can be wrong. Kora checks every number before it's used.`

## Review Focus

1. **The model returns a valid change that `Calculate` rejects**, such as a 900 kcal override. Expected: no proposal, the out-of-bounds reply, and status 200. (Task 2 test `TestOttoDropsOutOfBounds`)
2. **An at-risk user asks to eat less.** Expected: no proposal, the at-risk reply, and `show_support: true`, even when the signals call errors. (Task 2 tests `TestOttoAtRiskDropsLowerKcal` and `TestOttoSignalsErrorFailsClosed`)
3. **The model returns prose, code-fenced JSON, or unknown enum values.** Expected: fences are stripped, an unknown `activity_level` or `goal` is ignored rather than proposed, and non-JSON gives a 502. (Task 1 test `TestParseOttoReply*`)
4. **"Use this" after the user has typed an override.** Expected: the typed text is reset, so the proposal's overrides show, including a cleared override disappearing from the params. (Task 4 test `use this replaces draft and clears typed overrides`)
5. **A draft whose current override is already invalid, sent to Otto.** Expected: the old targets are computed without the overrides, so the request doesn't 400. (Task 2 test `TestOttoInvalidCurrentOverride`)

---

### Task 1: Otto change parsing and diff (pure Go)

**Files:**
- Create: `api/internal/onboarding/otto.go`
- Test: `api/internal/onboarding/otto_test.go`

**Interfaces:**
- Produces:
  ```go
  // ottoChange is the model's JSON. Absent fields mean "no change".
  type ottoChange struct {
      ActivityLevel      *string  `json:"activity_level"`
      Goal               *string  `json:"goal"`
      GoalWeightKg       *float64 `json:"goal_weight_kg"`
      PaceKgPerWeek      *float64 `json:"pace_kg_per_week"`
      KcalOverride       *float64 `json:"kcal_override"`
      ProteinOverrideG   *float64 `json:"protein_override_g"`
      ClearKcalOverride    bool   `json:"clear_kcal_override"`
      ClearProteinOverride bool   `json:"clear_protein_override"`
  }
  type ottoReply struct {
      Reply  string      `json:"reply"`
      Change *ottoChange `json:"change"`
  }
  type PlanChange struct {
      Field string `json:"field"` // activity_level|goal|goal_weight_kg|pace_kg_per_week|kcal|protein_g|carbs_g|fat_g
      From  any    `json:"from"`  // string for enums, number rounded to 1 dp (weight/pace) or 0 dp (kcal, grams)
      To    any    `json:"to"`
  }
  func parseOttoReply(raw string) (ottoReply, error)
  func (c ottoChange) apply(in Input) Input
  func (c *ottoChange) empty() bool                      // nil or no field set
  func planChanges(oldIn, newIn Input, oldT, newT Targets) []PlanChange
  const ottoSystemPrompt = "..."
  ```

- [ ] **Step 1: Write failing tests** in `otto_test.go`:
  - `TestParseOttoReplyPlain`: `{"reply":"ok","change":{"protein_override_g":125}}` gives Reply `"ok"` and `*Change.ProteinOverrideG == 125`.
  - `TestParseOttoReplyFenced`: the same JSON wrapped in a ```` ```json ```` fence parses the same.
  - `TestParseOttoReplyProse`: `"Sure! I'd suggest..."` returns an error.
  - `TestParseOttoReplyEmptyReply`: `{"reply":"  "}` returns an error, since a reply is required.
  - `TestApplyIgnoresUnknownEnums`: a change with `activity_level:"couch"` and `goal:"bulk"` applied to a draft leaves both unchanged.
  - `TestApplyClears`: on a draft with both overrides set, `ClearKcalOverride` and `ClearProteinOverride` set both to nil. A set `KcalOverride` wins over `ClearKcalOverride`.
  - `TestApplyMaintenanceZeroesDestination`: changing goal to `maintenance` sets `GoalWeightKg = 0` and `PaceKgPerWeek = 0`.
  - `TestPlanChangesListsOnlyDiffs`: the old input is fat_loss/moderate. The new input only has protein override 125. Calculate both with `Calculate(in, 2026)`. Expect exactly `protein_g` and `carbs_g` entries with rounded numbers, in this order: inputs first (activity_level, goal, goal_weight_kg, pace_kg_per_week), then kcal, protein_g, carbs_g, fat_g.
  - `TestEmpty`: `(*ottoChange)(nil).empty()` and `(&ottoChange{}).empty()` are both true.

- [ ] **Step 2:** Run `cd api && go test ./internal/onboarding -run 'Otto|Apply|PlanChanges|Empty' -v`. Expected: FAIL (undefined).

- [ ] **Step 3: Implement** `otto.go`.
  - Strip code fences: copy `recipes.stripCodeFence` (`api/internal/recipes/parse.go:350`) into this file as `stripFence`. Don't import `recipes`, because onboarding must not depend on it.
  - `apply` only accepts enum values found in `activityFactors` / `validGoals`.
  - Rounding: `math.Round(x*10)/10` for weight and pace, `math.Round` for the rest. Compare the rounded values, so noise below the rounding never shows up as a change.
  - Use this `ottoSystemPrompt` verbatim:
    ```
    You are Otto, Kora's nutrition coach, helping a user adjust their daily plan. You receive JSON with the user's message, their current plan inputs, and the targets Kora calculated. Reply with JSON ONLY, no code fences, exactly matching: {"reply": string, "change": object|null}. "reply" is one to three short, warm sentences in plain language. "change" may contain only these keys: "activity_level" (sedentary|light|moderate|active|very_active), "goal" (fat_loss|maintenance|muscle_gain), "goal_weight_kg" (number), "pace_kg_per_week" (number), "kcal_override" (number), "protein_override_g" (number), "clear_kcal_override" (true), "clear_protein_override" (true). Set "change" to null when the message is a question or nothing should change. When the user gives a range from a professional, use its midpoint rounded to a whole number. Never suggest calories below the "bmr" value in the targets. Never give medical advice; suggest a healthcare professional for medical concerns. Kora checks every number you suggest and may refuse it.
    ```

- [ ] **Step 4:** Run the same command. Expected: PASS.

- [ ] **Step 5:** Commit `feat(api): parse and diff Otto plan changes`.

### Task 2: `POST /v1/me/plan/otto` handler, wiring, metrics label

**Files:**
- Modify: `api/internal/onboarding/handler.go` (Handler fields plus `WithOtto`)
- Modify: `api/internal/onboarding/otto.go` (handler method)
- Modify: `api/internal/server/router.go`: register after `coachGrounder` exists (around line 557–572)
- Modify: `api/internal/metrics/labels.go` and `labels_test.go`: add `callPlanOtto = "plan_otto"` with class `classResolution`
- Test: `api/internal/onboarding/otto_handler_test.go`

**Interfaces:**
- Consumes: Task 1 types; `ai.Provider`, `ai.Meter`, `ai.WithUsageCollector`, `ai.EstimateCostUSD` (same use as `recipes.Parser`, `api/internal/recipes/parse.go:118-175`); `guardrails.AtRisk`.
- Produces:
  ```go
  type SignalsSource interface {
      SignalsFor(ctx context.Context, userID uuid.UUID, loc *time.Location) (guardrails.Signals, error)
  }
  func (h Handler) WithOtto(p ai.Provider, m ai.Meter, s SignalsSource) Handler
  func (h Handler) Otto(c *gin.Context)
  ```
  Request: `{"message": string, "draft": Input}`.
  Response 200: `{"reply": string, "proposal": null | {"draft": Input, "targets": Targets, "changes": []PlanChange}, "show_support": bool}`.
  Errors:
  - 400 `invalid_input`: message empty after trimming, over 500 runes, malformed body, or a draft that won't compute even without overrides
  - 429 `budget_exhausted`
  - 502 `otto_failed`: provider error, timeout, or an unparsable reply
  - 503 `otto_unavailable`: the provider is nil

- [ ] **Step 1: Write failing tests.** Use a fake provider (canned `GenerateText` string or error), a fake meter (`within bool`, plus a record of calls), and a fake signals source (`signals` or `err`). Each test uses the `newTestHandler` pattern already in `plan_handler_test.go`, with `user.IDFromContext` set. The draft is female, born 1990, 160 cm, 73 kg, moderate, fat_loss, goal weight 68, pace 0.5.
  - `TestOttoProposesProtein`: the model returns `{"reply":"Got it","change":{"protein_override_g":125}}`. Expect 200, reply `"Got it"`, `proposal.targets.protein_g == 125`, `proposal.draft.target_protein_override_g == 125`, changes containing `protein_g`, and `show_support == false`. The meter records exactly one call with `CallType == "plan_otto"`.
  - `TestOttoTextOnly`: `change` is null. Expect `proposal == null`.
  - `TestOttoDropsOutOfBounds`: the model returns `kcal_override: 900`. Expect 200, `proposal == null`, and the out-of-bounds reply copy from Global Constraints.
  - `TestOttoAtRiskDropsLowerKcal`: the signals make `guardrails.AtRisk` true (for example, avg intake 1000 kcal over 7 days; check `guardrails.Signals` for the field names). The model returns `kcal_override` below the current kcal but above BMR. Expect `proposal == null`, the at-risk reply copy, and `show_support == true`.
  - `TestOttoAtRiskAllowsHigherProtein`: at risk, but the change only raises protein (kcal unchanged). Expect a proposal and `show_support == true`.
  - `TestOttoAtRiskDropsFasterPace`: at risk, with pace going from 0.5 to 0.7. Expect no proposal.
  - `TestOttoSignalsErrorFailsClosed`: the signals source errors and the model lowers kcal. Expect no proposal and the at-risk reply.
  - `TestOttoBudgetExhausted`: `within=false`. Expect 429 `budget_exhausted` and that the provider is never called.
  - `TestOttoProviderError` and `TestOttoUnparsable`: expect 502 `otto_failed`. The meter still records one call (outcome error for the provider error).
  - `TestOttoNoProvider`: the handler is built without `WithOtto`. Expect 503.
  - `TestOttoMessageValidation`: an empty message and a 501-rune message each give 400.
  - `TestOttoInvalidCurrentOverride`: the draft has `target_kcal_override: 900` and the model returns text only. Expect 200, not 400.
  - `TestOttoNotOnboarded`: a user with `OnboardedAt == nil` still gets 200.

- [ ] **Step 2:** Run `cd api && go test ./internal/onboarding -run TestOtto -v`. Expected: FAIL.

- [ ] **Step 3: Implement** `Otto` with these steps:
  1. Validate the body.
  2. Old targets come from `Calculate(draft)`. If that fails, retry with both overrides nil. If that also fails, return 400.
  3. Check `WithinBudget`.
  4. Use a 15-second `context.WithTimeout`, then `WithUsageCollector`. Call `GenerateText(ctx, ottoSystemPrompt, userJSON)`, where `userJSON` is `{"message","inputs":draft,"targets":oldTargets}`.
  5. Record the call with call type `plan_otto`, mirroring `recipes.Parser.record` / `recordCollected`.
  6. Parse the reply.
  7. If the change is empty, return the reply with no proposal.
  8. Apply the change, then run `Calculate`. On an error, return the out-of-bounds reply.
  9. If the user is at risk (or the signals errored) and `newT.Kcal < oldT.Kcal-0.5`, or the goal isn't maintenance and `new.Pace > old.Pace`, return the at-risk reply with `show_support: true`.
  10. Otherwise return the proposal. `show_support` equals the at-risk value.

  Use the current year from `h.now().Year()`, and the location from `user.LocFromContext(c)`.

  Wire it in `router.go`:
  ```go
  v1.POST("/me/plan/otto", aitrace.Route("plan.otto", deps.AITraceUserKey),
      onboardingHandler.WithOtto(deps.Provider, coachMeter, coach.NewSignalsSource(coachGrounder)).Otto)
  ```
  If `deps.Provider` is nil, leave `WithOtto` uncalled. `onboardingHandler` is declared at line 211; reuse that variable. Check that `coachMeter` is a `billing.Meter`, and use `billing.NewMeter(deps.DB)` if it isn't.

- [ ] **Step 4:** Run `cd api && go test ./internal/onboarding ./internal/metrics ./internal/server && go vet ./...`. Expected: PASS.

- [ ] **Step 5:** Commit `feat(api): Otto proposes plan changes on POST /v1/me/plan/otto`.

### Task 3: Mobile types and `usePlanOtto` hook

**Files:**
- Modify: `apps/mobile/src/api/types.ts` (next to `PlanResponse`, around line 645)
- Modify: `apps/mobile/src/api/hooks.ts` (next to `useSavePlan`, line 293)
- Test: `apps/mobile/src/api/__tests__/`, following the existing hook test files' pattern

**Interfaces:**
- Produces:
  ```ts
  export type PlanChangeField = "activity_level" | "goal" | "goal_weight_kg" | "pace_kg_per_week" | "kcal" | "protein_g" | "carbs_g" | "fat_g";
  export type PlanChange = { field: PlanChangeField; from: string | number; to: string | number };
  export type PlanOttoProposal = { draft: PlanInputs; targets: PlanTargets; changes: PlanChange[] };
  export type PlanOttoResponse = { reply: string; proposal: PlanOttoProposal | null; show_support: boolean };
  export function usePlanOtto(): UseMutationResult<PlanOttoResponse, Error, { message: string; draft: OnboardingInput }>;
  ```

- [ ] **Step 1:** Write a failing test. It asserts that `usePlanOtto().mutate({message, draft})` calls `apiFetch("/v1/me/plan/otto", {method:"POST", body: JSON.stringify({message, draft})})` and invalidates no queries, because the endpoint saves nothing.
- [ ] **Step 2:** Run `cd apps/mobile && npx jest src/api -t usePlanOtto`. Expected: FAIL.
- [ ] **Step 3:** Implement it the same way as `useSavePlan`, without `onSuccess`.
- [ ] **Step 4:** Run the same test. Expected: PASS. Then run `npx tsc --noEmit`, which should be clean.
- [ ] **Step 5:** Commit `feat(mobile): usePlanOtto hook`.

### Task 4: Plan page Otto chat

Load `Skill("sketch-findings-kora")` before styling.

**Files:**
- Create: `apps/mobile/src/components/plan/PlanOtto.tsx`
- Modify: `apps/mobile/app/plan.tsx`: render below the "Body, activity & goal" section and above the primary button
- Test: `apps/mobile/src/components/plan/__tests__/PlanOtto.test.tsx`, plus a case in the existing Plan screen test (find it with `grep -rl "plan-primary" apps/mobile`)

**Interfaces:**
- Consumes: `usePlanOtto` (Task 3); `AskInput` and `Bubble` from `src/components/coach`; `SupportCard`; `isApiError`-style status check (`src/lib/apiErrorMessage.ts:17`).
- Produces:
  ```ts
  export function PlanOtto(props: { draft: PlanDraft; onUse: (draft: PlanDraft) => void }): JSX.Element
  export const PLAN_CHANGE_LABEL: Record<PlanChangeField, string>
  // Activity, Goal, Goal weight, Pace, Calories, Protein, Carbs, Fat
  ```

Behaviour:
- Exchanges are kept in local state as a list `{ you: string; reply: string; proposal: PlanOttoProposal | null; showSupport: boolean }`. Only the newest proposal shows "Use this" and "Not now". "Not now" hides that proposal.
- Proposal card: one row per change, `Label  from → to`, in Menlo numerals.
  - Units: kcal for calories; g for protein, carbs and fat; kg for goal weight; kg/wk for pace.
  - Enum values use the onboarding labels. Reuse the labels `onboarding.tsx` already shows; if they aren't exported, export them rather than copying them.
- Errors: status 429 shows the budget copy, and any other error shows the Otto-failed copy, both verbatim from Global Constraints. The input stays usable.
- `showSupport` renders `SupportCard` under that reply.
- The disclosure line from Global Constraints goes under the input.
- There is no orange accent here. Use ink-styled `PressableScale` text buttons, at least 44 pt tall, like "Use Kora's" in `plan.tsx`.
- `plan.tsx` passes `draft={payload}`. Its `onUse(next)`:
  - resets `kcalText` / `proteinText` to `undefined` and `editing` to `null`
  - calls `router.setParams({ goal_weight_kg: undefined, pace_kg_per_week: undefined, target_kcal_override: undefined, target_protein_override_g: undefined, ...draftToParams(next), mode: params.mode ?? "edit" })`
  - The explicit `undefined`s remove keys the proposal cleared. Check against the expo-router v57 docs that `setParams` drops keys set to `undefined`. If it doesn't, use `router.replace({ pathname: "/plan", params: ... })`.

- [ ] **Step 1: Write failing tests** (`PlanOtto.test.tsx`, with `usePlanOtto` mocked):
  - `sends message with draft`: type "less carbs", tap send, and expect mutate to be called with `{message:"less carbs", draft}`.
  - `shows proposal changes`: the response has changes `protein_g 146→125` and `carbs_g 120→141`. Expect the text `146 → 125` and `Carbs`.
  - `use this calls onUse with proposal draft` and `not now hides the card`.
  - `budget exhausted copy` (an error with `status: 429`) and `failure copy` (status 502). Each matches the exact strings.
  - `support card when show_support`.

  Plan screen test:
  - `use this replaces draft and clears typed overrides`: type 150 into protein. Trigger `onUse` with a draft that has no protein override but has `activity_level: "light"`. Expect `router.setParams` to be called with `target_protein_override_g: undefined` and `activity_level: "light"`.

- [ ] **Step 2:** Run `cd apps/mobile && npx jest PlanOtto plan`. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run `npx jest && npx tsc --noEmit && npx expo lint`. Expected: all pass.
- [ ] **Step 5:** Commit `feat(mobile): Otto chat on the Plan page`.
