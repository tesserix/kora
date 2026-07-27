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
