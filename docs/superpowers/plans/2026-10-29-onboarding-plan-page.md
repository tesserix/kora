# Onboarding defaults and the Plan page (part 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Onboarding saves only values the user chose. Protein follows goal and activity. A new Plan page shows the targets with their working, takes calorie and protein overrides, and is reachable from Profile.

**Architecture:** The Go calculator stays authoritative and gains a protein table and override bounds. The TS mirror is kept honest by the shared golden file. Two new endpoints, `GET` and `PUT /v1/me/plan`, live in the onboarding package beside `Submit` and reuse its resolve-and-save path. On mobile:
- The onboarding screen loses its defaults and hands a draft to a new `/plan` route. That route submits onboarding, or saves the plan when opened from Profile.
- `TickRuler` and `SegmentedGlass` gain an unset state.

**Tech Stack:** Go + gin + gorm + Postgres (golang-migrate files); Expo SDK 57 / expo-router / TanStack Query / Jest.

**Spec:** `docs/superpowers/specs/2026-10-29-onboarding-and-plan-review-design.md`

**Out of scope (later plans):**
- Part 2: Otto chat on the Plan page.
- Part 3: weight-change suggestions, Otto notifications, `plan_suggestions`, and the notifications migration.

**Deviation from the spec:** `POST /v1/me/plan/preview` is dropped. The TS mirror shows bounds errors live. `PUT` and `POST /v1/onboarding` refuse invalid overrides with the same codes. A preview call would add a round trip and show nothing new.

## Global Constraints

- Server is authoritative. `apps/mobile/src/lib/plan.ts` mirrors `api/internal/onboarding/calc.go`. `api/internal/onboarding/testdata/golden_targets.json` is asserted by both suites. Any formula change updates all three in the same task.
- Protein = factor × reference weight. Reference weight is the goal weight for `fat_loss` when one is set, and current weight otherwise. Factors (g/kg):

  | Goal | Sedentary | Light | Moderate | Active | Very active |
  |---|---|---|---|---|---|
  | `fat_loss` | 1.6 | 1.6 | 1.8 | 1.8 | 1.8 |
  | `maintenance` | 1.2 | 1.4 | 1.6 | 1.6 | 1.6 |
  | `muscle_gain` | 1.8 | 1.8 | 2.0 | 2.0 | 2.0 |

- Fat = 25% of calories. Carbs = the rest, clamped at 0. The BMR floor is unchanged.
- Override bounds:
  - calories: ≥ BMR and ≤ 2 × TDEE.
  - protein: ≥ 0.8 × current weight and ≤ 2.5 × current weight, and protein × 4 ≤ 0.75 × the effective calories.
  - Only calories and protein can be overridden.
- Override error codes, identical in Go and TS:
  - `kcal_below_resting_burn`
  - `kcal_above_ceiling`
  - `protein_below_min`
  - `protein_above_max`
  - `protein_exceeds_share`
- An override is never changed or dropped for the user. If it no longer fits, it is flagged, and Save stays disabled until the user adjusts or clears it.
- UI follows `sketch-findings-kora` (Ignition):
  - one bezel cluster per screen and one orange accent per screen
  - Menlo tabular numerals
  - trust and safety text in sentence case, at least 11px
- Kora is app-only: native screens only.
- Git: no AI attribution in commits or PRs (user's global rule).

## Review Focus

1. **The kora#164 trap.** Someone whose real age, height or weight equals the ruler's resting position must be able to set it with a single tap. A displayed-but-unaccepted value must never appear. Pinned in Task 7 (`tap on an unset ruler commits the rest value`) and Task 8 (`a user can complete onboarding without dragging any ruler`).
2. **Imperial users.** An unset lb/in ruler commits the rest value converted to kg/cm, not the raw lb/in number. Pinned in Task 8 (`imperial tap-to-set sends kilograms`).
3. **VoiceOver.** Increment or decrement on an unset ruler sets the value one step from rest. Pinned in Task 7.
4. **An override invalidated by changed inputs.** For example, a weight drop makes a protein override exceed 2.5 g/kg. Pinned in Task 5 (`GET returns override_error for an override the new weight invalidates`) and Task 9 (`save is disabled while an override is flagged`).
5. **Submit failure on the Plan page keeps the draft.** A network error leaves the user on `/plan` with every value intact and the error shown. Pinned in Task 9.

---

## File Structure

| File | Responsibility |
|---|---|
| `api/internal/onboarding/calc.go` | Protein table, overrides, `Targets` basis fields |
| `api/internal/onboarding/testdata/golden_targets.json` | Shared vectors, now with goal weight, overrides and error cases |
| `api/internal/onboarding/handler.go` | `Submit` refactored onto `resolve`; overrides accepted |
| `api/internal/onboarding/plan_handler.go` (new) | `GET` and `PUT /v1/me/plan` |
| `api/internal/database/migrations/000066_plan_overrides.{up,down}.sql` (new) | Override columns, basis weight, `plan_saved_at` |
| `api/internal/user/model.go`, `repository.go` | New fields; `SavePlan` |
| `api/internal/tracking/repository.go` | `LatestWeightKg` |
| `api/internal/server/router.go` | Routes |
| `apps/mobile/src/lib/plan.ts` | Mirror of calc.go |
| `apps/mobile/src/api/types.ts`, `hooks.ts` | Types, `usePlan`, `useSavePlan` |
| `apps/mobile/src/components/instrument/TickRuler.tsx`, `SegmentedGlass.tsx` | Unset state |
| `apps/mobile/app/onboarding.tsx` | No defaults; hands the draft to `/plan`; edit mode |
| `apps/mobile/app/plan.tsx` (new) | Plan page |
| `apps/mobile/src/lib/planDraft.ts` (new) | Draft ⇄ route params |
| `apps/mobile/app/profile.tsx` | "Your plan" row |
| `apps/mobile/src/components/home/PlanReviewCard.tsx` (new), `app/(tabs)/index.tsx` | One-time "Check your plan" card |

---

### Task 1: Protein table (Go + TS + golden)

**Files:**
- Modify: `api/internal/onboarding/calc.go`, `api/internal/onboarding/calc_test.go`
- Modify: `apps/mobile/src/lib/plan.ts`, `apps/mobile/src/lib/__tests__/plan.test.ts`
- Modify: `api/internal/onboarding/testdata/golden_targets.json`

**Interfaces:**
- Produces (Go):
  - `Targets` gains `Bmr float64 json:"bmr"`, `Tdee float64 json:"tdee"`, `ProteinGPerKg float64 json:"protein_g_per_kg"` and `ProteinRefKg float64 json:"protein_ref_kg"`.
  - `func proteinFactor(goal, activity string) float64`.
  - `SplitMacros` keeps its signature for other callers. `Calculate` stops using it for protein and computes protein from the table.
- Produces (TS):
  - `PlanInput` gains `goalWeightKg?: number`.
  - `Plan` gains `proteinGPerKg: number` and `proteinRefKg: number`.
  - `export function proteinFactor(goal: PlanGoal, activity: ActivityLevel): number`.
- Golden cases gain an optional `"goal_weight_kg"` and a required `"protein_g_per_kg"`. Both test files pass `goal_weight_kg` through and assert `protein_g_per_kg`.

- [ ] **Step 1: Write the failing tests.**
  - Go `TestProteinFollowsGoalAndActivity`, table-driven over all 15 cells of the factor table, asserting `proteinFactor`.
  - Go `TestFatLossProteinUsesGoalWeight`:
    - Input: female, 36, 160 cm, 73 kg, `light`, `fat_loss`, goal 68, pace 0.25.
    - Expect protein 108.8, kcal 1634.875, `ProteinRefKg` 68 and `ProteinGPerKg` 1.6.
    - The same with `moderate` and pace 0.5: protein 122.4 and kcal 1602.95.
  - Go `TestFatLossWithoutGoalWeightUsesCurrentWeight`: the same input with `GoalWeightKg` 0 gives protein 1.6 × 73 = 116.8.
  - Add the two tester cases above to the golden file. Update the 5 existing golden cases' `protein_g` and `carbs_g` to the new formula. These have no goal weight, so the reference is current weight; for example, case 1 becomes 1.8 × 84 = 151.2.
  - TS: the `computePlan` golden test passes `goalWeightKg` and asserts `proteinGPerKg`. Add an `it.each` over the factor table for `proteinFactor`.
- [ ] **Step 2: Run both suites and confirm they fail.**
  - Go: `cd api && go test ./internal/onboarding/ -run 'Protein|Golden'`. Expected: FAIL (proteinFactor undefined, golden mismatches).
  - TS: `cd apps/mobile && npx jest src/lib/__tests__/plan.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Go: in `calc.go`, replace `proteinGPerKg` with a `proteinFactors map[string]map[string]float64` and `proteinFactor`.
  - Go: `Calculate` sets `ProteinRefKg = GoalWeightKg` when goal is `fat_loss` and `GoalWeightKg > 0`, and `WeightKg` otherwise. Fat and carbs are computed exactly as `SplitMacros` does today, using that protein. `Bmr` and `Tdee` are filled in.
  - TS: mirror the same in `plan.ts`.
  - Regenerate the golden values with a throwaway `go test -run` print, not committed. Hand-check the two tester cases against the numbers above before pasting.
- [ ] **Step 4: Run both suites and confirm they pass.** Run the same two commands. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(onboarding): protein follows goal and activity, not a flat 2 g/kg"`

### Task 2: Overrides and their bounds (Go + TS + golden)

**Files:** the same five as Task 1.

**Interfaces:**
- Produces (Go):
  - `Input` gains `KcalOverride *float64 json:"target_kcal_override"` and `ProteinOverrideG *float64 json:"target_protein_override_g"`.
  - `Targets` gains `KcalOverridden bool json:"kcal_overridden"` and `ProteinOverridden bool json:"protein_overridden"`.
  - `type OverrideError struct{ Code string }`, which implements `error`.
  - `Calculate` returns `*OverrideError` for an out-of-bounds override, after all other validation.
- Produces (TS):
  - `PlanInput` gains `kcalOverride?: number | null` and `proteinOverrideG?: number | null`.
  - `Plan` gains `kcalOverridden: boolean`, `proteinOverridden: boolean` and `overrideError: OverrideCode | null`. TS returns the error rather than throwing, and still returns the plan computed without the bad override, so the screen can show both.
  - `export type OverrideCode`: a union of the five codes.
- Golden cases gain optional `"kcal_override"`, `"protein_override_g"` and `"override_error"`.

- [ ] **Step 1: Write the failing tests** for the tester input (female 36/160/73, light, fat_loss, goal 68, pace 0.25; BMR 1389, TDEE 1909.875):
  - `TestKcalOverrideReplacesTarget`: 1500 → kcal 1500, fat 1500 × 0.25 / 9, carbs = the rest, `KcalOverridden` true, `Floored` false.
  - `TestKcalOverrideBounds`: 1388 → `kcal_below_resting_burn`; 3820 → `kcal_above_ceiling` (2 × TDEE = 3819.75); 1389 and 3819.75 both accepted.
  - `TestProteinOverrideReplacesTarget`: 125 → protein 125, carbs reduced by (125 − 108.8) × 4 / 4.
  - `TestProteinOverrideBounds`: 58.3 → `protein_below_min` (0.8 × 73 = 58.4); 182.6 → `protein_above_max` (2.5 × 73 = 182.5).
  - `TestProteinOverrideShareUsesEffectiveKcal`:
    - Input: female, 60, 160 cm, 200 kg, `sedentary`, `maintenance`. BMR = 2000 + 1000 − 300 − 161 = 2539.
    - kcal override 2539 with protein override 500 (exactly the 2.5 g/kg max) gives 2000 kcal from protein, more than 0.75 × 2539 = 1904.25, so expect `protein_exceeds_share`.
    - The same input with protein 470 (1880 kcal) is accepted.
  - Add golden cases: one valid case per override, and one per error code that is reachable.
  - TS: the golden test passes the overrides and asserts `overrideError`. Add a TS test: with a bad override, `computePlan` returns `overrideError` and the un-overridden numbers.
- [ ] **Step 2: Run both suites and confirm they fail.** Run the same commands as Task 1. Expected: FAIL.
- [ ] **Step 3: Implement.** Apply the overrides after the floor:
  - The kcal override replaces kcal and clears `Floored`.
  - Fat is recomputed from the effective kcal.
  - The protein override replaces protein.
  - Carbs are recomputed and clamped at 0.
  - Check order: kcal bounds, then protein min/max, then share.
- [ ] **Step 4: Run both suites and confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(onboarding): calorie and protein overrides with safety bounds"`

### Task 3: Schema, user fields and latest weight

**Files:**
- Create: `api/internal/database/migrations/000066_plan_overrides.up.sql`, `.down.sql`
- Modify: `api/internal/user/model.go`, `api/internal/user/repository.go`, `api/internal/user/repository_test.go`
- Modify: `api/internal/tracking/repository.go`, `api/internal/tracking/repository_test.go`

**Interfaces:**
- Up migration:
  - `ALTER TABLE users ADD COLUMN target_kcal_override DOUBLE PRECISION, ADD COLUMN target_protein_override_g DOUBLE PRECISION, ADD COLUMN plan_basis_weight_kg DOUBLE PRECISION NOT NULL DEFAULT 0, ADD COLUMN plan_saved_at TIMESTAMPTZ;`
  - `UPDATE users SET plan_basis_weight_kg = weight_kg;`
- Down migration drops the four columns.
- `user.User` gains `TargetKcalOverride *float64`, `TargetProteinOverrideG *float64`, `PlanBasisWeightKg float64` and `PlanSavedAt *time.Time`. Their JSON tags are the column names.
- `user.OnboardingFields` gains `TargetKcalOverride *float64`, `TargetProteinOverrideG *float64` and `PlanBasisWeightKg float64`.
- `SaveOnboarding` also writes those three and `plan_saved_at = now()`.
- New `func (r Repository) SavePlan(ctx, userID uuid.UUID, f OnboardingFields) (User, error)` writes the same as `SaveOnboarding` except `onboarded_at`. Share one private `saveFields(ctx, id, f, markOnboarded bool)`.
- `tracking.Repository.LatestWeightKg(ctx, userID uuid.UUID) (kg float64, ok bool, err error)` returns the most recent `weight_entries` row by `logged_at`.

- [ ] **Step 1: Write the failing tests.**
  - `TestSavePlanKeepsOnboardedAt`: onboard, then `SavePlan`; `onboarded_at` is unchanged and `plan_saved_at` is set.
  - `TestSaveOnboardingWritesOverridesAndBasis`: a nil override stays NULL, and 125 round-trips.
  - `TestLatestWeightKg`: no rows gives `ok=false`; with two rows, the later `logged_at` wins.
- [ ] **Step 2: Confirm they fail.** Run `cd api && go test ./internal/user/ ./internal/tracking/ -run 'SavePlan|SaveOnboardingWrites|LatestWeight'`. These need local Postgres, the same as the existing suites. Expected: FAIL.
- [ ] **Step 3: Implement.** Write the migration and the repository methods.
- [ ] **Step 4: Confirm they pass.** Run the same command, then the full `go test ./internal/user/ ./internal/tracking/`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(api): store plan overrides, basis weight and plan_saved_at"`

### Task 4: Onboarding submit accepts overrides

**Files:** Modify `api/internal/onboarding/handler.go` and `handler_test.go`.

**Interfaces:**
- Produces `func (h Handler) resolve(ctx context.Context, in Input) (user.OnboardingFields, *httpError)`. It holds today's `Submit` logic from `Calculate` through the target-date derivation, and also fills in the overrides and `PlanBasisWeightKg = in.WeightKg`. Choose the private error shape; it carries the HTTP status, code and message.
- `Submit` becomes: bind, then `resolve`, then `SaveOnboarding`, then `recordFirstWeighIn`, then OK.
- An `*OverrideError` from `Calculate` maps to `400 invalid_override`, with the code in the message (`httpx.Error(c, 400, "invalid_override", oe.Code)`).

- [ ] **Step 1: Write the failing tests.**
  - `TestSubmitStoresOverrides`: `target_protein_override_g: 125` gives 200 with `target_protein_g` 125, and the override is stored.
  - `TestSubmitRejectsOutOfRangeOverride`: kcal 500 for a 1389-BMR body gives 400, code `invalid_override`, message `kcal_below_resting_burn`.
  - `TestSubmitSetsBasisWeightAndPlanSavedAt`.
- [ ] **Step 2: Confirm they fail.** Run `go test ./internal/onboarding/ -run Submit`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the refactor and the mapping.
- [ ] **Step 4: Confirm they pass.** Run `go test ./internal/onboarding/`. Expected: all PASS, including the existing Submit tests.
- [ ] **Step 5: Commit.** `git commit -m "feat(onboarding): accept calorie and protein overrides at submit"`

### Task 5: `GET` and `PUT /v1/me/plan`

**Files:**
- Create: `api/internal/onboarding/plan_handler.go`, `plan_handler_test.go`
- Modify: `api/internal/onboarding/handler.go`: the `WeightRecorder` interface gains `LatestWeightKg` from Task 3.
- Modify: `api/internal/server/router.go`: add `v1.GET("/me/plan", onboardingHandler.GetPlan)` and `v1.PUT("/me/plan", onboardingHandler.PutPlan)` beside `/onboarding`.

**Interfaces:**
- `GET /v1/me/plan` returns 200:
  ```json
  {"inputs": {"sex","birth_year","height_cm","weight_kg","activity_level","goal",
              "goal_weight_kg","pace_kg_per_week","target_kcal_override","target_protein_override_g"},
   "targets": <Targets>,
   "override_error": null | "<code>"}
  ```
  - `weight_kg` is `LatestWeightKg`, falling back to `users.weight_kg`.
  - `targets` is `Calculate` over those inputs. If an override no longer fits, `targets` is computed without it and `override_error` carries the code.
  - Returns 409 `not_onboarded` when `onboarded_at` is nil.
- `PUT /v1/me/plan`:
  - Takes the same body as `POST /v1/onboarding` and runs it through `resolve`, then `SavePlan`.
  - When `in.WeightKg` differs from the stored `users.weight_kg` by ≥ 0.05, it records a weigh-in through `AddWeightEntry` with `ID: uuid.Nil` (a fresh entry) and the user's timezone date. As in `Submit`, a failure there is logged and swallowed.
  - Returns 200 with the saved user, 400 for invalid input or an invalid override, and 409 `not_onboarded`.

- [ ] **Step 1: Write the failing tests.**
  - `TestGetPlanUsesLatestWeighIn`: onboard at 73 kg and add a 71 kg weigh-in. GET reports `weight_kg` 71 and targets computed at 71.
  - `TestGetPlanReturnsOverrideErrorForAnOverrideTheNewWeightInvalidates`: onboard at 73 with a protein override of 182; add a 70 kg weigh-in (max 175). Expect `override_error` `protein_above_max`, with `targets.protein_g` the formula value.
  - `TestGetPlanNotOnboarded409`.
  - `TestPutPlanSavesWithoutTouchingOnboardedAt`.
  - `TestPutPlanRecordsWeighInOnlyWhenWeightChanged`: the same weight leaves the weigh-in count unchanged; a new weight adds one.
  - `TestPutPlanRejectsInvalidOverride`: 400 `invalid_override`.
- [ ] **Step 2: Confirm they fail.** Run `go test ./internal/onboarding/ -run Plan`. Expected: FAIL.
- [ ] **Step 3: Implement** both handlers and the routes.
- [ ] **Step 4: Confirm they pass.** Run `go test ./internal/onboarding/ ./internal/server/`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(api): GET and PUT /v1/me/plan"`

### Task 6: Mobile API types and hooks

**Files:** Modify `apps/mobile/src/api/types.ts`, `apps/mobile/src/api/hooks.ts`, and `apps/mobile/src/api/__tests__/` (follow the hooks test file already there).

**Interfaces:**
- `Profile` gains:
  - `target_kcal_override: number | null`
  - `target_protein_override_g: number | null`
  - `plan_basis_weight_kg: number`
  - `plan_saved_at: string | null`
- `OnboardingInput` gains optional `target_kcal_override?: number | null` and `target_protein_override_g?: number | null`.
- `export type PlanResponse = { inputs: PlanInputs; targets: PlanTargets; override_error: OverrideCode | null }`. The types mirror Task 5. `OverrideCode` is imported from `@/lib/plan`.
- `export function usePlan(): UseQueryResult<PlanResponse, Error>` uses the query key `["plan"]`.
- `export function useSavePlan(): UseMutationResult<Profile, Error, OnboardingInput>` sends `PUT /v1/me/plan`. On success it seeds `["profile"]` the same way `useSubmitOnboarding` does, and invalidates `["plan"]`.

- [ ] **Step 1: Write the failing tests.** `useSavePlan` PUTs the body and seeds the profile. `usePlan` GETs `/v1/me/plan`.
- [ ] **Step 2: Confirm they fail.** Run `npx jest src/api`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Confirm they pass.** Run `npx jest src/api && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(mobile): plan API types and hooks"`

### Task 7: Unset state for `TickRuler` and `SegmentedGlass`

**Files:**
- Modify: `apps/mobile/src/components/instrument/TickRuler.tsx`, `SegmentedGlass.tsx`
- Modify: `__tests__/TickRuler.test.tsx`, `__tests__/SegmentedGlass.test.tsx`

**Interfaces:**
- `ContinuousProps.value` becomes `number | null`, plus a new `restValue?: number`. `restValue` is required when `value` is null; that is a type error, not a runtime one.
  - While null: the ticks rest at `restValue`. No numeral is drawn; the face shows "Slide to set" (`unsetLabel?: string`). The accessibility value reads "Not set".
  - **Any** pan end reports, including a zero-translation tap, with `compute(restValue, translationX)`.
  - Increment and decrement report `restValue ± step`.
- `DetentedProps.index` becomes `number | null`, plus `restIndex?: number`. The same rules apply: no stop is drawn as selected, a tap reports `restIndex`, and the accessibility actions report from `restIndex`.
- `SegmentedGlass` `value: string | null`. With null, no option is selected; the unselected styling is a dashed well, as in the approved mockup.
- When `value` or `index` is non-null, behaviour is byte-for-byte unchanged. The existing tests must pass untouched.

- [ ] **Step 1: Write the failing tests.**
  - `tap on an unset ruler commits the rest value`
  - `an unset ruler shows "Slide to set" and no numeral`
  - `increment on an unset ruler reports rest + step`
  - `an unset detented ruler shows no selected stop and a tap reports restIndex`
  - `SegmentedGlass with null value selects nothing`
- [ ] **Step 2: Confirm they fail.** Run `npx jest src/components/instrument/__tests__/TickRuler.test.tsx src/components/instrument/__tests__/SegmentedGlass.test.tsx`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Confirm they pass.** Run the same command plus `npx tsc --noEmit`. Expected: PASS, with all existing tests green.
- [ ] **Step 5: Commit.** `git commit -m "feat(mobile): unset state for TickRuler and SegmentedGlass"`

### Task 8: Onboarding screen with nothing pre-selected

**Files:**
- Create: `apps/mobile/src/lib/planDraft.ts`, `apps/mobile/src/lib/__tests__/planDraft.test.ts`
- Modify: `apps/mobile/app/onboarding.tsx`, `apps/mobile/app/__tests__/onboarding.test.tsx`

**Interfaces:**
- `planDraft.ts`:
  - `export type PlanDraft = OnboardingInput` (the full payload, overrides included).
  - `export function draftToParams(d: PlanDraft): Record<string, string>`.
  - `export function draftFromParams(p: Record<string, string | string[] | undefined>): PlanDraft | null` returns null when any required field is missing or not a number. This is a trust boundary, because route params are strings.
- `onboarding.tsx` state:
  - `sex`, `age`, `heightCm`, `weightKg`, `activityIndex`, `goalIndex`, `chosenGoalWeightKg` and `paceIndex` all start as `null`.
  - Rest positions: age 30, height 170 cm, weight 70 kg, activity index 2, goal index 0, pace index 1. The goal-weight rest is `deriveGoalWeightKg(...)`, shown only once goal and weight are set.
- **Header:** until every required field is set, the dial area shows the plain-language list of what's missing, for example "Set your sex, age and activity". This replaces the dial, the numeral and `PlanDelta`. Required fields: sex, age, height, weight, activity, goal, and, for non-maintenance goals, goal weight and pace.
- **Below the rulers:** the `DerivationChain` and macro trio render only when everything is set.
- **Activity caption:** while unset, reads "Pick one: this changes your calories by up to ~500 kcal".
- **Button:** "See my plan", disabled until complete. It does **not** submit; it calls `router.push({ pathname: "/plan", params: { ...draftToParams(input), mode: "onboarding" } })`.
- **Edit mode:** route params `mode=edit` plus a draft pre-fill every value. The button then reads "Update plan" and calls `router.navigate({ pathname: "/plan", params: { ...draftToParams(input), mode: "edit" } })`.
- Delete the kora#164 comment block (lines ~185-200). Replace it with one line: the screen holds no defaults, a tap sets a ruler's rest value, and kora#164's displayed-but-unaccepted trap cannot occur because nothing is displayed until it is set.

- [ ] **Step 1: Write the failing tests** in `onboarding.test.tsx`:
  - `nothing is selected on first render and See my plan is disabled`
  - `the header names what is missing`
  - `a user can complete onboarding without dragging any ruler`: tap each ruler and segment once; the button enables, and the pushed params equal the rest values.
  - `imperial tap-to-set sends kilograms`
  - `See my plan pushes /plan with the draft and does not call the onboarding API`
  - `edit mode pre-fills from params and navigates back to /plan`
  - In `planDraft.test.ts`: a round trip, plus `draftFromParams` returns null for a missing or NaN field.
- [ ] **Step 2: Confirm they fail.** Run `npx jest app/__tests__/onboarding.test.tsx src/lib/__tests__/planDraft.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Remove or rewrite any existing onboarding test that asserted defaults or submitting from this screen; that behaviour is now intentionally gone.
- [ ] **Step 4: Confirm they pass.** Run the same command plus `npx tsc --noEmit && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(onboarding): start with nothing pre-selected and hand the draft to the Plan page"`

### Task 9: Plan page

**Files:** Create `apps/mobile/app/plan.tsx` and `apps/mobile/app/__tests__/plan.test.tsx`.

**Interfaces:**
- Consumes `draftFromParams`, `computePlan`, `useSubmitOnboarding`, `usePlan` and `useSavePlan`.
- **Sources:**
  - `mode=onboarding`: the draft comes from params.
  - `mode=edit` with a draft in params: the user just edited their inputs.
  - No params: the draft comes from `usePlan().data.inputs`, which covers opening from Profile.
  - If the draft is null in onboarding mode, call `router.replace("/onboarding")`.
- **Layout** (Ignition, one `BezelCluster`):
  - **Calories:** a hero numeral, with `DerivationChain` rows for resting burn, activity-adjusted, goal adjustment and daily target. When `plan.floored`, add a line: "Kept at your resting burn — Kora won't go lower."
  - **Macros:** protein, carbs and fat. Each shows its basis:
    - protein `${proteinGPerKg} g/kg ${goal === "fat_loss" && goal weight ? "goal wt" : "body wt"}`
    - carbs "the rest"
    - fat "25%"
    - When overridden, the basis reads "Your number", with a "Use Kora's" link that clears the override.
  - **Editing:** calories and protein are pressable and open an inline numeric `TextInput`. While editing, `computePlan` runs live. If `overrideError` is set, a one-line message comes from a code→copy map (below), and the primary button is disabled.
  - **Inputs row:** "Body, activity & goal" (a `GroupedList` `Row`) pushes `/onboarding` with `mode=edit` and the draft.
  - **Primary button:** onboarding mode shows "Start with this plan" and calls `useSubmitOnboarding`, then `router.replace("/")`. Edit mode shows "Save" and calls `useSavePlan`, then `safeBack()`. The button is disabled while pending and while `overrideError` is set.
  - **Errors:** server or network errors use `apiErrorMessage`; the screen and draft stay as they are.
  - Keep the medical-advice footnote from `onboarding.tsx` verbatim.
- **Error copy (exact):**
  - `kcal_below_resting_burn`: "That's below your resting burn. Kora won't set a target under it."
  - `kcal_above_ceiling`: "That's more than double your daily burn."
  - `protein_below_min`: "That's below the minimum protein for your weight."
  - `protein_above_max`: "That's above 2.5 g per kg, more than your body can use."
  - `protein_exceeds_share`: "That leaves no room for fat and carbs at this calorie target."

- [ ] **Step 1: Write the failing tests:**
  - `shows the plan computed from the draft with its working`
  - `editing protein shows Your number and recomputes carbs`
  - `save is disabled while an override is flagged`
  - `Use Kora's clears the override`
  - `Start with this plan submits onboarding with the overrides and goes home`
  - `a submit failure keeps the user on the page with the draft intact and the error shown`
  - `opened from Profile, loads usePlan and saves with PUT`
  - `a missing draft in onboarding mode returns to onboarding`
- [ ] **Step 2: Confirm they fail.** Run `npx jest app/__tests__/plan.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Load the `sketch-findings-kora` skill first.
- [ ] **Step 4: Confirm they pass.** Run the same command plus `npx tsc --noEmit && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(mobile): Plan page with working, overrides and save"`

### Task 10: Profile row and the one-time Home card

**Files:**
- Modify: `apps/mobile/app/profile.tsx`, `apps/mobile/app/__tests__/profile.test.tsx`
- Create: `apps/mobile/src/components/home/PlanReviewCard.tsx`, `__tests__/PlanReviewCard.test.tsx`
- Modify: `apps/mobile/app/(tabs)/index.tsx`

**Interfaces:**
- **Profile:** a `Row` titled "Your plan", with detail `${Math.round(target_kcal)} kcal`. Add a "Custom" badge when either override is non-null, using teal status styling per the accent rules. It pushes `/plan` with no params. The read-only targets cluster stays.
- **`PlanReviewCard`:**
  - Renders when `profile.onboarded_at && !profile.plan_saved_at` and the dismissal key is not set.
  - Copy: "Check your plan" / "We've improved how protein is worked out. Take a look." Tapping opens `/plan`.
  - The ✕ dismisses by setting `AsyncStorage` key `kora.planReview.dismissed.<userId>` to `"1"`.
  - It's placed with the other Home cards in `(tabs)/index.tsx`, following `CoachEntryCard`'s placement.

- [ ] **Step 1: Write the failing tests:**
  - `profile shows Your plan with a Custom badge when overridden`
  - `card shows for an onboarded user who never saved a plan`
  - `card hides after dismiss and after plan_saved_at is set`
- [ ] **Step 2: Confirm they fail.** Run `npx jest app/__tests__/profile.test.tsx src/components/home/__tests__/PlanReviewCard.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Confirm they pass.** Run the full `npx jest && npx tsc --noEmit && npm run lint`, then `cd api && go test ./...`. Expected: all PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(mobile): Your plan in Profile and a one-time Check your plan card"`
