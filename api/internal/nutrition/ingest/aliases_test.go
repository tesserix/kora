package ingest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// curatedAlias mirrors the shape cmd/ingest unmarshals aliases.json into.
type curatedAlias struct {
	Alias string `json:"alias"`
	Food  string `json:"food"`
	Why   string `json:"why"`
}

func loadAliases(t *testing.T) []curatedAlias {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "data", "food", AliasFile))
	if err != nil {
		t.Fatalf("read %s: %v", AliasFile, err)
	}
	var out []curatedAlias
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("parse %s: %v", AliasFile, err)
	}
	if len(out) == 0 {
		t.Fatalf("%s is empty", AliasFile)
	}
	return out
}

// TestCuratedAliasFileIsWellFormed guards the curated alias set.
//
// A global alias resolves at score 1.0 — the AUTO-LOG tier — so a wrong entry
// logs the wrong food without asking. cmd/ingest only WARNS about an alias it
// cannot resolve, which means a typo in a food name ships silently and the
// alias simply never works. These checks are the cheap half (shape and
// self-consistency); resolvability against the real index is the loud warning
// cmd/ingest prints on every run.
func TestCuratedAliasFileIsWellFormed(t *testing.T) {
	aliases := loadAliases(t)
	seen := map[string]string{}

	for _, a := range aliases {
		alias := strings.ToLower(strings.TrimSpace(a.Alias))
		switch {
		case alias == "":
			t.Errorf("entry with food %q has an empty alias", a.Food)
		case strings.TrimSpace(a.Food) == "":
			t.Errorf("alias %q names no food", a.Alias)
		case strings.TrimSpace(a.Why) == "":
			// The file is hand-audited by design; an entry with no stated
			// reason cannot be audited by the next person.
			t.Errorf("alias %q has no `why` — every curated alias must say why it is safe", a.Alias)
		}

		// A duplicate would be silently collapsed by the partial unique index
		// idx_food_aliases_global_unique, so the LAST one in the file would win
		// and the earlier entry would look applied while doing nothing.
		if prev, dup := seen[alias]; dup {
			t.Errorf("alias %q is listed twice (-> %q and %q); the unique index keeps only one", alias, prev, a.Food)
		}
		seen[alias] = a.Food

		// An alias equal to its own target adds nothing: the name already
		// matches lexically, and it spends an auto-tier slot for no gain.
		if strings.EqualFold(alias, strings.TrimSpace(a.Food)) {
			t.Errorf("alias %q is identical to its target food; it cannot add reach", a.Alias)
		}
	}
}
