package memory

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tesserix/kora/api/internal/foodlog"
)

func fid(s string) *uuid.UUID { u := uuid.MustParse(s); return &u }

func log(itemID, name, slot string, grams, kcal float64, at time.Time) foodlog.FoodLog {
	return foodlog.FoodLog{FoodItemID: fid(itemID), Description: name, MealSlot: slot, QuantityGrams: grams, Kcal: kcal, LoggedAt: at}
}

const eggs = "11111111-1111-1111-1111-111111111111"
const oats = "22222222-2222-2222-2222-222222222222"

func TestRecentsMostRecentDistinctFoods(t *testing.T) {
	base := time.Date(2026, 7, 1, 8, 0, 0, 0, time.UTC)
	logs := []foodlog.FoodLog{
		log(eggs, "Eggs", "breakfast", 100, 155, base),
		log(oats, "Oats", "breakfast", 60, 230, base.Add(24*time.Hour)),
		log(eggs, "Eggs", "breakfast", 120, 186, base.Add(48*time.Hour)), // newer eggs
	}
	got := recents(logs)
	if len(got) != 2 {
		t.Fatalf("want 2 distinct, got %d", len(got))
	}
	if got[0].FoodItemID != eggs {
		t.Fatalf("most-recent should be eggs, got %s", got[0].FoodItemID)
	}
	if got[0].Grams != 120 {
		t.Fatalf("recents portion should be the most-recent (120), got %v", got[0].Grams)
	}
}

func TestFrequentGatesAndRanksByCountThenRecency(t *testing.T) {
	base := time.Date(2026, 7, 1, 8, 0, 0, 0, time.UTC)
	logs := []foodlog.FoodLog{
		log(eggs, "Eggs", "breakfast", 100, 155, base),
		log(eggs, "Eggs", "breakfast", 100, 155, base.Add(24*time.Hour)),
		log(eggs, "Eggs", "breakfast", 120, 186, base.Add(48*time.Hour)),
		log(oats, "Oats", "breakfast", 60, 230, base.Add(72*time.Hour)), // count 1 → excluded (min 2)
	}
	got := frequent(logs)
	if len(got) != 1 {
		t.Fatalf("want only eggs (count>=2), got %d", len(got))
	}
	if got[0].Count != 3 {
		t.Fatalf("eggs count want 3 got %d", got[0].Count)
	}
	if got[0].Grams != 100 {
		t.Fatalf("frequent portion should be the mode (100), got %v", got[0].Grams)
	}
}

func TestUsualMealsRequiresRecurringMultiFoodSet(t *testing.T) {
	loc := time.UTC
	mk := func(day int, hm int) time.Time { return time.Date(2026, 7, day, hm, 0, 0, 0, time.UTC) }
	var logs []foodlog.FoodLog
	// eggs+oats breakfast on 3 distinct days → usual meal
	for _, d := range []int{1, 2, 3} {
		logs = append(logs,
			log(eggs, "Eggs", "breakfast", 100, 155, mk(d, 8)),
			log(oats, "Oats", "breakfast", 60, 230, mk(d, 8)),
		)
	}
	// a single-food breakfast on 3 days → NOT a usual meal (belongs in Frequent)
	for _, d := range []int{5, 6, 7} {
		logs = append(logs, log(eggs, "Eggs", "breakfast", 100, 155, mk(d, 8)))
	}
	got := usualMeals(logs, loc)
	if len(got) != 1 {
		t.Fatalf("want exactly one usual meal, got %d", len(got))
	}
	if got[0].Count != 3 {
		t.Fatalf("want count 3, got %d", got[0].Count)
	}
	if len(got[0].Items) != 2 {
		t.Fatalf("want 2 component foods, got %d", len(got[0].Items))
	}
	if got[0].Kcal != 385 {
		t.Fatalf("want summed kcal 385, got %v", got[0].Kcal)
	}
}

func TestUsualMealsBelowThresholdExcluded(t *testing.T) {
	loc := time.UTC
	mk := func(day int) time.Time { return time.Date(2026, 7, day, 8, 0, 0, 0, time.UTC) }
	var logs []foodlog.FoodLog
	for _, d := range []int{1, 2} { // only 2 days < 3
		logs = append(logs, log(eggs, "Eggs", "breakfast", 100, 155, mk(d)), log(oats, "Oats", "breakfast", 60, 230, mk(d)))
	}
	if got := usualMeals(logs, loc); len(got) != 0 {
		t.Fatalf("want 0 usual meals below threshold, got %d", len(got))
	}
}
