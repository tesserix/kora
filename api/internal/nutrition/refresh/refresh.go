package refresh

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// Run is one recorded refresh pass. The table doubles as the schedule: the
// next pass is due when the newest successful row is older than the cadence,
// which survives pod restarts and needs no clock state in the process.
type Run struct {
	ID         uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	StartedAt  time.Time
	FinishedAt *time.Time
	Since      time.Time
	FilesRead  int
	Seen       int
	Inserted   int
	Updated    int
	Error      string
}

func (Run) TableName() string { return "food_refresh_runs" }

// lockKey serialises refresh across replicas via a Postgres advisory lock.
// Arbitrary but stable; must not collide with another advisory user in this
// database (there are none today).
const lockKey int64 = 727_331_140_01

// overlap is re-read behind every since cutoff, so a run that raced a delta
// publish cannot leave a permanent hole; UpsertBarcoded makes the re-read a
// no-op.
const overlap = 24 * time.Hour

// Runner fires a refresh whenever the last successful one is older than
// Every. Check is how often that condition is polled, not how often work
// happens — an hourly check of an indexed one-row query costs nothing and
// keeps a restarted pod from waiting a week.
type Runner struct {
	DB        *gorm.DB
	Repo      nutrition.Repository
	Client    Client
	Countries []Country
	Every     time.Duration
	Check     time.Duration
	Log       *slog.Logger
}

func (r Runner) Run(ctx context.Context) {
	ticker := time.NewTicker(r.Check)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := r.Tick(ctx, time.Now()); err != nil {
				r.Log.WarnContext(ctx, "food refresh failed", "err", err)
			}
		}
	}
}

// Tick refreshes if a pass is due, and is safe to call from every replica:
// the advisory lock admits one runner, and the due-check is repeated inside
// the lock so the losers of the race see the winner's row and stand down.
func (r Runner) Tick(ctx context.Context, now time.Time) error {
	due, _, err := r.due(ctx, now)
	if err != nil || !due {
		return err
	}
	// Connection pins one session for the advisory lock; pool routing would
	// otherwise unlock on a different connection than it locked.
	return r.DB.WithContext(ctx).Connection(func(conn *gorm.DB) error {
		var got bool
		if err := conn.Raw("SELECT pg_try_advisory_lock(?)", lockKey).Scan(&got).Error; err != nil {
			return fmt.Errorf("refresh: lock: %w", err)
		}
		if !got {
			return nil // another replica is running this week's pass
		}
		defer conn.Exec("SELECT pg_advisory_unlock(?)", lockKey)
		due, since, err := r.due(ctx, now)
		if err != nil || !due {
			return err
		}
		return r.refresh(ctx, now, since)
	})
}

// due reports whether a pass should start, and the cutoff it should read
// deltas from.
func (r Runner) due(ctx context.Context, now time.Time) (bool, time.Time, error) {
	var last []Run
	err := r.DB.WithContext(ctx).
		Where("finished_at IS NOT NULL AND error = ''").
		Order("started_at DESC").Limit(1).Find(&last).Error
	if err != nil {
		return false, time.Time{}, fmt.Errorf("refresh: last run: %w", err)
	}
	if len(last) == 0 {
		// First ever pass reads one cadence back, so a fresh deploy starts
		// with the same window a steady-state week covers.
		return true, now.Add(-r.Every - overlap), nil
	}
	if now.Sub(last[0].StartedAt) < r.Every {
		return false, time.Time{}, nil
	}
	return true, last[0].StartedAt.Add(-overlap), nil
}

// refresh performs the pass and records it. A failed pass is recorded with
// its error and does NOT advance the schedule (due only counts error=” rows),
// so the next tick retries rather than skipping a week.
func (r Runner) refresh(ctx context.Context, now, since time.Time) error {
	rec := Run{StartedAt: now, Since: since}
	files, err := r.Client.deltaFiles(ctx, since)
	if err != nil {
		return r.record(ctx, rec, err)
	}
	// Last write per barcode wins across files: delta windows are
	// chronological and later files re-state changed products.
	latest := map[string]nutrition.FoodItem{}
	order := []string{}
	for _, f := range files {
		items, err := r.Client.collect(ctx, f, r.Countries)
		if err != nil {
			return r.record(ctx, rec, err)
		}
		rec.FilesRead++
		for _, item := range items {
			if _, seen := latest[*item.Barcode]; !seen {
				order = append(order, *item.Barcode)
			}
			latest[*item.Barcode] = item
		}
	}
	batch := make([]nutrition.FoodItem, 0, len(order))
	for _, code := range order {
		batch = append(batch, latest[code])
	}
	rec.Seen = len(batch)
	rec.Inserted, rec.Updated, err = r.Repo.UpsertBarcoded(ctx, batch)
	return r.record(ctx, rec, err)
}

func (r Runner) record(ctx context.Context, rec Run, runErr error) error {
	finished := time.Now()
	rec.FinishedAt = &finished
	if runErr != nil {
		rec.Error = runErr.Error()
	}
	if err := r.DB.WithContext(ctx).Create(&rec).Error; err != nil {
		return fmt.Errorf("refresh: record run: %w (run error: %v)", err, runErr)
	}
	if runErr != nil {
		return runErr
	}
	r.Log.InfoContext(ctx, "food refresh complete",
		"files", rec.FilesRead, "seen", rec.Seen,
		"inserted", rec.Inserted, "updated", rec.Updated,
		"since", rec.Since.Format(time.RFC3339))
	return nil
}
