package aieval

import (
	"strings"
	"testing"
)

const seedLines = `{"phrase": "Coke Zero", "guesses": [{"food": "coke zero"}], "expected_name": "Coke Zero", "note": "kora#1"}

{"phrase": "El Janah chicken", "expected_name": "", "note": "judgement call"}
{"phrase": "two eggs", "expected_food_item_id": "6f1c0e1e-0000-4000-8000-000000000001", "expected_kcal": 155, "kcal_tolerance": 0.2}
`

func TestSeedItemsKeepsOnlyLabelledCases(t *testing.T) {
	items, err := SeedItems("kora-capture-text", strings.NewReader(seedLines))
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("got %d items, want the 2 labelled ones", len(items))
	}
	if items[0].Input.Phrase != "Coke Zero" || items[0].Expected.Name != "Coke Zero" || items[0].Note != "kora#1" {
		t.Fatalf("got %+v", items[0])
	}
	want := Expected{FoodItemID: "6f1c0e1e-0000-4000-8000-000000000001", Kcal: 155, KcalTolerance: 0.2}
	if items[1].Expected != want {
		t.Fatalf("got %+v", items[1].Expected)
	}
}

func TestSeedItemIDsAreStablePerDatasetAndPhrase(t *testing.T) {
	a, _ := SeedItems("kora-capture-text", strings.NewReader(`{"phrase": "Coke Zero", "expected_name": "Coke"}`))
	b, _ := SeedItems("kora-capture-text", strings.NewReader(`{"phrase": "coke zero ", "expected_name": "Coke Zero"}`))
	c, _ := SeedItems("kora-capture-voice", strings.NewReader(`{"phrase": "Coke Zero", "expected_name": "Coke"}`))
	if a[0].ID != b[0].ID {
		t.Fatal("reseeding the same phrase must update the same item")
	}
	if a[0].ID == c[0].ID {
		t.Fatal("datasets must not share item ids")
	}
}

func TestSeedItemsRejectsMalformedLines(t *testing.T) {
	if _, err := SeedItems("kora-capture-text", strings.NewReader("{not json")); err == nil || !strings.Contains(err.Error(), "line 1") {
		t.Fatalf("got %v", err)
	}
}
