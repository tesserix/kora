package refresh

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/nutrition"
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

// offServer serves a delta index naming one file per entry of lines, each a
// gzipped JSONL body.
func offServer(t *testing.T, lines map[string]string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	index := ""
	for name := range lines {
		index += name + "\n"
	}
	mux.HandleFunc("/data/delta/index.txt", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, index)
	})
	for name, body := range lines {
		var buf bytes.Buffer
		gz := gzip.NewWriter(&buf)
		_, err := gz.Write([]byte(body))
		require.NoError(t, err)
		require.NoError(t, gz.Close())
		payload := buf.Bytes()
		mux.HandleFunc("/data/delta/"+name, func(w http.ResponseWriter, _ *http.Request) {
			w.Write(payload)
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func runner(tx *gorm.DB, srv *httptest.Server) Runner {
	return Runner{
		DB:        tx,
		Repo:      nutrition.NewRepository(tx),
		Client:    Client{BaseURL: srv.URL, HTTP: srv.Client()},
		Countries: DefaultCountries(),
		Every:     7 * 24 * time.Hour,
		Check:     time.Hour,
		Log:       slog.New(slog.NewTextHandler(os.Stderr, nil)),
	}
}

// deltaName builds a file name whose window ends at end.
func deltaName(end time.Time) string {
	return fmt.Sprintf("products_%d_%d.json.gz", end.Add(-24*time.Hour).Unix(), end.Unix())
}

func TestTickRefreshesInsertsAndRecordsRun(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	require.NoError(t, tx.Exec("TRUNCATE food_refresh_runs").Error)

	now := time.Now()
	srv := offServer(t, map[string]string{
		deltaName(now): goodAU + "\n" +
			// Below the bar: no macros. Must be skipped, not inserted.
			`{"code":"9310000000001","product_name":"Empty","countries_tags":["en:australia"],"nutriments":{}}`,
	})

	require.NoError(t, runner(tx, srv).Tick(context.Background(), now))

	var foods []nutrition.FoodItem
	require.NoError(t, tx.Where("barcode = ?", "9300601123456").Find(&foods).Error)
	require.Len(t, foods, 1)
	require.Equal(t, "Weet-Bix", foods[0].Name)
	require.Equal(t, nutrition.LocaleAU, foods[0].Locale)

	var runs []Run
	require.NoError(t, tx.Order("started_at").Find(&runs).Error)
	require.Len(t, runs, 1)
	require.Equal(t, 1, runs[0].FilesRead)
	require.Equal(t, 1, runs[0].Seen)
	require.Equal(t, 1, runs[0].Inserted)
	require.Empty(t, runs[0].Error)

	// A second tick inside the cadence is a no-op: no second run row.
	require.NoError(t, runner(tx, srv).Tick(context.Background(), now.Add(time.Hour)))
	require.NoError(t, tx.Find(&runs).Error)
	require.Len(t, runs, 1)
}

func TestTickUpdatesChangedNutritionInPlace(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_items CASCADE").Error)
	require.NoError(t, tx.Exec("TRUNCATE food_refresh_runs").Error)

	code := "9300601123456"
	seeded := nutrition.FoodItem{
		Name: "Weet-Bix", Brand: "Sanitarium", Provenance: nutrition.ProvenanceOFF,
		Barcode: &code, KcalPer100g: 340, ProteinPer100g: 12, CarbsPer100g: 67,
		FatPer100g: 1.4, FiberPer100g: 10,
	}
	repo := nutrition.NewRepository(tx)
	_, err := repo.Insert(context.Background(), []nutrition.FoodItem{seeded})
	require.NoError(t, err)

	now := time.Now()
	srv := offServer(t, map[string]string{deltaName(now): goodAU})
	require.NoError(t, runner(tx, srv).Tick(context.Background(), now))

	var got nutrition.FoodItem
	require.NoError(t, tx.Where("barcode = ?", code).First(&got).Error)
	require.Equal(t, 355.0, got.KcalPer100g, "reformulated kcal must land")

	var runs []Run
	require.NoError(t, tx.Find(&runs).Error)
	require.Len(t, runs, 1)
	require.Equal(t, 0, runs[0].Inserted)
	require.Equal(t, 1, runs[0].Updated)
}

func TestFailedRunRecordsErrorAndDoesNotAdvanceSchedule(t *testing.T) {
	db := testDB(t)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	require.NoError(t, tx.Exec("TRUNCATE food_refresh_runs").Error)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	now := time.Now()
	require.Error(t, runner(tx, srv).Tick(context.Background(), now))

	var runs []Run
	require.NoError(t, tx.Find(&runs).Error)
	require.Len(t, runs, 1)
	require.NotEmpty(t, runs[0].Error)

	// Failed rows do not satisfy due, so the next tick tries again.
	due, _, err := runner(tx, srv).due(context.Background(), now.Add(time.Hour))
	require.NoError(t, err)
	require.True(t, due)
}
