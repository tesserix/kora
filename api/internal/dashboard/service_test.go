package dashboard

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/tracking"
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

func TestForDayAggregatesConsumedAndSources(t *testing.T) {
	db := testDB(t)
	id := uuid.New()
	require.NoError(t, db.Exec("INSERT INTO users (id, firebase_uid, email, target_kcal, target_protein_g) VALUES (?, ?, ?, ?, ?)",
		id, "dash-"+id.String(), "d@test.dev", 2000.0, 150.0).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })

	item := nutrition.FoodItem{Name: "Dash Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	day := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)
	logSvc := foodlog.NewService(foodlog.NewRepository(db), nutrition.NewRepository(db))
	_, err := logSvc.LogFood(context.Background(), id, foodlog.LogRequest{FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 200, LoggedAt: day})
	require.NoError(t, err)

	svc := NewService(foodlog.NewRepository(db), tracking.NewRepository(db), db)
	sum, err := svc.ForDay(context.Background(), id, day, time.UTC)
	require.NoError(t, err)
	require.Equal(t, 200.0, sum.Consumed.Kcal)
	require.Equal(t, 2000.0, sum.Targets.Kcal)
	require.Equal(t, 1, sum.SourceCounts["manual"])
	require.Equal(t, 1, sum.StreakDays)
}
