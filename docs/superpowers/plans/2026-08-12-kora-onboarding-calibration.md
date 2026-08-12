# Kora Onboarding Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Kora's two-step onboarding form with a single Instrument Glass control panel whose calorie target recalculates live as the user sets each input, ending in an explicit accept gate.

**Architecture:** The screen becomes one scroll with a pinned live readout. Every ordinal input is the same `TickRuler` instrument — continuous mode for numbers, detented mode for labelled stops. The Mifflin-St Jeor formula is mirrored into TypeScript so the readout updates without a network round trip, and a shared golden-vector fixture asserted by both languages prevents the two implementations drifting. Pace replaces the hardcoded −500 kcal deficit, floored at resting burn.

**Tech Stack:** Go 1.26 + Gin + GORM + golang-migrate (API); Expo SDK 57 / React Native 0.86 / React 19 with `react-native-svg`, `react-native-reanimated` 4.5, `react-native-gesture-handler` 2.32, `expo-haptics` (mobile); Jest + `jest-expo` + `@testing-library/react-native`; `testify` for Go.

**Spec:** `docs/superpowers/specs/2026-08-12-kora-onboarding-calibration-design.md` (milestone 1 only — the Otto sheet is milestone 2 and is NOT in this plan).

## Global Constraints

- Go tests run from `api/`: `go test ./internal/onboarding/...`. Mobile tests run from `apps/mobile/`: `npx jest <path>`.
- Expo SDK 57 has breaking changes. Read `https://docs.expo.dev/versions/v57.0.0/` before writing any Expo API call (`apps/mobile/AGENTS.md`).
- Commit messages: conventional-commit prefix, **single line**, no body, no signature.
- Colours come from `useTheme().instrument` (the `InstrumentTokens` set). Never hardcode a hex value in a component.
- Accent (`instrument.accent`, `#FF4A00`) is used on at most one element per view besides the primary CTA. On this screen it is the ruler centre index, the dial needle and the CTA.
- Every numeral that can change uses the mono data face with `fontVariant: ["tabular-nums"]`.
- Engraved labels: 9–11px, uppercase, letterSpacing 0.14–0.26em, `instrument.mut`.
- Any named function called from inside a reanimated worklet MUST carry its own `"worklet"` directive, even in the same file. See the comment block in `apps/mobile/src/components/instrument/gauge.ts:30-38` — omitting it crashes on device while passing under the Jest mock.
- Metric is the wire format. Imperial is a display concern only, converted at the boundary.
- Energy density constant: `7700` kcal per kg. Days per week: `7`.
- Protein: `2.0` g/kg bodyweight. Fat: `25%` of kcal at `9` kcal/g. Carbs: remainder at `4` kcal/g.

---

## File Structure

**API (Go):**
- `api/internal/onboarding/calc.go` — modified. Pace-driven adjustment, BMR floor, macro split extracted.
- `api/internal/onboarding/calc_test.go` — modified. Golden-vector table plus targeted unit tests.
- `api/internal/onboarding/testdata/golden_targets.json` — created. The shared fixture, consumed by Go and TypeScript.
- `api/internal/onboarding/handler.go` — modified. Passes the two new fields through.
- `api/internal/user/model.go` — modified. Three new columns on `User`.
- `api/internal/user/repository.go` — modified. `OnboardingFields` and `SaveOnboarding` carry the new fields.
- `api/internal/database/migrations/000027_onboarding_destination.{up,down}.sql` — created.

**Mobile (TypeScript):**
- `apps/mobile/src/lib/plan.ts` — created. TS mirror of the formula. Pure, no React.
- `apps/mobile/src/lib/__tests__/plan.test.ts` — created. Asserts the same fixture.
- `apps/mobile/src/lib/validateOnboarding.ts` — modified. Age instead of birth year, goal weight checks.
- `apps/mobile/src/components/instrument/TickRuler.tsx` — created. Both modes.
- `apps/mobile/src/components/instrument/PlanDial.tsx` — created.
- `apps/mobile/src/components/instrument/PlanDelta.tsx` — created.
- `apps/mobile/src/components/instrument/DerivationChain.tsx` — created.
- `apps/mobile/src/components/AuthScaffold.tsx` — modified. Pinned `header` slot.
- `apps/mobile/app/onboarding.tsx` — rewritten.
- `apps/mobile/src/api/types.ts` — modified. `OnboardingInput` and `Profile` gain fields.

Each instrument component gets a sibling test in `apps/mobile/src/components/instrument/__tests__/`.

---

### Task 1: Pace-driven targets in Go, with the shared golden fixture

The load-bearing task. The fixture written here is the contract Task 2 asserts against, so its numbers must be exact.

**Files:**
- Create: `api/internal/onboarding/testdata/golden_targets.json`
- Modify: `api/internal/onboarding/calc.go`
- Test: `api/internal/onboarding/calc_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `onboarding.Input` gains `GoalWeightKg float64` (json `goal_weight_kg`) and `PaceKgPerWeek float64` (json `pace_kg_per_week`). `Calculate(in Input, currentYear int) (Targets, error)` keeps its signature. New exported `SplitMacros(kcal, weightKg float64) (proteinG, carbsG, fatG float64)`. New exported const `KcalPerKg = 7700.0`.

- [ ] **Step 1: Write the golden fixture**

Create `api/internal/onboarding/testdata/golden_targets.json`. Every value below is computed from Mifflin-St Jeor exactly as specified in the Global Constraints; do not round them differently.

```json
[
  {
    "name": "male moderate fat loss at half a kilo",
    "sex": "male", "age": 31, "height_cm": 178, "weight_kg": 84,
    "activity_level": "moderate", "goal": "fat_loss", "pace_kg_per_week": 0.5,
    "bmr": 1802.5, "tdee": 2793.875, "kcal": 2243.875,
    "protein_g": 168, "carbs_g": 252.7265625, "fat_g": 62.32986111111111,
    "floored": false
  },
  {
    "name": "female light maintenance ignores pace",
    "sex": "female", "age": 25, "height_cm": 165, "weight_kg": 65,
    "activity_level": "light", "goal": "maintenance", "pace_kg_per_week": 0.5,
    "bmr": 1395.25, "tdee": 1918.46875, "kcal": 1918.46875,
    "protein_g": 130, "carbs_g": 229.712890625, "fat_g": 53.29079861111111,
    "floored": false
  },
  {
    "name": "male active muscle gain adds a surplus",
    "sex": "male", "age": 22, "height_cm": 183, "weight_kg": 70,
    "activity_level": "active", "goal": "muscle_gain", "pace_kg_per_week": 0.25,
    "bmr": 1738.75, "tdee": 2999.34375, "kcal": 3274.34375,
    "protein_g": 140, "carbs_g": 524.912109375, "fat_g": 90.95398148148148,
    "floored": false
  },
  {
    "name": "small sedentary body at an aggressive pace floors at resting burn",
    "sex": "female", "age": 90, "height_cm": 150, "weight_kg": 40,
    "activity_level": "sedentary", "goal": "fat_loss", "pace_kg_per_week": 1,
    "bmr": 726.5, "tdee": 871.8, "kcal": 726.5,
    "protein_g": 80, "carbs_g": 56.21875, "fat_g": 20.180555555555557,
    "floored": true
  },
  {
    "name": "very active female fat loss at the slowest pace",
    "sex": "female", "age": 34, "height_cm": 170, "weight_kg": 62,
    "activity_level": "very_active", "goal": "fat_loss", "pace_kg_per_week": 0.25,
    "bmr": 1391.5, "tdee": 2643.85, "kcal": 2368.85,
    "protein_g": 124, "carbs_g": 296.72265625, "fat_g": 65.80138888888889,
    "floored": false
  }
]
```

- [ ] **Step 2: Write the failing tests**

Replace the whole of `api/internal/onboarding/calc_test.go` with the following. Note `TestCalculateClampsCarbsToZero` is deleted deliberately: with `kcal` floored at BMR its scenario now floors instead of producing negative carbs, so the clamp is tested directly at `SplitMacros` instead.

```go
package onboarding

import (
	"encoding/json"
	"math"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func approx(t *testing.T, want, got, tol float64) {
	t.Helper()
	require.LessOrEqual(t, math.Abs(want-got), tol, "want ~%.4f got %.4f", want, got)
}

// goldenCase mirrors testdata/golden_targets.json, which is also asserted by
// apps/mobile/src/lib/__tests__/plan.test.ts. Changing one implementation
// without the other turns the opposite language's suite red — that is the
// point of the file.
type goldenCase struct {
	Name          string  `json:"name"`
	Sex           string  `json:"sex"`
	Age           int     `json:"age"`
	HeightCm      float64 `json:"height_cm"`
	WeightKg      float64 `json:"weight_kg"`
	ActivityLevel string  `json:"activity_level"`
	Goal          string  `json:"goal"`
	PaceKgPerWeek float64 `json:"pace_kg_per_week"`
	Bmr           float64 `json:"bmr"`
	Tdee          float64 `json:"tdee"`
	Kcal          float64 `json:"kcal"`
	ProteinG      float64 `json:"protein_g"`
	CarbsG        float64 `json:"carbs_g"`
	FatG          float64 `json:"fat_g"`
	Floored       bool    `json:"floored"`
}

func TestCalculateMatchesGoldenVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/golden_targets.json")
	require.NoError(t, err)
	var cases []goldenCase
	require.NoError(t, json.Unmarshal(raw, &cases))
	require.NotEmpty(t, cases)

	const currentYear = 2026
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			got, err := Calculate(Input{
				Sex:           c.Sex,
				BirthYear:     currentYear - c.Age,
				HeightCm:      c.HeightCm,
				WeightKg:      c.WeightKg,
				ActivityLevel: c.ActivityLevel,
				Goal:          c.Goal,
				PaceKgPerWeek: c.PaceKgPerWeek,
			}, currentYear)
			require.NoError(t, err)
			approx(t, c.Kcal, got.Kcal, 0.001)
			approx(t, c.ProteinG, got.ProteinG, 0.001)
			approx(t, c.CarbsG, got.CarbsG, 0.001)
			approx(t, c.FatG, got.FatG, 0.001)
		})
	}
}

// The floor is the safety-critical line: without it a 40kg user asking for
// 1kg/week is handed a negative target.
func TestCalculateNeverReturnsBelowRestingBurn(t *testing.T) {
	got, err := Calculate(Input{
		Sex: "female", BirthYear: 1936, HeightCm: 150, WeightKg: 40,
		ActivityLevel: "sedentary", Goal: "fat_loss", PaceKgPerWeek: 1,
	}, 2026)
	require.NoError(t, err)
	approx(t, 726.5, got.Kcal, 0.001)
}

func TestCalculateMaintenanceIgnoresPace(t *testing.T) {
	withPace, err := Calculate(Input{
		Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 80,
		ActivityLevel: "moderate", Goal: "maintenance", PaceKgPerWeek: 1,
	}, 2025)
	require.NoError(t, err)
	withoutPace, err := Calculate(Input{
		Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 80,
		ActivityLevel: "moderate", Goal: "maintenance",
	}, 2025)
	require.NoError(t, err)
	require.Equal(t, withoutPace.Kcal, withPace.Kcal)
	approx(t, 2759, withPace.Kcal, 1)
}

func TestCalculateRejectsInvalidInput(t *testing.T) {
	base := Input{
		Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 80,
		ActivityLevel: "moderate", Goal: "fat_loss", PaceKgPerWeek: 0.5,
	}
	t.Run("sex", func(t *testing.T) {
		in := base
		in.Sex = "other"
		_, err := Calculate(in, 2025)
		require.Error(t, err)
	})
	t.Run("activity", func(t *testing.T) {
		in := base
		in.ActivityLevel = "olympian"
		_, err := Calculate(in, 2025)
		require.Error(t, err)
	})
	t.Run("goal", func(t *testing.T) {
		in := base
		in.Goal = "vibes"
		_, err := Calculate(in, 2025)
		require.Error(t, err)
	})
	t.Run("pace below zero", func(t *testing.T) {
		in := base
		in.PaceKgPerWeek = -0.5
		_, err := Calculate(in, 2025)
		require.Error(t, err)
	})
	t.Run("pace above one percent of bodyweight", func(t *testing.T) {
		in := base // 80kg, so the cap is 0.8
		in.PaceKgPerWeek = 1
		_, err := Calculate(in, 2025)
		require.Error(t, err)
	})
	t.Run("birth year", func(t *testing.T) {
		in := base
		in.BirthYear = 2030
		_, err := Calculate(in, 2025)
		require.Error(t, err)
	})
}

// The carbs clamp is unreachable through Calculate once kcal is floored at
// BMR, so it is exercised where it lives instead of through a contrived
// whole-input case.
func TestSplitMacrosClampsCarbsToZero(t *testing.T) {
	// 100kg of protein demand (200g = 800kcal) against a 600kcal budget.
	_, carbs, _ := SplitMacros(600, 100)
	require.Equal(t, 0.0, carbs)
}

func TestSplitMacrosSplitsNormally(t *testing.T) {
	protein, carbs, fat := SplitMacros(2000, 80)
	approx(t, 160, protein, 0.001)   // 2g/kg
	approx(t, 55.5555, fat, 0.001)   // 25% of 2000 / 9
	approx(t, 215, carbs, 0.001)     // (2000 - 640 - 500) / 4
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd api && go test ./internal/onboarding/... -run 'Golden|Resting|SplitMacros|Pace' -v`
Expected: FAIL — `in.PaceKgPerWeek undefined`, `SplitMacros undefined`.

- [ ] **Step 4: Implement**

Replace the body of `api/internal/onboarding/calc.go` below the package comment with:

```go
// Package onboarding computes energy and macro targets from user metrics.
package onboarding

import "fmt"

type Input struct {
	Sex           string  `json:"sex"`
	BirthYear     int     `json:"birth_year"`
	HeightCm      float64 `json:"height_cm"`
	WeightKg      float64 `json:"weight_kg"`
	ActivityLevel string  `json:"activity_level"`
	Goal          string  `json:"goal"`
	Timezone      string  `json:"timezone"`

	// GoalWeightKg and PaceKgPerWeek are optional and ignored when Goal is
	// "maintenance" — the client never shows those controls for that goal,
	// so requiring them here would reject a payload the UI cannot produce.
	GoalWeightKg  float64 `json:"goal_weight_kg"`
	PaceKgPerWeek float64 `json:"pace_kg_per_week"`
}

type Targets struct {
	Kcal     float64 `json:"kcal"`
	ProteinG float64 `json:"protein_g"`
	CarbsG   float64 `json:"carbs_g"`
	FatG     float64 `json:"fat_g"`
}

var activityFactors = map[string]float64{
	"sedentary":   1.2,
	"light":       1.375,
	"moderate":    1.55,
	"active":      1.725,
	"very_active": 1.9,
}

var validGoals = map[string]bool{
	"fat_loss":    true,
	"maintenance": true,
	"muscle_gain": true,
}

// Mifflin-St Jeor BMR coefficients and macro-split constants.
const (
	bmrWeightCoef    = 10.0
	bmrHeightCoef    = 6.25
	bmrAgeCoef       = 5.0
	bmrMaleOffset    = 5.0
	bmrFemaleOffset  = -161.0
	maxAgeYears      = 120
	proteinGPerKg    = 2.0
	fatCaloriePct    = 0.25
	kcalPerGramFat   = 9.0
	kcalPerGramMacro = 4.0 // protein and carbs

	// KcalPerKg is the energy density of body mass used to turn a weekly
	// rate of change into a daily calorie adjustment.
	KcalPerKg = 7700.0

	daysPerWeek = 7.0

	// maxPaceFractionOfBodyweight caps the weekly rate at 1% of bodyweight.
	// This is the primary safety limit; the BMR floor below is the backstop
	// for anything that slips past it.
	maxPaceFractionOfBodyweight = 0.01
)

// SplitMacros divides a daily calorie target into grams of protein, carbs and
// fat. Protein scales with bodyweight and fat takes a fixed share of energy,
// so carbs absorb the remainder — which can go negative for a very low target
// against a heavy body, hence the clamp.
func SplitMacros(kcal, weightKg float64) (proteinG, carbsG, fatG float64) {
	proteinG = proteinGPerKg * weightKg
	fatG = (kcal * fatCaloriePct) / kcalPerGramFat
	carbsG = (kcal - proteinG*kcalPerGramMacro - fatG*kcalPerGramFat) / kcalPerGramMacro
	if carbsG < 0 {
		carbsG = 0
	}
	return proteinG, carbsG, fatG
}

func Calculate(in Input, currentYear int) (Targets, error) {
	if in.Sex != "male" && in.Sex != "female" {
		return Targets{}, fmt.Errorf("onboarding: sex must be male or female")
	}
	if in.HeightCm <= 0 || in.WeightKg <= 0 {
		return Targets{}, fmt.Errorf("onboarding: height and weight must be positive")
	}
	age := currentYear - in.BirthYear
	if age <= 0 || age > maxAgeYears {
		return Targets{}, fmt.Errorf("onboarding: birth_year out of range")
	}
	factor, ok := activityFactors[in.ActivityLevel]
	if !ok {
		return Targets{}, fmt.Errorf("onboarding: invalid activity_level")
	}
	if !validGoals[in.Goal] {
		return Targets{}, fmt.Errorf("onboarding: invalid goal")
	}
	if in.PaceKgPerWeek < 0 {
		return Targets{}, fmt.Errorf("onboarding: pace_kg_per_week must not be negative")
	}
	// Maintenance has no destination, so its pace is ignored rather than
	// validated — the client does not render the control for that goal.
	if in.Goal != "maintenance" && in.PaceKgPerWeek > in.WeightKg*maxPaceFractionOfBodyweight {
		return Targets{}, fmt.Errorf("onboarding: pace_kg_per_week exceeds 1%% of bodyweight")
	}

	bmr := bmrWeightCoef*in.WeightKg + bmrHeightCoef*in.HeightCm - bmrAgeCoef*float64(age)
	if in.Sex == "male" {
		bmr += bmrMaleOffset
	} else {
		bmr += bmrFemaleOffset
	}
	tdee := bmr * factor

	// Pace drives the adjustment. This replaces a flat -500/0/+300 map that
	// handed every user the same deficit regardless of body size.
	adjust := 0.0
	switch in.Goal {
	case "fat_loss":
		adjust = -(in.PaceKgPerWeek * KcalPerKg) / daysPerWeek
	case "muscle_gain":
		adjust = (in.PaceKgPerWeek * KcalPerKg) / daysPerWeek
	}

	kcal := tdee + adjust
	// Never hand out a target below resting burn.
	if kcal < bmr {
		kcal = bmr
	}

	proteinG, carbsG, fatG := SplitMacros(kcal, in.WeightKg)
	return Targets{Kcal: kcal, ProteinG: proteinG, CarbsG: carbsG, FatG: fatG}, nil
}
```

- [ ] **Step 5: Run the full package suite**

Run: `cd api && go test ./internal/onboarding/... -v`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add api/internal/onboarding/calc.go api/internal/onboarding/calc_test.go api/internal/onboarding/testdata/golden_targets.json
git commit -m "feat(onboarding): derive the calorie adjustment from pace and floor it at resting burn"
```

---

### Task 2: TypeScript mirror of the formula

**Files:**
- Create: `apps/mobile/src/lib/plan.ts`
- Test: `apps/mobile/src/lib/__tests__/plan.test.ts`

**Interfaces:**
- Consumes: `api/internal/onboarding/testdata/golden_targets.json` from Task 1.
- Produces:
  - `type PlanGoal = "fat_loss" | "maintenance" | "muscle_gain"`
  - `type ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active"`
  - `type PlanInput = { sex: "male" | "female"; age: number; heightCm: number; weightKg: number; activityLevel: ActivityLevel; goal: PlanGoal; paceKgPerWeek: number }`
  - `type Plan = { bmr: number; tdee: number; adjustment: number; kcal: number; proteinG: number; carbsG: number; fatG: number; floored: boolean }`
  - `function computePlan(input: PlanInput): Plan`
  - `function availablePaces(weightKg: number): number[]`
  - `function weeksToGoal(weightKg: number, goalWeightKg: number, paceKgPerWeek: number): number`
  - `const PACE_OPTIONS: readonly number[]`
  - `const ACTIVITY_FACTORS: Record<ActivityLevel, number>`

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/lib/__tests__/plan.test.ts`:

```ts
import goldenCases from "../../../../../api/internal/onboarding/testdata/golden_targets.json";
import { availablePaces, computePlan, weeksToGoal, type PlanInput } from "../plan";

type GoldenCase = {
  name: string;
  sex: "male" | "female";
  age: number;
  height_cm: number;
  weight_kg: number;
  activity_level: PlanInput["activityLevel"];
  goal: PlanInput["goal"];
  pace_kg_per_week: number;
  bmr: number;
  tdee: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  floored: boolean;
};

// The same fixture api/internal/onboarding/calc_test.go asserts. If these two
// implementations ever diverge, one language's suite goes red.
describe("computePlan matches the Go golden vectors", () => {
  it.each(goldenCases as GoldenCase[])("$name", (c) => {
    const plan = computePlan({
      sex: c.sex,
      age: c.age,
      heightCm: c.height_cm,
      weightKg: c.weight_kg,
      activityLevel: c.activity_level,
      goal: c.goal,
      paceKgPerWeek: c.pace_kg_per_week,
    });
    expect(plan.bmr).toBeCloseTo(c.bmr, 6);
    expect(plan.tdee).toBeCloseTo(c.tdee, 6);
    expect(plan.kcal).toBeCloseTo(c.kcal, 6);
    expect(plan.proteinG).toBeCloseTo(c.protein_g, 6);
    expect(plan.carbsG).toBeCloseTo(c.carbs_g, 6);
    expect(plan.fatG).toBeCloseTo(c.fat_g, 6);
    expect(plan.floored).toBe(c.floored);
  });
});

describe("availablePaces", () => {
  // A stop the server would reject must never be offered. The cap is 1% of
  // bodyweight per week.
  it("offers only stops at or under one percent of bodyweight", () => {
    expect(availablePaces(84)).toEqual([0.25, 0.5, 0.75]);
    expect(availablePaces(50)).toEqual([0.25, 0.5]);
    expect(availablePaces(120)).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it("always offers at least the slowest stop", () => {
    expect(availablePaces(20)).toEqual([0.25]);
  });
});

describe("weeksToGoal", () => {
  it("rounds up to whole weeks", () => {
    expect(weeksToGoal(84, 78, 0.5)).toBe(12);
    expect(weeksToGoal(84, 77.9, 0.5)).toBe(13);
  });

  it("returns zero when already at the goal", () => {
    expect(weeksToGoal(78, 78, 0.5)).toBe(0);
  });

  it("works for gaining as well as losing", () => {
    expect(weeksToGoal(70, 75, 0.25)).toBe(20);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/mobile && npx jest src/lib/__tests__/plan.test.ts`
Expected: FAIL — cannot resolve module `../plan`.

- [ ] **Step 3: Implement**

Create `apps/mobile/src/lib/plan.ts`:

```ts
// TypeScript mirror of api/internal/onboarding/calc.go.
//
// It exists because the onboarding readout recalculates on every drag frame
// and cannot round-trip to the API that often. The server stays authoritative:
// its response on accept overwrites whatever this produced. The two are kept
// honest by api/internal/onboarding/testdata/golden_targets.json, which both
// languages' test suites assert against — change one side alone and the other
// goes red.

export type PlanGoal = "fat_loss" | "maintenance" | "muscle_gain";

export type ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active";

export type PlanInput = {
  sex: "male" | "female";
  age: number;
  heightCm: number;
  weightKg: number;
  activityLevel: ActivityLevel;
  goal: PlanGoal;
  paceKgPerWeek: number;
};

export type Plan = {
  bmr: number;
  tdee: number;
  adjustment: number;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** True when the BMR floor bound — the target stopped obeying the user. */
  floored: boolean;
};

export const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

export const PACE_OPTIONS = [0.25, 0.5, 0.75, 1] as const;

const KCAL_PER_KG = 7700;
const DAYS_PER_WEEK = 7;
const MAX_PACE_FRACTION_OF_BODYWEIGHT = 0.01;
const PROTEIN_G_PER_KG = 2.0;
const FAT_CALORIE_PCT = 0.25;
const KCAL_PER_GRAM_FAT = 9;
const KCAL_PER_GRAM_MACRO = 4;

export function computePlan(input: PlanInput): Plan {
  const sexOffset = input.sex === "male" ? 5 : -161;
  const bmr = 10 * input.weightKg + 6.25 * input.heightCm - 5 * input.age + sexOffset;
  const tdee = bmr * ACTIVITY_FACTORS[input.activityLevel];

  let adjustment = 0;
  if (input.goal === "fat_loss") {
    adjustment = -(input.paceKgPerWeek * KCAL_PER_KG) / DAYS_PER_WEEK;
  } else if (input.goal === "muscle_gain") {
    adjustment = (input.paceKgPerWeek * KCAL_PER_KG) / DAYS_PER_WEEK;
  }

  const raw = tdee + adjustment;
  const kcal = Math.max(bmr, raw);

  const proteinG = PROTEIN_G_PER_KG * input.weightKg;
  const fatG = (kcal * FAT_CALORIE_PCT) / KCAL_PER_GRAM_FAT;
  const carbsG = Math.max(
    0,
    (kcal - proteinG * KCAL_PER_GRAM_MACRO - fatG * KCAL_PER_GRAM_FAT) / KCAL_PER_GRAM_MACRO,
  );

  return { bmr, tdee, adjustment, kcal, proteinG, carbsG, fatG, floored: kcal > raw };
}

/**
 * The pace stops this body is allowed to pick. Deriving the options from
 * bodyweight means the UI can never offer a stop the server would reject —
 * at 84kg the cap is 0.84kg/week, so the 1.0 stop simply is not there.
 * The slowest stop is always offered, even to a body under 25kg, so the
 * control is never empty.
 */
export function availablePaces(weightKg: number): number[] {
  const cap = weightKg * MAX_PACE_FRACTION_OF_BODYWEIGHT;
  const allowed = PACE_OPTIONS.filter((pace) => pace <= cap);
  return allowed.length > 0 ? allowed : [PACE_OPTIONS[0]];
}

/** Whole weeks to cover the distance, rounded up. Zero when already there. */
export function weeksToGoal(weightKg: number, goalWeightKg: number, paceKgPerWeek: number): number {
  const distance = Math.abs(goalWeightKg - weightKg);
  if (distance === 0 || paceKgPerWeek <= 0) return 0;
  return Math.ceil(distance / paceKgPerWeek);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/mobile && npx jest src/lib/__tests__/plan.test.ts`
Expected: PASS, 11 assertions across 3 describes.

If the JSON import fails to resolve, add `"resolveJsonModule": true` to `apps/mobile/tsconfig.json`'s `compilerOptions` and re-run.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/plan.ts apps/mobile/src/lib/__tests__/plan.test.ts apps/mobile/tsconfig.json
git commit -m "feat(onboarding): mirror the target formula in TypeScript against shared golden vectors"
```

---

### Task 3: Persist and return the destination

**Files:**
- Create: `api/internal/database/migrations/000027_onboarding_destination.up.sql`
- Create: `api/internal/database/migrations/000027_onboarding_destination.down.sql`
- Modify: `api/internal/user/model.go:35-45`
- Modify: `api/internal/user/repository.go:166-196`
- Modify: `api/internal/onboarding/handler.go:42-47`
- Test: `api/internal/onboarding/handler_test.go`

**Interfaces:**
- Consumes: `onboarding.Input.GoalWeightKg`, `onboarding.Input.PaceKgPerWeek` from Task 1.
- Produces: `user.User` gains `GoalWeightKg float64` (json `goal_weight_kg`), `PaceKgPerWeek float64` (json `pace_kg_per_week`), `TargetDate *time.Time` (json `target_date`). `user.OnboardingFields` gains the same three.

- [ ] **Step 1: Write the migration**

Create `api/internal/database/migrations/000027_onboarding_destination.up.sql`:

```sql
-- Onboarding gains a destination: where the user is headed, how fast, and the
-- date that implies. Nullable with no default so existing rows read as "no
-- destination set", which is also what a maintenance user stores.
ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_weight_kg DOUBLE PRECISION;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pace_kg_per_week DOUBLE PRECISION;
ALTER TABLE users ADD COLUMN IF NOT EXISTS target_date DATE;
```

Create `api/internal/database/migrations/000027_onboarding_destination.down.sql`:

```sql
ALTER TABLE users DROP COLUMN IF EXISTS target_date;
ALTER TABLE users DROP COLUMN IF EXISTS pace_kg_per_week;
ALTER TABLE users DROP COLUMN IF EXISTS goal_weight_kg;
```

- [ ] **Step 2: Write the failing test**

Append to `api/internal/onboarding/handler_test.go`. Match the existing file's setup helpers — read the file first and reuse whatever it already uses to build a handler and a request; the assertions below are what must be added.

```go
func TestSubmitPersistsDestination(t *testing.T) {
	// Uses the same handler/router construction as the tests already in this
	// file — follow their pattern for building `h` and issuing the request.
	body := `{"sex":"male","birth_year":1995,"height_cm":178,"weight_kg":84,` +
		`"activity_level":"moderate","goal":"fat_loss",` +
		`"goal_weight_kg":78,"pace_kg_per_week":0.5}`

	saved := submitOnboarding(t, body) // returns the user.User the handler saved

	require.Equal(t, 78.0, saved.GoalWeightKg)
	require.Equal(t, 0.5, saved.PaceKgPerWeek)
	require.NotNil(t, saved.TargetDate)
	// 6kg at 0.5kg/week is 12 weeks — 84 days from the handler's clock.
	require.Equal(t, 84, int(saved.TargetDate.Sub(referenceNow(t)).Hours()/24))
}

func TestSubmitAcceptsMaintenanceWithoutDestination(t *testing.T) {
	body := `{"sex":"female","birth_year":2000,"height_cm":165,"weight_kg":65,` +
		`"activity_level":"light","goal":"maintenance"}`

	saved := submitOnboarding(t, body)

	require.Equal(t, 0.0, saved.GoalWeightKg)
	require.Nil(t, saved.TargetDate)
}
```

Add the two helpers `submitOnboarding(t *testing.T, body string) user.User` and `referenceNow(t *testing.T) time.Time` to the test file if equivalents do not already exist, wiring them to the same fake/stub repository the existing tests use.

- [ ] **Step 3: Run to verify it fails**

Run: `cd api && go test ./internal/onboarding/... -run Submit -v`
Expected: FAIL — `saved.GoalWeightKg undefined`.

- [ ] **Step 4: Add the model fields**

In `api/internal/user/model.go`, immediately after the `TargetFatG` line (currently line 45), add:

```go
	// Destination. Nil/zero means none was set — which is what a
	// maintenance user stores, not an error state.
	GoalWeightKg  float64    `json:"goal_weight_kg"`
	PaceKgPerWeek float64    `json:"pace_kg_per_week"`
	TargetDate    *time.Time `json:"target_date"`
```

- [ ] **Step 5: Carry them through the repository**

In `api/internal/user/repository.go`, add to `OnboardingFields`:

```go
	GoalWeightKg  float64
	PaceKgPerWeek float64
	TargetDate    *time.Time
```

and to the `updates` map in `SaveOnboarding`:

```go
		"goal_weight_kg":   f.GoalWeightKg,
		"pace_kg_per_week": f.PaceKgPerWeek,
		"target_date":      f.TargetDate,
```

- [ ] **Step 6: Derive the date in the handler**

In `api/internal/onboarding/handler.go`, between the `Calculate` call and the `SaveOnboarding` call, insert:

```go
	// The date is derived, never client-supplied: a client that could post
	// its own target_date could post one the pace does not support.
	var targetDate *time.Time
	if in.Goal != "maintenance" && in.GoalWeightKg > 0 && in.PaceKgPerWeek > 0 {
		distance := math.Abs(in.GoalWeightKg - in.WeightKg)
		if distance > 0 {
			weeks := math.Ceil(distance / in.PaceKgPerWeek)
			d := h.now().AddDate(0, 0, int(weeks)*7)
			targetDate = &d
		}
	}
```

Add `"math"` and `"time"` to the import block. Then extend the `user.OnboardingFields` literal with:

```go
		GoalWeightKg: in.GoalWeightKg, PaceKgPerWeek: in.PaceKgPerWeek, TargetDate: targetDate,
```

- [ ] **Step 7: Run the suite**

Run: `cd api && go test ./internal/onboarding/... ./internal/user/... -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add api/internal/database/migrations/000027_onboarding_destination.up.sql api/internal/database/migrations/000027_onboarding_destination.down.sql api/internal/user/model.go api/internal/user/repository.go api/internal/onboarding/handler.go api/internal/onboarding/handler_test.go
git commit -m "feat(onboarding): persist goal weight, pace and the derived target date"
```

---

### Task 4: Client types and validation

**Files:**
- Modify: `apps/mobile/src/api/types.ts:1-13` (`Profile`) and `:218-225` (`OnboardingInput`)
- Modify: `apps/mobile/src/lib/validateOnboarding.ts`
- Test: `apps/mobile/src/lib/__tests__/validateOnboarding.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `validateOnboardingNumbers(age: string, heightCm: string, weightKg: string, opts?: { heightUnit?: string; weightUnit?: string }): string | null` — **the first parameter changes from birth year to age**. New `validateGoalWeight(goal: PlanGoal, weightKg: number, goalWeightKg: number, weightUnit?: string): string | null`.

- [ ] **Step 1: Extend the API types**

In `apps/mobile/src/api/types.ts`, add to `Profile` after `target_fat_g`:

```ts
  goal_weight_kg: number;
  pace_kg_per_week: number;
  target_date: string | null;
```

and add to `OnboardingInput` after `goal`:

```ts
  goal_weight_kg?: number;
  pace_kg_per_week?: number;
```

- [ ] **Step 2: Write the failing tests**

Replace `apps/mobile/src/lib/__tests__/validateOnboarding.test.ts` with:

```ts
import { validateGoalWeight, validateOnboardingNumbers } from "../validateOnboarding";

describe("validateOnboardingNumbers", () => {
  it("accepts a complete metric set", () => {
    expect(validateOnboardingNumbers("31", "178", "84")).toBeNull();
  });

  it("names every missing field at once", () => {
    expect(validateOnboardingNumbers("", "178", "")).toBe(
      "Please fill in your age, height, and weight.",
    );
  });

  it("rejects non-numeric input", () => {
    expect(validateOnboardingNumbers("thirty", "178", "84")).toBe(
      "Age, height, and weight must be numbers.",
    );
  });

  it("rejects an age outside the range the formula supports", () => {
    expect(validateOnboardingNumbers("12", "178", "84")).toBe("Please enter an age between 13 and 120.");
    expect(validateOnboardingNumbers("130", "178", "84")).toBe("Please enter an age between 13 and 120.");
  });

  it("reports height and weight in the user's own units", () => {
    expect(validateOnboardingNumbers("31", "300", "84")).toBe("Please enter a valid height in cm.");
    expect(
      validateOnboardingNumbers("31", "300", "84", { heightUnit: "ft/in", weightUnit: "lb" }),
    ).toBe("Please enter a valid height in ft/in.");
  });
});

describe("validateGoalWeight", () => {
  it("passes when losing toward a lower weight", () => {
    expect(validateGoalWeight("fat_loss", 84, 78)).toBeNull();
  });

  // A contradiction the user can see on screen should be caught in the field,
  // not by the server.
  it("rejects a fat-loss goal above current weight", () => {
    expect(validateGoalWeight("fat_loss", 84, 90)).toBe(
      "Your goal weight is above your current weight. Pick Build muscle instead, or lower the goal.",
    );
  });

  it("rejects a muscle-gain goal below current weight", () => {
    expect(validateGoalWeight("muscle_gain", 70, 65)).toBe(
      "Your goal weight is below your current weight. Pick Lose weight instead, or raise the goal.",
    );
  });

  it("ignores the goal weight entirely when maintaining", () => {
    expect(validateGoalWeight("maintenance", 84, 40)).toBeNull();
  });

  it("rejects an implausible goal weight", () => {
    expect(validateGoalWeight("fat_loss", 84, 10, "kg")).toBe("Please enter a valid goal weight in kg.");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/mobile && npx jest src/lib/__tests__/validateOnboarding.test.ts`
Expected: FAIL — `validateGoalWeight` is not exported.

- [ ] **Step 4: Implement**

Replace `apps/mobile/src/lib/validateOnboarding.ts` with:

```ts
import type { PlanGoal } from "./plan";

// Range-validates the ALWAYS-METRIC height (cm) and weight (kg) values. The
// optional unit labels only affect the error copy shown to the user, so an
// imperial user sees "in ft/in" / "in lb" instead of "in cm" / "in kg" — the
// numbers validated are metric regardless.
//
// The first argument is AGE, not birth year: the screen collects age because a
// ruler of years-old is legible where a ruler of calendar years is not. The
// wire format still sends birth_year, derived at submit.
export function validateOnboardingNumbers(
  age: string,
  heightCm: string,
  weightKg: string,
  opts?: { heightUnit?: string; weightUnit?: string },
): string | null {
  const heightUnit = opts?.heightUnit ?? "cm";
  const weightUnit = opts?.weightUnit ?? "kg";
  const a = Number(age);
  const h = Number(heightCm);
  const w = Number(weightKg);

  if (!age || !heightCm || !weightKg) {
    return "Please fill in your age, height, and weight.";
  }
  if (Number.isNaN(a) || Number.isNaN(h) || Number.isNaN(w)) {
    return "Age, height, and weight must be numbers.";
  }
  if (a < 13 || a > 120) {
    return "Please enter an age between 13 and 120.";
  }
  if (h <= 0 || h > 260) {
    return `Please enter a valid height in ${heightUnit}.`;
  }
  if (w <= 0 || w > 500) {
    return `Please enter a valid weight in ${weightUnit}.`;
  }
  return null;
}

// A goal weight pointing the opposite way from the goal is a contradiction the
// user can see on screen, so it is caught in the field rather than by the
// server. Maintenance has no destination and is never checked.
export function validateGoalWeight(
  goal: PlanGoal,
  weightKg: number,
  goalWeightKg: number,
  weightUnit = "kg",
): string | null {
  if (goal === "maintenance") return null;
  if (goalWeightKg <= 20 || goalWeightKg > 500) {
    return `Please enter a valid goal weight in ${weightUnit}.`;
  }
  if (goal === "fat_loss" && goalWeightKg > weightKg) {
    return "Your goal weight is above your current weight. Pick Build muscle instead, or lower the goal.";
  }
  if (goal === "muscle_gain" && goalWeightKg < weightKg) {
    return "Your goal weight is below your current weight. Pick Lose weight instead, or raise the goal.";
  }
  return null;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/mobile && npx jest src/lib/__tests__/validateOnboarding.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/api/types.ts apps/mobile/src/lib/validateOnboarding.ts apps/mobile/src/lib/__tests__/validateOnboarding.test.ts
git commit -m "feat(onboarding): validate age and goal weight, and type the destination fields"
```

---

### Task 5: TickRuler — continuous mode

**Files:**
- Create: `apps/mobile/src/components/instrument/TickRuler.tsx`
- Test: `apps/mobile/src/components/instrument/__tests__/TickRuler.test.tsx`

**Interfaces:**
- Consumes: `useTheme().instrument`, `haptics.selection` from `@/motion`, `useMotionPrefs` from `@/motion`.
- Produces:
```ts
export type TickRulerProps = {
  mode: "continuous";
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  formatLabel?: (value: number) => string;
  accessibilityLabel: string;
  testID?: string;
} | {
  mode: "detented";
  index: number;
  labels: readonly string[];
  onChange: (index: number) => void;
  accessibilityLabel: string;
  testID?: string;
};
export function TickRuler(props: TickRulerProps): JSX.Element;
```

Detented mode is implemented in Task 6; this task ships continuous mode and the shared shell.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/components/instrument/__tests__/TickRuler.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react-native";
import { TickRuler } from "../TickRuler";

const base = {
  mode: "continuous" as const,
  min: 35,
  max: 180,
  step: 0.5,
  accessibilityLabel: "Current weight in kilograms",
  testID: "weight-ruler",
};

describe("TickRuler continuous mode", () => {
  it("exposes itself as an adjustable control carrying its formatted value", () => {
    render(<TickRuler {...base} value={84} onChange={jest.fn()} />);
    const ruler = screen.getByTestId("weight-ruler");
    expect(ruler.props.accessibilityRole).toBe("adjustable");
    expect(ruler.props.accessibilityValue).toEqual({ text: "84" });
  });

  it("uses formatLabel for the accessibility value when given one", () => {
    render(
      <TickRuler {...base} value={70} onChange={jest.fn()} formatLabel={(v) => `${v} kilograms`} />,
    );
    expect(screen.getByTestId("weight-ruler").props.accessibilityValue).toEqual({
      text: "70 kilograms",
    });
  });

  it("increments by exactly one step on the accessibility increment action", () => {
    const onChange = jest.fn();
    render(<TickRuler {...base} value={84} onChange={onChange} />);
    fireEvent(screen.getByTestId("weight-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    expect(onChange).toHaveBeenCalledWith(84.5);
  });

  it("decrements by exactly one step", () => {
    const onChange = jest.fn();
    render(<TickRuler {...base} value={84} onChange={onChange} />);
    fireEvent(screen.getByTestId("weight-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "decrement" },
    });
    expect(onChange).toHaveBeenCalledWith(83.5);
  });

  it("does not report a value past the top of the range", () => {
    const onChange = jest.fn();
    render(<TickRuler {...base} value={180} onChange={onChange} />);
    fireEvent(screen.getByTestId("weight-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not report a value below the bottom of the range", () => {
    const onChange = jest.fn();
    render(<TickRuler {...base} value={35} onChange={onChange} />);
    fireEvent(screen.getByTestId("weight-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "decrement" },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders a tick for every major graduation in view", () => {
    render(<TickRuler {...base} value={84} onChange={jest.fn()} />);
    expect(screen.getAllByTestId(/^weight-ruler-tick-/).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npx jest src/components/instrument/__tests__/TickRuler.test.tsx`
Expected: FAIL — cannot resolve `../TickRuler`.

- [ ] **Step 3: Implement continuous mode**

Create `apps/mobile/src/components/instrument/TickRuler.tsx`:

```tsx
import { useCallback, useMemo, useState } from "react";
import { View, type LayoutChangeEvent, type AccessibilityActionEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import Svg, { Line, Text as SvgText } from "react-native-svg";
import { useTheme } from "@/theme";
import { haptics } from "@/motion";

const HEIGHT = 44;
const PX_PER_UNIT = 9;
const BASELINE = HEIGHT - 8;

export type ContinuousProps = {
  mode: "continuous";
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  formatLabel?: (value: number) => string;
  accessibilityLabel: string;
  testID?: string;
};

export type TickRulerProps = ContinuousProps;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const quantize = (v: number, step: number) => Math.round(v / step) * step;

// Floating-point noise makes 0.1+0.2-style drift visible on a 0.5-step ruler,
// so every reported value is rounded to the step's own precision.
function snap(v: number, min: number, max: number, step: number): number {
  const decimals = (String(step).split(".")[1] ?? "").length;
  return Number(clamp(quantize(v, step), min, max).toFixed(decimals));
}

export function TickRuler(props: TickRulerProps) {
  const { instrument } = useTheme();
  const { value, min, max, step, onChange, formatLabel, accessibilityLabel } = props;
  const testID = props.testID ?? "tick-ruler";
  const [width, setWidth] = useState(0);

  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);

  const report = useCallback(
    (next: number) => {
      const snapped = snap(next, min, max, step);
      if (snapped === value) return;
      haptics.selection();
      onChange(snapped);
    },
    [max, min, onChange, step, value],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan().onChange((e) => {
        // Dragging left raises the value: the strip moves under a fixed index,
        // so the scale travels the opposite way to the finger.
        runOnJS(report)(value - e.changeX / PX_PER_UNIT);
      }),
    [report, value],
  );

  const onAccessibilityAction = useCallback(
    (e: AccessibilityActionEvent) => {
      const { actionName } = e.nativeEvent;
      if (actionName === "increment") report(value + step);
      if (actionName === "decrement") report(value - step);
    },
    [report, step, value],
  );

  const mid = width / 2;
  const ticks = useMemo(() => {
    if (!width) return [];
    const out: { key: string; x: number; major: boolean; label?: string }[] = [];
    const span = mid / PX_PER_UNIT;
    const first = Math.ceil(value - span);
    const last = Math.floor(value + span);
    for (let u = first; u <= last; u++) {
      if (u < min || u > max) continue;
      const major = u % 10 === 0;
      out.push({
        key: String(u),
        x: mid + (u - value) * PX_PER_UNIT,
        major,
        label: major ? String(u) : undefined,
      });
    }
    return out;
  }, [max, mid, min, value, width]);

  return (
    <GestureDetector gesture={pan}>
      <View
        testID={testID}
        onLayout={onLayout}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ text: formatLabel ? formatLabel(value) : String(value) }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={onAccessibilityAction}
        style={{ height: HEIGHT, width: "100%" }}
      >
        <Svg width="100%" height={HEIGHT}>
          {ticks.map((t) => (
            <Line
              key={t.key}
              testID={`${testID}-tick-${t.key}`}
              x1={t.x}
              y1={BASELINE}
              x2={t.x}
              y2={BASELINE - (t.major ? 16 : 7)}
              stroke={t.major ? instrument.ink : instrument.tick}
              strokeWidth={t.major ? 1.6 : 1}
            />
          ))}
          {ticks
            .filter((t) => t.label)
            .map((t) => (
              <SvgText
                key={`label-${t.key}`}
                x={t.x}
                y={BASELINE - 22}
                fill={instrument.mut}
                fontSize={9}
                textAnchor="middle"
              >
                {t.label}
              </SvgText>
            ))}
          {/* The fixed centre index — the only accent on the control. */}
          <Line
            testID={`${testID}-index`}
            x1={mid}
            y1={BASELINE + 4}
            x2={mid}
            y2={BASELINE - 24}
            stroke={instrument.accent}
            strokeWidth={2}
          />
        </Svg>
      </View>
    </GestureDetector>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/mobile && npx jest src/components/instrument/__tests__/TickRuler.test.tsx`
Expected: PASS, 7 tests.

If `react-native-gesture-handler` is not already mocked, add `jest.mock("react-native-gesture-handler", () => require("react-native-gesture-handler/jestSetup"))` to `apps/mobile/jest.setup.js` — check whether it is there before adding.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/instrument/TickRuler.tsx apps/mobile/src/components/instrument/__tests__/TickRuler.test.tsx apps/mobile/jest.setup.js
git commit -m "feat(instrument): add TickRuler continuous mode with drag and adjustable a11y"
```

---

### Task 6: TickRuler — detented mode

**Files:**
- Modify: `apps/mobile/src/components/instrument/TickRuler.tsx`
- Test: `apps/mobile/src/components/instrument/__tests__/TickRuler.test.tsx`

**Interfaces:**
- Consumes: the `TickRuler` shell from Task 5.
- Produces: the `DetentedProps` half of `TickRulerProps` — `{ mode: "detented"; index: number; labels: readonly string[]; onChange: (index: number) => void; accessibilityLabel: string; testID?: string }`.

- [ ] **Step 1: Write the failing test**

Append to `apps/mobile/src/components/instrument/__tests__/TickRuler.test.tsx`:

```tsx
const ACTIVITY = ["Sedentary", "Light", "Moderate", "Active", "Very active"] as const;

describe("TickRuler detented mode", () => {
  const detented = {
    mode: "detented" as const,
    labels: ACTIVITY,
    accessibilityLabel: "Activity level",
    testID: "activity-ruler",
  };

  it("reads its value as the label, never the index", () => {
    render(<TickRuler {...detented} index={2} onChange={jest.fn()} />);
    expect(screen.getByTestId("activity-ruler").props.accessibilityValue).toEqual({
      text: "Moderate",
    });
  });

  it("moves exactly one stop on increment", () => {
    const onChange = jest.fn();
    render(<TickRuler {...detented} index={2} onChange={onChange} />);
    fireEvent(screen.getByTestId("activity-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it("stops at the last label rather than reporting a sixth stop", () => {
    const onChange = jest.fn();
    render(<TickRuler {...detented} index={4} onChange={onChange} />);
    fireEvent(screen.getByTestId("activity-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders every stop's label", () => {
    render(<TickRuler {...detented} index={0} onChange={jest.fn()} />);
    ACTIVITY.forEach((label) => expect(screen.getByText(label)).toBeTruthy());
  });

  it("never reports a fractional index", () => {
    const onChange = jest.fn();
    render(<TickRuler {...detented} index={1} onChange={onChange} />);
    fireEvent(screen.getByTestId("activity-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "decrement" },
    });
    const reported = onChange.mock.calls[0][0];
    expect(Number.isInteger(reported)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npx jest src/components/instrument/__tests__/TickRuler.test.tsx -t "detented"`
Expected: FAIL — TypeScript rejects `mode: "detented"`, or the component renders nothing.

- [ ] **Step 3: Implement**

In `apps/mobile/src/components/instrument/TickRuler.tsx`, add above the existing `TickRulerProps`:

```tsx
const DETENT_PX = 96;

export type DetentedProps = {
  mode: "detented";
  index: number;
  labels: readonly string[];
  onChange: (index: number) => void;
  accessibilityLabel: string;
  testID?: string;
};
```

change the union to `export type TickRulerProps = ContinuousProps | DetentedProps;`, rename the existing exported function to `ContinuousRuler` (keeping it internal — drop the `export`), and add:

```tsx
function DetentedRuler(props: DetentedProps) {
  const { instrument } = useTheme();
  const { index, labels, onChange, accessibilityLabel } = props;
  const testID = props.testID ?? "tick-ruler";
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);

  const report = useCallback(
    (next: number) => {
      // Detented mode reports stops, never positions: a fractional index would
      // reach the plan formula as an invalid activity level.
      const stop = clamp(Math.round(next), 0, labels.length - 1);
      if (stop === index) return;
      haptics.selection();
      onChange(stop);
    },
    [index, labels.length, onChange],
  );

  const pan = useMemo(
    () => Gesture.Pan().onChange((e) => runOnJS(report)(index - e.changeX / DETENT_PX)),
    [index, report],
  );

  const onAccessibilityAction = useCallback(
    (e: AccessibilityActionEvent) => {
      if (e.nativeEvent.actionName === "increment") report(index + 1);
      if (e.nativeEvent.actionName === "decrement") report(index - 1);
    },
    [index, report],
  );

  const mid = width / 2;

  return (
    <GestureDetector gesture={pan}>
      <View
        testID={testID}
        onLayout={onLayout}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ text: labels[index] }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={onAccessibilityAction}
        style={{ height: HEIGHT + 8, width: "100%" }}
      >
        <Svg width="100%" height={HEIGHT + 8}>
          {labels.map((label, i) => {
            const x = mid + (i - index) * DETENT_PX;
            const on = i === index;
            return (
              <Line
                key={`stop-${label}`}
                testID={`${testID}-stop-${i}`}
                x1={x}
                y1={BASELINE + 8}
                x2={x}
                y2={BASELINE - 6}
                stroke={on ? instrument.accent : instrument.tick}
                strokeWidth={on ? 2 : 1.4}
              />
            );
          })}
          {labels.map((label, i) => (
            <SvgText
              key={`stop-label-${label}`}
              x={mid + (i - index) * DETENT_PX}
              y={BASELINE - 14}
              fill={i === index ? instrument.ink : instrument.mut}
              fontSize={10}
              fontWeight={i === index ? "600" : "500"}
              textAnchor="middle"
            >
              {label}
            </SvgText>
          ))}
          <Line
            testID={`${testID}-index`}
            x1={mid}
            y1={BASELINE + 12}
            x2={mid}
            y2={BASELINE - 10}
            stroke={instrument.accent}
            strokeWidth={2}
          />
        </Svg>
      </View>
    </GestureDetector>
  );
}

export function TickRuler(props: TickRulerProps) {
  return props.mode === "detented" ? <DetentedRuler {...props} /> : <ContinuousRuler {...props} />;
}
```

- [ ] **Step 4: Run the whole file**

Run: `cd apps/mobile && npx jest src/components/instrument/__tests__/TickRuler.test.tsx`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/instrument/TickRuler.tsx apps/mobile/src/components/instrument/__tests__/TickRuler.test.tsx
git commit -m "feat(instrument): add TickRuler detented mode for ordinal choices"
```

---

### Task 7: PlanDial

**Files:**
- Create: `apps/mobile/src/components/instrument/PlanDial.tsx`
- Test: `apps/mobile/src/components/instrument/__tests__/PlanDial.test.tsx`

**Interfaces:**
- Consumes: `buildGaugeTicks`, `needleFor`, `GAUGE_VIEW_W`, `GAUGE_VIEW_H`, `GAUGE_CENTER_X`, `GAUGE_CENTER_Y` from `./gauge`.
- Produces: `export function PlanDial(props: { kcal: number | null; testID?: string }): JSX.Element`. A `null` kcal renders the unlit "awaiting" state. Scale runs `PLAN_DIAL_MIN = 1200` to `PLAN_DIAL_MAX = 3600`, both exported.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/components/instrument/__tests__/PlanDial.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react-native";
import { PlanDial } from "../PlanDial";

describe("PlanDial", () => {
  // A target built from partial data is a lie, and NaN reaching the needle is
  // a crash — so no numbers means no needle.
  it("renders unlit with no needle when there is no target yet", () => {
    render(<PlanDial kcal={null} testID="plan-dial" />);
    expect(screen.queryByTestId("plan-dial-needle")).toBeNull();
    expect(screen.getByTestId("plan-dial-awaiting")).toBeTruthy();
  });

  it("renders a needle once a target exists", () => {
    render(<PlanDial kcal={2244} testID="plan-dial" />);
    expect(screen.getByTestId("plan-dial-needle")).toBeTruthy();
    expect(screen.queryByTestId("plan-dial-awaiting")).toBeNull();
  });

  it("clamps a target below the scale to the bottom rather than rendering off-dial", () => {
    render(<PlanDial kcal={400} testID="plan-dial" />);
    expect(screen.getByTestId("plan-dial-needle")).toBeTruthy();
  });

  it("clamps a target above the scale to the top", () => {
    render(<PlanDial kcal={9000} testID="plan-dial" />);
    expect(screen.getByTestId("plan-dial-needle")).toBeTruthy();
  });

  it("is hidden from assistive tech — the number is exposed as text elsewhere", () => {
    render(<PlanDial kcal={2244} testID="plan-dial" />);
    expect(screen.getByTestId("plan-dial").props.accessibilityElementsHidden).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npx jest src/components/instrument/__tests__/PlanDial.test.tsx`
Expected: FAIL — cannot resolve `../PlanDial`.

- [ ] **Step 3: Implement**

Create `apps/mobile/src/components/instrument/PlanDial.tsx`:

```tsx
import { View } from "react-native";
import Svg, { Circle, Line } from "react-native-svg";
import { useTheme } from "@/theme";
import { AppText } from "@/components/Text";
import {
  buildGaugeTicks,
  needleFor,
  GAUGE_CENTER_X,
  GAUGE_CENTER_Y,
  GAUGE_VIEW_H,
  GAUGE_VIEW_W,
} from "./gauge";

// GaugeDial is a PROGRESS instrument — value eaten against a budget, with an
// eaten/burned footer. This is a SETTING instrument: the needle sits at the
// target's position on a fixed scale, so changing activity sweeps the needle
// rather than nudging a fill. Same geometry, so the two read as one panel.
export const PLAN_DIAL_MIN = 1200;
export const PLAN_DIAL_MAX = 3600;

export function PlanDial({ kcal, testID = "plan-dial" }: { kcal: number | null; testID?: string }) {
  const { instrument } = useTheme();
  const hasTarget = kcal !== null && Number.isFinite(kcal);

  const fraction = hasTarget
    ? Math.min(1, Math.max(0, (kcal - PLAN_DIAL_MIN) / (PLAN_DIAL_MAX - PLAN_DIAL_MIN)))
    : 0;
  const ticks = buildGaugeTicks(hasTarget ? fraction : 0);
  const needle = hasTarget ? needleFor(fraction) : null;

  return (
    <View testID={testID} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width="100%" height={GAUGE_VIEW_H} viewBox={`0 0 ${GAUGE_VIEW_W} ${GAUGE_VIEW_H}`}>
        {ticks.map((t, i) => (
          <Line
            key={i}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            strokeWidth={t.width}
            strokeLinecap="round"
            stroke={t.lit ? (t.red ? instrument.accent : instrument.tickLit) : instrument.tick}
          />
        ))}
        {needle ? (
          <>
            <Line
              testID={`${testID}-needle`}
              x1={needle.x1}
              y1={needle.y1}
              x2={needle.x2}
              y2={needle.y2}
              stroke={instrument.accent}
              strokeWidth={2.6}
              strokeLinecap="round"
            />
            <Circle cx={GAUGE_CENTER_X} cy={GAUGE_CENTER_Y} r={5} fill={instrument.accent} />
          </>
        ) : (
          <Circle
            cx={GAUGE_CENTER_X}
            cy={GAUGE_CENTER_Y}
            r={5}
            fill="none"
            stroke={instrument.tick}
            strokeWidth={1.4}
          />
        )}
      </Svg>
      {!hasTarget ? (
        <AppText
          testID={`${testID}-awaiting`}
          variant="caption"
          muted
          style={{ textAlign: "center", letterSpacing: 1.6, textTransform: "uppercase" }}
        >
          Awaiting your numbers
        </AppText>
      ) : null}
    </View>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/mobile && npx jest src/components/instrument/__tests__/PlanDial.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/instrument/PlanDial.tsx apps/mobile/src/components/instrument/__tests__/PlanDial.test.tsx
git commit -m "feat(instrument): add PlanDial, a setting gauge sharing GaugeDial geometry"
```

---

### Task 8: PlanDelta and DerivationChain

Both are small, both are pure presentation, and neither is independently shippable — they land together.

**Files:**
- Create: `apps/mobile/src/components/instrument/PlanDelta.tsx`
- Create: `apps/mobile/src/components/instrument/DerivationChain.tsx`
- Test: `apps/mobile/src/components/instrument/__tests__/PlanDelta.test.tsx`
- Test: `apps/mobile/src/components/instrument/__tests__/DerivationChain.test.tsx`

**Interfaces:**
- Consumes: `useTheme().instrument`.
- Produces:
  - `export function PlanDelta(props: { kcal: number | null; floored: boolean; testID?: string }): JSX.Element`
  - `export type DerivationRow = { label: string; value: string; proposed?: string }`
  - `export function DerivationChain(props: { rows: DerivationRow[]; testID?: string }): JSX.Element`

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/components/instrument/__tests__/PlanDelta.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react-native";
import { PlanDelta } from "../PlanDelta";

describe("PlanDelta", () => {
  // Announcing on mount would tell a user their target "changed" before they
  // touched anything.
  it("says nothing on first render", () => {
    render(<PlanDelta kcal={2244} floored={false} testID="delta" />);
    expect(screen.queryByTestId("delta-text")).toBeNull();
  });

  it("names the size and direction of an increase", () => {
    const { rerender } = render(<PlanDelta kcal={2244} floored={false} testID="delta" />);
    rerender(<PlanDelta kcal={2484} floored={false} testID="delta" />);
    expect(screen.getByTestId("delta-text")).toHaveTextContent("+240 kcal from that change");
  });

  it("names a decrease", () => {
    const { rerender } = render(<PlanDelta kcal={2244} floored={false} testID="delta" />);
    rerender(<PlanDelta kcal={2044} floored={false} testID="delta" />);
    expect(screen.getByTestId("delta-text")).toHaveTextContent("−200 kcal from that change");
  });

  // The clamp is the one moment the target stops obeying the user. Saying
  // nothing would undo the trust the whole screen exists to earn.
  it("says the target was held when the floor binds and the number did not move", () => {
    const { rerender } = render(<PlanDelta kcal={726} floored testID="delta" />);
    rerender(<PlanDelta kcal={726} floored testID="delta" />);
    expect(screen.getByTestId("delta-text")).toHaveTextContent("held at your resting burn");
  });

  it("announces politely so a drag does not interrupt the screen reader", () => {
    const { rerender } = render(<PlanDelta kcal={2244} floored={false} testID="delta" />);
    rerender(<PlanDelta kcal={2484} floored={false} testID="delta" />);
    expect(screen.getByTestId("delta-text").props.accessibilityLiveRegion).toBe("polite");
  });
});
```

Create `apps/mobile/src/components/instrument/__tests__/DerivationChain.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react-native";
import { DerivationChain } from "../DerivationChain";

const ROWS = [
  { label: "Resting burn", value: "1,803" },
  { label: "Moving ×1.55", value: "2,794" },
  { label: "To lose 0.5 kg/week", value: "−550" },
  { label: "Your daily target", value: "2,244" },
];

describe("DerivationChain", () => {
  it("renders every row's label and value", () => {
    render(<DerivationChain rows={ROWS} testID="chain" />);
    ROWS.forEach((r) => {
      expect(screen.getByText(r.label)).toBeTruthy();
      expect(screen.getByText(r.value)).toBeTruthy();
    });
  });

  it("shows only the current value when nothing is proposed", () => {
    render(<DerivationChain rows={ROWS} testID="chain" />);
    expect(screen.queryByTestId("chain-row-0-was")).toBeNull();
  });

  // Built now, used in milestone 2: an Otto proposal renders here as a diff
  // rather than silently replacing the numbers.
  it("shows the old value struck through beside the proposed one", () => {
    render(
      <DerivationChain rows={[{ label: "Pace", value: "0.5 kg/wk", proposed: "0.25 kg/wk" }]} testID="chain" />,
    );
    expect(screen.getByTestId("chain-row-0-was")).toHaveTextContent("0.5 kg/wk");
    expect(screen.getByText("0.25 kg/wk")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/mobile && npx jest src/components/instrument/__tests__/PlanDelta.test.tsx src/components/instrument/__tests__/DerivationChain.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement PlanDelta**

Create `apps/mobile/src/components/instrument/PlanDelta.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";

const DEBOUNCE_MS = 600;

/**
 * Names the change the user just caused — the whole argument for this screen.
 * Silent on mount (nothing has changed yet) and debounced, so dragging a ruler
 * produces one announcement rather than a stream of interruptions.
 */
export function PlanDelta({
  kcal,
  floored,
  testID = "plan-delta",
}: {
  kcal: number | null;
  floored: boolean;
  testID?: string;
}) {
  const { instrument } = useTheme();
  const previous = useRef<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const prior = previous.current;
    previous.current = kcal;
    if (prior === null || kcal === null) return;

    const delta = Math.round(kcal) - Math.round(prior);
    const next =
      delta !== 0
        ? `${delta > 0 ? "+" : "−"}${Math.abs(delta)} kcal from that change`
        : floored
          ? "held at your resting burn"
          : null;
    if (next === null) return;

    const timer = setTimeout(() => setMessage(next), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [floored, kcal]);

  if (!message) return null;

  return (
    <AppText
      testID={`${testID}-text`}
      variant="caption"
      accessibilityLiveRegion="polite"
      style={{ color: instrument.accent, letterSpacing: 1.2, textTransform: "uppercase" }}
    >
      {message}
    </AppText>
  );
}
```

Note the test rerenders synchronously, so add `jest.useFakeTimers()` plus `act(() => jest.advanceTimersByTime(600))` after each rerender in the test file, or set `DEBOUNCE_MS` via an optional prop defaulted to 600 and pass `0` in tests. Use the fake-timer approach — the debounce is behaviour worth keeping under test.

- [ ] **Step 4: Implement DerivationChain**

Create `apps/mobile/src/components/instrument/DerivationChain.tsx`:

```tsx
import { View } from "react-native";
import { AppText } from "@/components/Text";
import { Numeral } from "@/components/Numeral";
import { useTheme } from "@/theme";

export type DerivationRow = {
  label: string;
  value: string;
  /** Milestone 2: an Otto proposal renders as before → after, never a silent swap. */
  proposed?: string;
};

export function DerivationChain({
  rows,
  testID = "derivation-chain",
}: {
  rows: DerivationRow[];
  testID?: string;
}) {
  const { instrument, spacing } = useTheme();

  return (
    <View testID={testID}>
      {rows.map((row, i) => (
        <View
          key={row.label}
          testID={`${testID}-row-${i}`}
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: spacing.sm,
            paddingVertical: spacing.xs + 2,
            borderBottomWidth: i === rows.length - 1 ? 0 : 1,
            borderBottomColor: instrument.hairline,
          }}
        >
          <AppText variant="footnote" muted>
            {row.label}
          </AppText>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.xs }}>
            {row.proposed ? (
              <AppText
                testID={`${testID}-row-${i}-was`}
                variant="footnote"
                muted
                style={{ textDecorationLine: "line-through" }}
              >
                {row.value}
              </AppText>
            ) : null}
            <Numeral>{row.proposed ?? row.value}</Numeral>
          </View>
        </View>
      ))}
    </View>
  );
}
```

Read `apps/mobile/src/components/Numeral.tsx` first and match its actual prop shape — if it takes `value` rather than children, adapt the call.

- [ ] **Step 5: Run to verify they pass**

Run: `cd apps/mobile && npx jest src/components/instrument/__tests__/PlanDelta.test.tsx src/components/instrument/__tests__/DerivationChain.test.tsx`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/components/instrument/PlanDelta.tsx apps/mobile/src/components/instrument/DerivationChain.tsx apps/mobile/src/components/instrument/__tests__/PlanDelta.test.tsx apps/mobile/src/components/instrument/__tests__/DerivationChain.test.tsx
git commit -m "feat(instrument): add PlanDelta and DerivationChain"
```

---

### Task 9: AuthScaffold pinned header

**Files:**
- Modify: `apps/mobile/src/components/AuthScaffold.tsx`
- Test: `apps/mobile/src/components/__tests__/AuthScaffold.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `AuthScaffold` props gain `header?: ReactNode`, rendered above the ScrollView and outside it. All existing props keep their behaviour.

- [ ] **Step 1: Write the failing test**

Create or extend `apps/mobile/src/components/__tests__/AuthScaffold.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { AuthScaffold } from "../AuthScaffold";

describe("AuthScaffold", () => {
  it("renders a header above the scroll when given one", () => {
    render(
      <AuthScaffold header={<Text testID="pinned">Target</Text>} footer={<Text>Go</Text>}>
        <Text>Body</Text>
      </AuthScaffold>,
    );
    expect(screen.getByTestId("pinned")).toBeTruthy();
  });

  // The pinned readout must not scroll away with the questions — that
  // adjacency is the point of the screen.
  it("keeps the header outside the scroll view", () => {
    render(
      <AuthScaffold header={<Text testID="pinned">Target</Text>} footer={<Text>Go</Text>}>
        <Text testID="body">Body</Text>
      </AuthScaffold>,
    );
    const scroll = screen.getByTestId("auth-scaffold-scroll");
    expect(within(scroll).queryByTestId("pinned")).toBeNull();
    expect(within(scroll).getByTestId("body")).toBeTruthy();
  });

  it("still renders without a header", () => {
    render(
      <AuthScaffold footer={<Text>Go</Text>}>
        <Text testID="body">Body</Text>
      </AuthScaffold>,
    );
    expect(screen.getByTestId("body")).toBeTruthy();
  });
});
```

Add `within` to the import from `@testing-library/react-native`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npx jest src/components/__tests__/AuthScaffold.test.tsx`
Expected: FAIL — no `auth-scaffold-scroll` testID and the header is not rendered.

- [ ] **Step 3: Implement**

In `apps/mobile/src/components/AuthScaffold.tsx`: add `header?: ReactNode;` to `Props`, destructure it, add `testID="auth-scaffold-scroll"` to the existing `ScrollView`, and render `{header ? <View>{header}</View> : null}` immediately before the ScrollView — after the existing back/progress header block, inside the same root `View`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/mobile && npx jest src/components/__tests__/AuthScaffold.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/AuthScaffold.tsx apps/mobile/src/components/__tests__/AuthScaffold.test.tsx
git commit -m "feat(auth): give AuthScaffold a pinned header slot outside the scroll"
```

---

### Task 10: The onboarding screen

The assembly task. Everything before it exists and is tested; this wires it together and deletes what it replaces.

**Files:**
- Rewrite: `apps/mobile/app/onboarding.tsx`
- Rewrite: `apps/mobile/app/__tests__/onboarding.test.tsx`

**Interfaces:**
- Consumes: `computePlan`, `availablePaces`, `weeksToGoal`, `ACTIVITY_FACTORS`, types from `@/lib/plan`; `validateOnboardingNumbers`, `validateGoalWeight` from `@/lib/validateOnboarding`; `TickRuler`, `PlanDial`, `PlanDelta`, `DerivationChain` from `@/components/instrument/*`; `AuthScaffold`'s `header` prop.
- Produces: the finished screen. No exports beyond the default.

- [ ] **Step 1: Write the failing test**

Replace `apps/mobile/app/__tests__/onboarding.test.tsx` entirely. Keep the existing mock block at the top of the old file verbatim (expo-router, `@/api/hooks`, `@/motion`, `@/units`, and the HealthKit mocks) — it is still correct — and replace the test bodies with:

```tsx
describe("onboarding", () => {
  it("shows no target until every required number is set", () => {
    render(<Onboarding />);
    expect(screen.getByTestId("plan-dial-awaiting")).toBeTruthy();
  });

  it("shows a target once age, height and weight are set", () => {
    render(<Onboarding />);
    fireEvent(screen.getByTestId("age-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    fireEvent(screen.getByTestId("height-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    fireEvent(screen.getByTestId("weight-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    expect(screen.queryByTestId("plan-dial-awaiting")).toBeNull();
    expect(screen.getByTestId("plan-dial-needle")).toBeTruthy();
  });

  // The destination has no meaning when maintaining — it disappears rather
  // than greying out, and the payload must omit it.
  it("hides the destination when the goal is Maintain", () => {
    render(<Onboarding />);
    const goal = screen.getByTestId("goal-ruler");
    fireEvent(goal, "accessibilityAction", { nativeEvent: { actionName: "increment" } });
    expect(screen.queryByTestId("goal-weight-ruler")).toBeNull();
    expect(screen.queryByTestId("pace-ruler")).toBeNull();
  });

  it("does not submit before the user accepts", () => {
    render(<Onboarding />);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("submits age as a birth year and includes the destination", () => {
    render(<Onboarding />);
    setValidBody(); // helper below
    fireEvent.press(screen.getByText("Start with this plan"));
    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sex: "male",
        goal: "fat_loss",
        activity_level: "moderate",
        goal_weight_kg: expect.any(Number),
        pace_kg_per_week: expect.any(Number),
        birth_year: expect.any(Number),
      }),
      expect.anything(),
    );
    expect(mockMutate.mock.calls[0][0]).not.toHaveProperty("age");
  });

  it("omits the destination from a maintenance payload", () => {
    render(<Onboarding />);
    setValidBody();
    fireEvent(screen.getByTestId("goal-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    fireEvent.press(screen.getByText("Start with this plan"));
    const payload = mockMutate.mock.calls[0][0];
    expect(payload.goal).toBe("maintenance");
    expect(payload.goal_weight_kg).toBeUndefined();
    expect(payload.pace_kg_per_week).toBeUndefined();
  });

  it("blocks a goal weight that contradicts the goal", () => {
    render(<Onboarding />);
    setValidBody();
    // Drive the goal-weight ruler above current weight while losing.
    for (let i = 0; i < 40; i++) {
      fireEvent(screen.getByTestId("goal-weight-ruler"), "accessibilityAction", {
        nativeEvent: { actionName: "increment" },
      });
    }
    fireEvent.press(screen.getByText("Start with this plan"));
    expect(mockMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/goal weight is above your current weight/)).toBeTruthy();
  });

  it("reports a submit failure without blaming the user's details", async () => {
    mockMutate.mockImplementation((_input, opts) =>
      opts.onError(new TypeError("Network request failed")),
    );
    render(<Onboarding />);
    setValidBody();
    fireEvent.press(screen.getByText("Start with this plan"));
    await waitFor(() => expect(screen.getByText(/connection|offline|try again/i)).toBeTruthy());
  });

  it("navigates home on success", async () => {
    mockMutate.mockImplementation((_input, opts) => opts.onSuccess());
    render(<Onboarding />);
    setValidBody();
    fireEvent.press(screen.getByText("Start with this plan"));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
  });
});
```

Write `setValidBody()` as a local helper in the test file that drives the age, height and weight rulers via `accessibilityAction` events until each holds a valid value — assert inside it that `plan-dial-awaiting` has disappeared, so a change to the rulers' defaults fails loudly here rather than silently skipping the later assertions.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npx jest app/__tests__/onboarding.test.tsx`
Expected: FAIL — no `goal-ruler` testID.

- [ ] **Step 3: Implement the screen**

Rewrite `apps/mobile/app/onboarding.tsx`. Requirements, all of which the tests above pin:

- Single screen. **Delete** the `step` state, both `return` branches, and the `BackHandler` effect entirely.
- State: `goalIndex`, `sex`, `activityIndex`, `age`, `heightCm`, `weightKg`, `goalWeightKg`, `paceIndex`, `touched` (a set of which of age/height/weight the user has actually set), `error`.
- `hasAllNumbers = touched.has("age") && touched.has("height") && touched.has("weight")`. Pass `kcal={hasAllNumbers ? plan.kcal : null}` to `PlanDial`.
- `plan = useMemo(() => computePlan({...}), [deps])`.
- `AuthScaffold header={...}` holds `PlanDial`, the kcal `Numeral`, and `PlanDelta`.
- Body order: Goal (`TickRuler` detented, testID `goal-ruler`, labels `["Lose weight","Maintain","Build muscle"]`) + caption; You (sex `Segmented`, then continuous rulers `age-ruler`, `height-ruler`, `weight-ruler`); Activity (`activity-ruler`, five labels) + caption; Destination (`goal-weight-ruler` + `pace-ruler`) + caption, rendered only when `goal !== "maintenance"`; `DerivationChain`; the macro trio; the medical-advice footnote.
- Pace stops come from `availablePaces(weightKg)`. When the weight ruler moves below the current pace's cap, clamp `paceIndex` to the last available stop — never leave it pointing past the end of the list.
- Imperial: when `useUnits().system === "imperial"`, the weight and goal-weight rulers run in **lb** (`min 80, max 400, step 1`) and the height ruler in **whole inches** (`min 55, max 84, step 1`) with `formatLabel={(inches) => `${Math.floor(inches / 12)}'${inches % 12}"`}`. Convert to metric with `kgFromLb` and `inches * CM_PER_IN` before validating or submitting. Metric users get kg and cm directly.
- Submit: run `validateOnboardingNumbers(String(age), String(heightCm), String(weightKg), unitOpts)` then `validateGoalWeight(goal, weightKg, goalWeightKg, weightUnitLabel(system))`; set `error` and return on either. Build the payload with `birth_year: new Date().getFullYear() - age`, and spread the destination fields **only** when `goal !== "maintenance"`. Keep the existing `onSuccess` (haptics + `router.replace("/")`) and `onError` (`apiErrorMessage`) handlers exactly as they are.
- Validation errors render under their own field; only the submit error renders beside the CTA.
- Captions: a `caption` string per goal index and per activity index, rendered under each detented ruler.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/mobile && npx jest app/__tests__/onboarding.test.tsx`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the whole mobile suite for regressions**

Run: `cd apps/mobile && npx jest`
Expected: PASS. Sign-in tests may fail if they assert on `AuthScaffold` internals — fix those assertions, not the scaffold.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/onboarding.tsx apps/mobile/app/__tests__/onboarding.test.tsx
git commit -m "feat(onboarding): rebuild as a live calibration panel with an explicit accept gate"
```

---

### Task 11: Instrument Glass migration for the shared pre-app components

Last, because it touches sign-in and is easiest to review once onboarding is settled.

**Files:**
- Modify: `apps/mobile/src/components/Field.tsx`
- Modify: `apps/mobile/src/components/Button.tsx`
- Modify: `apps/mobile/src/components/AuthScaffold.tsx`
- Test: existing tests for each, plus `apps/mobile/src/components/__tests__/Field.test.tsx`

**Interfaces:**
- Consumes: `useTheme().instrument`.
- Produces: no API changes. Presentation only.

- [ ] **Step 1: Write the failing test**

Add to `apps/mobile/src/components/__tests__/Field.test.tsx`:

```tsx
it("renders its label engraved and its input on an inset well", () => {
  render(<Field label="Weight" value="84" onChangeText={jest.fn()} testID="field" />);
  const label = screen.getByText("WEIGHT");
  expect(label.props.style).toEqual(
    expect.objectContaining({ textTransform: "uppercase" }),
  );
});
```

Adapt the assertion to `Field`'s actual style shape after reading the file — the behaviour under test is that the label renders uppercase and engraved, not any particular style-object nesting.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npx jest src/components/__tests__/Field.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Migrate**

- `Field`: label becomes engraved (9px, uppercase, letterSpacing 0.22em, `instrument.mut`); the input sits on `instrument.inset` with a `instrument.glassBorder` hairline and uses the mono face with `fontVariant: ["tabular-nums"]`.
- `Button` primary variant: background `instrument.accent`, foreground `instrument.accentOn`.
- `AuthScaffold`: root background `instrument.bg`; keep `AppBackground` as-is (it already paints the ambient pools).
- Replace any use of `Segmented` on these screens with the existing `SegmentedGlass`.
- Do **not** touch `SelectableCard` — onboarding no longer uses it and other screens still do.

- [ ] **Step 4: Run the whole suite**

Run: `cd apps/mobile && npx jest`
Expected: PASS.

- [ ] **Step 5: Verify on a simulator**

Run: `cd apps/mobile && npx expo run:ios --device "iPhone 17 Pro"`
Check: onboarding and sign-in both render on the dark ground with orange CTAs and no leftover system green. Drag each ruler and confirm the haptic fires once per detent, not per frame.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/components/Field.tsx apps/mobile/src/components/Button.tsx apps/mobile/src/components/AuthScaffold.tsx apps/mobile/src/components/__tests__/
git commit -m "refactor(auth): migrate the shared pre-app components onto Instrument Glass"
```

---

## Self-Review

**Spec coverage.** Screen structure → Task 10. Two new inputs → Tasks 1, 3, 4. Pace-driven deficit with floor and cap → Task 1. Age not birth year → Tasks 4, 10. Formula duplication and golden vectors → Tasks 1, 2. Validation → Task 4. `TickRuler` both modes → Tasks 5, 6. `PlanDial` → Task 7. `PlanDelta`, `DerivationChain` → Task 8. `AuthScaffold` header → Task 9. Instrument Glass migration → Task 11. Deletions (`step`, `BackHandler`, old test) → Task 10. Clamp announcement → Task 8 (`PlanDelta`) and Task 10 (destination caption). Error handling — inline field errors, offline copy, incomplete input → Tasks 4, 10, 7. Accessibility — adjustable role, hidden dial, polite delta → Tasks 5, 6, 7, 8.

**Gap found and closed:** the spec's pace cap would have offered un-pickable stops; `availablePaces` in Task 2 derives the stops from bodyweight so the UI cannot present one the server rejects.

**Gap found and closed:** the spec did not say what imperial users drag. Task 10 specifies lb and whole-inch rulers with a feet-and-inches label formatter, converting at the boundary.

**Not covered by design:** the Otto sheet, the ghost button's milestone-2 behaviour, and the "Adjust the numbers myself" steppers beyond the placeholder wiring in Task 10.
