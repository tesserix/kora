package recipes

import (
	"strings"

	"github.com/google/uuid"
)

const (
	// maxSteps bounds a method. Beyond this it is not a recipe.
	maxSteps = 40
	// maxStepLen bounds one instruction. Over-length is TRUNCATED, not
	// rejected — a long step is prose, not an attack, and losing the user's
	// whole save over it would be hostile.
	maxStepLen = 500
)

// Step is one instruction in a recipe's method. The table keys on
// (recipe_id, position) because order IS the meaning: unlike tags, two
// identical instructions at different points are both legitimate, so the text
// cannot be part of the key.
type Step struct {
	RecipeID uuid.UUID `gorm:"type:uuid;not null;primaryKey"`
	Position int       `gorm:"not null;primaryKey"`
	Text     string    `gorm:"not null"`
}

func (Step) TableName() string { return "recipe_steps" }

// normalizeSteps trims each instruction, drops the ones that are empty
// afterwards, truncates over-length ones, and caps the list. Order is
// preserved and duplicates are kept — both are meaningful in a method.
//
// Positions are NOT assigned here: the repository rewrites them from slice
// order on write, the same rule insertIngredients already follows, so a caller
// can never desynchronise them.
func normalizeSteps(raw []string) []string {
	out := make([]string, 0, len(raw))
	for _, r := range raw {
		s := strings.TrimSpace(r)
		if s == "" {
			continue
		}
		if len(s) > maxStepLen {
			s = strings.TrimSpace(s[:maxStepLen])
		}
		if s == "" {
			continue
		}
		out = append(out, s)
		if len(out) == maxSteps {
			break
		}
	}
	return out
}
