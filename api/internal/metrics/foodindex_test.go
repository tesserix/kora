package metrics

import (
	"context"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// The positive twin. Reads the REAL count from food_items and asserts the
// gauges carry exactly it — so a RefreshOnce that queries correctly but never
// publishes, or publishes constants, fails here.
func TestRefreshOncePublishesTheQueriedCounts(t *testing.T) {
	db := testDB(t)
	c := New()
	r := NewFoodIndexRefresher(db, c, time.Minute, quietLogger())

	var want struct {
		Total    int64
		Embedded int64
	}
	if err := db.Raw(
		"SELECT count(*) AS total, count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded FROM food_items",
	).Scan(&want).Error; err != nil {
		t.Fatalf("baseline query: %v", err)
	}

	if err := r.RefreshOnce(context.Background()); err != nil {
		t.Fatalf("RefreshOnce: %v", err)
	}

	items, embedded, missing := c.FoodIndexGauges()
	if got := int64(testutil.ToFloat64(items)); got != want.Total {
		t.Errorf("items gauge = %d, want %d (the real food_items count)", got, want.Total)
	}
	if got := int64(testutil.ToFloat64(embedded)); got != want.Embedded {
		t.Errorf("embedded gauge = %d, want %d (the real embedded count)", got, want.Embedded)
	}
	if got := int64(testutil.ToFloat64(missing)); got != want.Total-want.Embedded {
		t.Errorf("missing gauge = %d, want %d", got, want.Total-want.Embedded)
	}
}

// The negative twin. Observability failing must never take the product down,
// and must never publish a LIE — a failed query leaves the last good reading
// standing rather than zeroing the gauges, which would look exactly like an
// empty food index, which would page someone at 3am for nothing.
func TestRefreshOnceLeavesGaugesOnQueryFailure(t *testing.T) {
	db := testDB(t)
	c := New()
	c.SetFoodIndex(7898, 3820)

	broken := db.Session(&gorm.Session{})
	if err := broken.Exec("SET search_path TO pg_temp").Error; err != nil {
		t.Fatalf("could not break the session: %v", err)
	}
	r := NewFoodIndexRefresher(broken, c, time.Minute, quietLogger())

	err := r.RefreshOnce(context.Background())
	if err == nil {
		t.Fatal("RefreshOnce returned nil error against a session that cannot see food_items")
	}

	items, embedded, missing := c.FoodIndexGauges()
	if got := testutil.ToFloat64(items); got != 7898 {
		t.Errorf("items gauge = %v after a failed refresh, want the last good value 7898", got)
	}
	if got := testutil.ToFloat64(embedded); got != 3820 {
		t.Errorf("embedded gauge = %v after a failed refresh, want the last good value 3820", got)
	}
	if got := testutil.ToFloat64(missing); got != 4078 {
		t.Errorf("missing gauge = %v after a failed refresh, want the last good value 4078", got)
	}
}

// Run must publish IMMEDIATELY rather than waiting out the first tick —
// otherwise a pod that restarts every few minutes never reports at all.
func TestRunRefreshesImmediatelyAndStopsOnContextCancel(t *testing.T) {
	db := testDB(t)
	c := New()
	r := NewFoodIndexRefresher(db, c, time.Hour, quietLogger())

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		r.Run(ctx)
		close(done)
	}()

	deadline := time.After(5 * time.Second)
	items, _, _ := c.FoodIndexGauges()
	for testutil.ToFloat64(items) == 0 {
		select {
		case <-deadline:
			cancel()
			t.Fatal("Run did not publish within 5s despite a 1h interval — it is waiting for the first tick")
		case <-time.After(10 * time.Millisecond):
		}
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after context cancel")
	}
}
