package coach

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestNewPlanProposal_BuildsACardFromThePlannerDraft(t *testing.T) {
	draft := "```json\n" + `{"summary":"Hits 2000 kcal and 120g protein","days":[
		{"date":"Monday","meals":[{"name":"Oats and whey","description":"32g protein"}]},
		{"date":"Tuesday","meals":[{"name":"Chicken rice bowl","description":""}]}
	]}` + "\n```"

	envelope, ok := parsePlanEnvelope(draft)
	require.True(t, ok, "a fenced planner draft is still a planner draft")

	plan := newPlanProposal(uuid.New(), envelope, "Kora Meal Planner", "Kora Nutrition Coach")

	require.NotNil(t, plan)
	require.Equal(t, "Hits 2000 kcal and 120g protein", plan.Summary)
	require.Len(t, plan.Days, 2)
	require.Equal(t, "Monday", plan.Days[0].Date)
	require.Equal(t, "Oats and whey", plan.Days[0].Meals[0].Name)
	require.Equal(t, "32g protein", plan.Days[0].Meals[0].Description)
	require.Equal(t, "Kora Meal Planner", plan.AgentName)
	require.Equal(t, "Kora Nutrition Coach", plan.ReviewedBy)
}

// Prose is the common case — every non-planner answer, and any planner answer
// that ignored its contract. There is nothing to render as a card, and saying
// so is not a failure.
func TestNewPlanProposal_ProseIsNotACard(t *testing.T) {
	for _, draft := range []string{
		"Day 1: oats. Day 2: eggs.",
		`{"summary":"fits your targets","days":[]}`,
		`{"summary":"empty day","days":[{"date":"Monday","meals":[{"name":"  "}]}]}`,
		"",
	} {
		envelope, ok := parsePlanEnvelope(draft)
		if !ok {
			continue
		}
		require.Nil(t, newPlanProposal(uuid.New(), envelope, "planner", "coach"),
			"a draft with no nameable meals has nothing to approve: %q", draft)
	}
}

// The draft is model output, so its lengths and counts are bounds to enforce,
// not facts to trust: an overlong field must shorten the card rather than
// break the column check it is stored under.
func TestNewPlanProposal_BoundsTheDraftItWasGiven(t *testing.T) {
	envelope := planEnvelope{Summary: strings.Repeat("s", maxPlanSummary+50)}
	for day := 0; day < maxPlanDays+3; day++ {
		var meals []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		for meal := 0; meal < maxPlanMealsPerDay+2; meal++ {
			meals = append(meals, struct {
				Name        string `json:"name"`
				Description string `json:"description"`
			}{Name: strings.Repeat("n", maxPlanMealName+10), Description: strings.Repeat("d", maxPlanMealDetail+10)})
		}
		envelope.Days = append(envelope.Days, struct {
			Date  string `json:"date"`
			Meals []struct {
				Name        string `json:"name"`
				Description string `json:"description"`
			} `json:"meals"`
		}{Date: strings.Repeat("t", maxPlanDateChars+10), Meals: meals})
	}

	plan := newPlanProposal(uuid.New(), envelope, "", "")

	require.NotNil(t, plan)
	require.Len(t, plan.Days, maxPlanDays)
	require.Len(t, plan.Days[0].Meals, maxPlanMealsPerDay)
	require.Len(t, []rune(plan.Summary), maxPlanSummary)
	require.Len(t, []rune(plan.Days[0].Date), maxPlanDateChars)
	require.Len(t, []rune(plan.Days[0].Meals[0].Name), maxPlanMealName)
	require.Len(t, []rune(plan.Days[0].Meals[0].Description), maxPlanMealDetail)
	require.Equal(t, fallbackAgentName, plan.AgentName, "an unnamed author is still attributed")
	require.Equal(t, fallbackAgentName, plan.ReviewedBy)
}

// A draft this large is not a plan, and parsing it would be work done on
// behalf of whatever produced it.
func TestParsePlanEnvelope_RejectsAnOversizedDraft(t *testing.T) {
	huge := `{"summary":"` + strings.Repeat("x", maxPlanDraftBytes) + `","days":[{"date":"Monday","meals":[{"name":"Oats"}]}]}`

	_, ok := parsePlanEnvelope(huge)

	require.False(t, ok)
}
