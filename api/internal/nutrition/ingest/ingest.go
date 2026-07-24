package ingest

import (
	"context"
	"fmt"
	"sort"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// Run loads each file (path→provenance) and inserts all items, returning the
// total inserted (existing rows are skipped by the repository dedup). Files
// are processed in sorted path order so that ingestion is deterministic when
// the same food (by name+brand) appears in more than one file — the
// alphabetically-first file wins any overlap.
func Run(ctx context.Context, repo nutrition.Repository, files map[string]string) (int, error) {
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	total := 0
	for _, path := range paths {
		provenance := files[path]
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
