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
		// Reconcile locale on rows that already existed. Insert skips those, so
		// without this a source that starts stating a locale (kora#212 Phase 4)
		// would only ever label rows ingested AFTER the change. Writes only over
		// an empty locale, so it is idempotent and cannot overwrite a derived
		// or deliberate value.
		if _, err := repo.BackfillLocales(ctx, items); err != nil {
			return total, fmt.Errorf("ingest: backfill locales %s: %w", path, err)
		}
		// Same reconciliation, for serving data. The sorted-path rule above
		// means afcd_release3.json claims every name it shares with
		// ausnut.json, and AFCD states no servings while AUSNUT ships 9,816
		// measures — so 315 foods would keep an empty serving and discard a
		// measured one. Writes only where the row has neither a mass nor named
		// units, so it is idempotent and never overrides an owning source.
		if _, err := repo.BackfillServings(ctx, items); err != nil {
			return total, fmt.Errorf("ingest: backfill servings %s: %w", path, err)
		}
	}
	return total, nil
}
