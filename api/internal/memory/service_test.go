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

// TestUsualMealsDeterministicOrderOnExactTie proves that when two distinct usual
// meals tie on every ranking key (Count, LastLoggedAt, Name), the final ID
// tie-break makes ordering deterministic instead of leaking Go's randomized
// map-iteration order. Without the ID tie-break in usualMeals' sort.Slice,
// this test would be flaky (order would vary run to run).
func TestUsualMealsDeterministicOrderOnExactTie(t *testing.T) {
	loc := time.UTC
	mk := func(day int) time.Time { return time.Date(2026, 7, day, 8, 0, 0, 0, time.UTC) }
	var logs []foodlog.FoodLog
	// Same two foods (eggs+oats), same 3 days, same time-of-day, but two
	// different meal slots → two distinct usual-meal fingerprints that tie on
	// Count (3), LastLoggedAt (day-3 08:00), and Name ("Oats & Eggs"), and
	// differ only in slot (which folds into the fingerprint-derived ID).
	for _, d := range []int{1, 2, 3} {
		logs = append(logs,
			log(eggs, "Eggs", "breakfast", 100, 155, mk(d)),
			log(oats, "Oats", "breakfast", 60, 230, mk(d)),
			log(eggs, "Eggs", "lunch", 100, 155, mk(d)),
			log(oats, "Oats", "lunch", 60, 230, mk(d)),
		)
	}

	breakfastFP := "breakfast:" + eggs + "," + oats
	lunchFP := "lunch:" + eggs + "," + oats
	breakfastID := hashFingerprint(breakfastFP)
	lunchID := hashFingerprint(lunchFP)
	if breakfastID == lunchID {
		t.Fatalf("test setup invalid: fingerprints collide")
	}
	wantFirstID, wantSecondID := breakfastID, lunchID
	if lunchID < breakfastID {
		wantFirstID, wantSecondID = lunchID, breakfastID
	}

	got := usualMeals(logs, loc)
	if len(got) != 2 {
		t.Fatalf("want 2 tied usual meals, got %d", len(got))
	}
	if got[0].Count != 3 || got[1].Count != 3 {
		t.Fatalf("want both counts 3, got %d and %d", got[0].Count, got[1].Count)
	}
	if !got[0].LastLoggedAt.Equal(got[1].LastLoggedAt) {
		t.Fatalf("want tied LastLoggedAt, got %v and %v", got[0].LastLoggedAt, got[1].LastLoggedAt)
	}
	if got[0].Name != got[1].Name {
		t.Fatalf("want tied Name, got %q and %q", got[0].Name, got[1].Name)
	}
	if got[0].ID != wantFirstID || got[1].ID != wantSecondID {
		t.Fatalf("want ID-ordered [%s, %s], got [%s, %s]", wantFirstID, wantSecondID, got[0].ID, got[1].ID)
	}

	// Re-run to guard against map-iteration nondeterminism leaking through.
	got2 := usualMeals(logs, loc)
	if len(got2) != 2 || got2[0].ID != got[0].ID || got2[1].ID != got[1].ID {
		t.Fatalf("non-deterministic ordering across repeated calls: run1=[%s,%s] run2=[%s,%s]",
			got[0].ID, got[1].ID, got2[0].ID, got2[1].ID)
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
