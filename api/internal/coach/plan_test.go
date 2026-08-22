package coach

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestParseReviewedCommitmentReturnsOnlyAValidatedUserReviewProposal(t *testing.T) {
	loc, err := time.LoadLocation("Australia/Melbourne")
	require.NoError(t, err)
	review := `A two-hour water rhythm fits your request. Confirm it before Kora schedules anything.
[[KORA_COMMITMENT]]
{"title":"Drink a glass of water","kind":"hydration","cadence":"interval","weekdays_mask":127,"start_minute":480,"interval_minutes":120,"end_minute":1200}
[[/KORA_COMMITMENT]]`

	clean, proposal := parseReviewedCommitment(
		review,
		uuid.New(),
		time.Date(2026, 8, 22, 1, 0, 0, 0, time.UTC),
		loc,
		"Kora Meal Planner",
		"Kora Nutrition Coach",
	)

	require.Equal(t, "A two-hour water rhythm fits your request. Confirm it before Kora schedules anything.", clean)
	require.NotNil(t, proposal)
	require.Equal(t, "Drink a glass of water", proposal.Title)
	require.Equal(t, 120, *proposal.IntervalMinutes)
	require.Equal(t, "Australia/Melbourne", proposal.Timezone)
	require.Equal(t, "2026-08-22", proposal.StartsOn.Format("2006-01-02"))
	require.Equal(t, "Kora Meal Planner", proposal.AgentName)
	require.Equal(t, "Kora Nutrition Coach", proposal.ReviewedBy)
}

func TestParseReviewedCommitmentStripsAnInvalidAgentPayload(t *testing.T) {
	review := `Keep this as a suggestion only.
[[KORA_COMMITMENT]]
{"title":"Drink constantly","kind":"hydration","cadence":"interval","weekdays_mask":127,"start_minute":480,"interval_minutes":1,"end_minute":1200}
[[/KORA_COMMITMENT]]`

	clean, proposal := parseReviewedCommitment(review, uuid.New(), time.Now(), time.UTC, "Planner", "Coach")

	require.Equal(t, "Keep this as a suggestion only.", clean)
	require.Nil(t, proposal)
}

func TestParseReviewedCommitmentRequiresReviewerAttribution(t *testing.T) {
	review := `Review this first.
[[KORA_COMMITMENT]]
{"title":"Walk","kind":"walking","cadence":"fixed","weekdays_mask":127,"start_minute":600,"interval_minutes":null,"end_minute":null}
[[/KORA_COMMITMENT]]`

	clean, proposal := parseReviewedCommitment(review, uuid.New(), time.Now(), time.UTC, "Planner", "")

	require.Equal(t, "Review this first.", clean)
	require.Nil(t, proposal)
}

func TestParseReviewedPlanReturnsOnlyTheReviewersFinalStructure(t *testing.T) {
	review := `I replaced the unsupported meal. Approve this version.
[[KORA_REVIEWED_PLAN]]
{"summary":"Reviewed plan","days":[{"date":"Monday","meals":[{"name":"Lentil bowl","description":"Reviewed option","preparation":"Simmer lentils, then fold through roasted vegetables."}]}]}
[[/KORA_REVIEWED_PLAN]]`

	clean, envelope, ok := parseReviewedPlan(review)

	require.True(t, ok)
	require.Equal(t, "I replaced the unsupported meal. Approve this version.", clean)
	require.Equal(t, "Reviewed plan", envelope.Summary)
	require.Equal(t, "Lentil bowl", envelope.Days[0].Meals[0].Name)
	require.Equal(t, "Simmer lentils, then fold through roasted vegetables.", envelope.Days[0].Meals[0].Preparation)
}

func TestParseReviewedPlanRejectsAMealWithoutPreparationGuidance(t *testing.T) {
	review := `This plan is ready.
[[KORA_REVIEWED_PLAN]]
{"summary":"Incomplete plan","days":[{"date":"Any day label","meals":[{"name":"Lentil bowl","description":"Reviewed option"}]}]}
[[/KORA_REVIEWED_PLAN]]`

	clean, _, ok := parseReviewedPlan(review)

	require.False(t, ok)
	require.Equal(t, "This plan is ready.", clean)
}

func TestParseReviewedPlanRejectsStructuresOutsideTheApprovalContract(t *testing.T) {
	validMeal := planEnvelopeMeal{Name: "Lentil bowl", Preparation: "Simmer lentils until tender."}
	validDay := planEnvelopeDay{Date: "Any day label", Meals: []planEnvelopeMeal{validMeal}}
	tooManyDays := make([]planEnvelopeDay, maxPlanDays+1)
	for i := range tooManyDays {
		tooManyDays[i] = validDay
	}
	tooManyMeals := make([]planEnvelopeMeal, maxPlanMealsPerDay+1)
	for i := range tooManyMeals {
		tooManyMeals[i] = validMeal
	}

	tests := map[string]planEnvelope{
		"blank day label": {Days: []planEnvelopeDay{{Date: "  ", Meals: []planEnvelopeMeal{validMeal}}}},
		"too many days":   {Days: tooManyDays},
		"too many meals":  {Days: []planEnvelopeDay{{Date: "Day", Meals: tooManyMeals}}},
	}
	for name, plan := range tests {
		t.Run(name, func(t *testing.T) {
			payload, err := json.Marshal(plan)
			require.NoError(t, err)
			review := "Review complete.\n" + reviewedPlanStart + "\n" + string(payload) + "\n" + reviewedPlanEnd

			clean, _, ok := parseReviewedPlan(review)

			require.False(t, ok)
			require.Equal(t, "Review complete.", clean)
		})
	}
}

func TestParseReviewedPlanStripsAnInvalidMachineBlock(t *testing.T) {
	review := `I could not validate a complete plan.
[[KORA_REVIEWED_PLAN]]
{"summary":"No days","days":[]}
[[/KORA_REVIEWED_PLAN]]`

	clean, _, ok := parseReviewedPlan(review)

	require.False(t, ok)
	require.Equal(t, "I could not validate a complete plan.", clean)
}

func TestReviewPromptSupportsTwoMonthPlansWithoutDuplicatingEveryDayInProse(t *testing.T) {
	require.Contains(t, reviewSystemPrompt, "1-62 days")
	require.Contains(t, reviewSystemPrompt, "For plans longer than 14 days")
	require.Contains(t, reviewSystemPrompt, "complete FINAL plan")
}

func TestFormatPlanDraftRendersTheEnvelopeAsReadableText(t *testing.T) {
	draft := `{"summary":"High-protein dinners.","days":[{"date":"Day 1","meals":[{"name":"Dinner: Steak","description":"180g sirloin."},{"name":"Lunch: Wrap","description":"150g tuna."}]}]}`

	got := formatPlanDraft(draft)

	want := "High-protein dinners.\n\nDay 1\n- Dinner: Steak — 180g sirloin.\n- Lunch: Wrap — 150g tuna."
	require.Equal(t, want, got)
}

func TestFormatPlanDraftToleratesAFencedEnvelope(t *testing.T) {
	draft := "```json\n{\"summary\":\"Two days.\",\"days\":[{\"date\":\"Day 1\",\"meals\":[{\"name\":\"Eggs\"}]}]}\n```"

	require.Equal(t, "Two days.\n\nDay 1\n- Eggs", formatPlanDraft(draft))
}

func TestFormatPlanDraftLeavesProseUntouched(t *testing.T) {
	prose := "Here is your plan for tomorrow."

	require.Equal(t, prose, formatPlanDraft(prose))
}

func TestFormatPlanDraftKeepsTheDraftWhenTheEnvelopeHasNoDays(t *testing.T) {
	draft := `{"summary":"nothing planned"}`

	require.Equal(t, draft, formatPlanDraft(draft))
}
