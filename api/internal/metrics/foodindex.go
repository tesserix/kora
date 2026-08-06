package metrics

import (
	"context"
	"log/slog"
	"time"

	"gorm.io/gorm"
)

// foodIndexQuery reads both counts in ONE pass. Two separate queries could
// straddle a concurrent embed and report an embedded count that exceeds the
// total, which is not a state the database is ever actually in.
const foodIndexQuery = `SELECT count(*) AS total,
       count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded
FROM food_items
WHERE deleted_at IS NULL`

// FoodIndexRefresher publishes food-index completeness gauges from the
// database on a timer. This answers a question about database STATE rather
// than about events this process observed, which is why it needs a poller at
// all — every other metric in this package is incremented at the seam where
// the thing happens.
type FoodIndexRefresher struct {
	db       *gorm.DB
	c        *Collectors
	interval time.Duration
	logger   *slog.Logger
}

// NewFoodIndexRefresher wires a refresher. It deliberately takes *Collectors
// rather than using the package default so tests get an isolated registry.
func NewFoodIndexRefresher(db *gorm.DB, c *Collectors, interval time.Duration, logger *slog.Logger) *FoodIndexRefresher {
	return &FoodIndexRefresher{db: db, c: c, interval: interval, logger: logger}
}

// RefreshOnce runs the query and publishes the gauges. On a query failure it
// returns the error WITHOUT touching the gauges: the last good reading stands.
// Zeroing them instead would be indistinguishable from a genuinely empty food
// index, which is a real and alarming state (#97) that must not be faked by an
// unrelated database blip.
func (r *FoodIndexRefresher) RefreshOnce(ctx context.Context) error {
	var row struct {
		Total    int64
		Embedded int64
	}
	if err := r.db.WithContext(ctx).Raw(foodIndexQuery).Scan(&row).Error; err != nil {
		return err
	}
	r.c.SetFoodIndex(row.Total, row.Embedded)
	return nil
}

// Run refreshes immediately, then on every tick, until ctx is done. It never
// returns an error and never panics the process: losing observability must not
// take down the product, the same rule cmd/api/main.go already applies to the
// metrics listener.
func (r *FoodIndexRefresher) Run(ctx context.Context) {
	r.refreshLogging(ctx)

	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.refreshLogging(ctx)
		}
	}
}

func (r *FoodIndexRefresher) refreshLogging(ctx context.Context) {
	if err := r.RefreshOnce(ctx); err != nil {
		r.logger.Error("food index gauge refresh failed", "err", err)
	}
}
