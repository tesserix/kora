package ingest

import (
	"context"
	"fmt"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// Run loads each file (path→provenance) and inserts all items, returning the
// total inserted (existing rows are skipped by the repository dedup).
func Run(ctx context.Context, repo nutrition.Repository, files map[string]string) (int, error) {
	total := 0
	for path, provenance := range files {
		items, err := LoadFile(path, provenance)
		if err != nil {
			return total, err
		}
		n, err := repo.Insert(ctx, items)
		if err != nil {
			return total, fmt.Errorf("ingest: insert %s: %w", path, err)
		}
		total += n
	}
	return total, nil
}
