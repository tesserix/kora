package agents

import "strings"

// Name is a reviewed Kora agent exposed through AgentGateway.
type Name string

const (
	NutritionCoach Name = "nutrition-coach"
	MealPlanner    Name = "meal-planner"
)

// SelectForQuestion keeps supervisor routing deterministic and reviewable.
func SelectForQuestion(question string) Name {
	normalized := strings.ToLower(strings.Join(strings.Fields(question), " "))
	mealPlanningPhrases := []string{
		"meal plan",
		"plan meals",
		"plan my meals",
		"weekly menu",
		"plan my menu",
	}
	for _, phrase := range mealPlanningPhrases {
		if strings.Contains(normalized, phrase) {
			return MealPlanner
		}
	}
	return NutritionCoach
}

func (n Name) reviewed() bool {
	return n == NutritionCoach || n == MealPlanner
}
