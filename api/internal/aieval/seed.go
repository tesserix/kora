package aieval

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/google/uuid"
)

// seedLine is the ranking-eval JSONL shape, so testdata/eval files seed datasets as they are.
type seedLine struct {
	Phrase        string  `json:"phrase"`
	Name          string  `json:"expected_name"`
	FoodItemID    string  `json:"expected_food_item_id"`
	Kcal          float64 `json:"expected_kcal"`
	KcalTolerance float64 `json:"kcal_tolerance"`
	Note          string  `json:"note"`
}

// SeedItems reads labelled cases; a line with no expected food is a judgement call and is skipped.
func SeedItems(dataset string, r io.Reader) ([]Item, error) {
	var items []Item
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var s seedLine
		if err := json.Unmarshal([]byte(line), &s); err != nil {
			return nil, fmt.Errorf("line %d: %w", n, err)
		}
		if s.Name == "" && s.FoodItemID == "" {
			continue
		}
		phrase := strings.TrimSpace(s.Phrase)
		items = append(items, Item{
			ID:    uuid.NewSHA1(uuid.NameSpaceURL, []byte(dataset+"\x00"+strings.ToLower(phrase))).String(),
			Input: Input{Phrase: phrase},
			Expected: Expected{
				FoodItemID: s.FoodItemID, Name: s.Name, Kcal: s.Kcal, KcalTolerance: s.KcalTolerance,
			},
			Note: s.Note,
		})
	}
	return items, sc.Err()
}
