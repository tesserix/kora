// Package accuracy turns what a user does with an AI answer into Langfuse
// scores on that answer's trace, so accuracy is measured from real confirmations.
package accuracy

import (
	"fmt"
	"strconv"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/resolveoutcome"
)

const (
	ScoreTop1Correct = "capture.top1_correct"
	ScoreTierCorrect = "capture.tier_correct"
)

const dataBoolean = "BOOLEAN"

// Score is one Langfuse score; ID is stable so a later correction overwrites it.
type Score struct {
	ID       string
	TraceID  string
	Name     string
	Value    float64
	DataType string
	Comment  string
	Metadata map[string]string
}

// CaptureScores grades one logged item against the food the resolver offered in that slot.
// Candidates are the items on one plate, so each is scored on its own.
func CaptureScores(o resolveoutcome.Outcome, index int, food uuid.UUID, corrected bool) []Score {
	candidates := o.Candidates()
	if o.TraceID == nil || index < 0 || index >= len(candidates) {
		return nil
	}
	kept := candidates[index] == food
	comment := ""
	if corrected {
		comment = "corrected"
	}
	metadata := map[string]string{
		"food_item_id": food.String(), "item_index": strconv.Itoa(index),
		"mode": string(o.Mode), "tier": o.Tier,
	}
	score := func(name string, value float64) Score {
		return Score{
			ID: fmt.Sprintf("%s-%d-%s", o.ID, index, name), TraceID: *o.TraceID, Name: name,
			Value: value, DataType: dataBoolean, Comment: comment, Metadata: metadata,
		}
	}

	scores := []Score{score(ScoreTop1Correct, boolValue(kept))}
	if o.Tier == "auto" {
		scores = append(scores, score(ScoreTierCorrect, boolValue(kept)))
	}
	return scores
}

func boolValue(ok bool) float64 {
	if ok {
		return 1
	}
	return 0
}
