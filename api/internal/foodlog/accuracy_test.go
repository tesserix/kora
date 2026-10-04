package foodlog

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/nutrition"
)

type scored struct {
	resolutionID uuid.UUID
	index        int
	food         uuid.UUID
	corrected    bool
}

// fakeAccuracy offers three items on every resolution it owns.
type fakeAccuracy struct {
	owner  map[uuid.UUID]uuid.UUID
	scored []scored
}

func (f *fakeAccuracy) Owns(_ context.Context, userID, resolutionID uuid.UUID, index int) bool {
	return f.owner[resolutionID] == userID && index >= 0 && index < 3
}

func (f *fakeAccuracy) Logged(_ context.Context, _ uuid.UUID, resolutionID uuid.UUID, index int, food uuid.UUID, corrected bool) {
	f.scored = append(f.scored, scored{resolutionID, index, food, corrected})
}

func intPtr(v int) *int { return &v }

func seedFood(t *testing.T, db *gorm.DB) nutrition.FoodItem {
	t.Helper()
	item := nutrition.FoodItem{Name: "Accuracy Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })
	return item
}

func seedResolution(t *testing.T, db *gorm.DB, userID uuid.UUID) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		`INSERT INTO food_resolution_outcomes (id, user_id, kind, mode) VALUES (?, ?, 'resolved', 'text')`,
		id, userID).Error)
	return id
}

func TestLoggingAResolutionScoresAndLinksIt(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	food := seedFood(t, db)
	resolutionID := seedResolution(t, db, userID)
	acc := &fakeAccuracy{owner: map[uuid.UUID]uuid.UUID{resolutionID: userID}}
	svc := NewService(NewRepository(db), nutrition.NewRepository(db)).WithAccuracy(acc)

	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &food.ID, MealSlot: "lunch", Source: "ai_text", QuantityGrams: 100,
		LoggedAt: time.Now(), ResolutionID: &resolutionID, ResolutionIndex: intPtr(2),
	}, nil)

	require.NoError(t, err)
	require.NotNil(t, log.ResolutionOutcomeID)
	assert.Equal(t, resolutionID, *log.ResolutionOutcomeID)
	require.NotNil(t, log.ResolutionIndex)
	assert.Equal(t, 2, *log.ResolutionIndex)
	assert.Equal(t, []scored{{resolutionID, 2, food.ID, false}}, acc.scored)
}

func TestAResolutionWithoutAnItemIndexIsNotLinked(t *testing.T) {
	for name, index := range map[string]*int{"missing": nil, "out of range": intPtr(3)} {
		t.Run(name, func(t *testing.T) {
			db := testDB(t)
			userID := seedUser(t, db)
			food := seedFood(t, db)
			resolutionID := seedResolution(t, db, userID)
			acc := &fakeAccuracy{owner: map[uuid.UUID]uuid.UUID{resolutionID: userID}}
			svc := NewService(NewRepository(db), nutrition.NewRepository(db)).WithAccuracy(acc)

			log, err := svc.LogFood(context.Background(), userID, LogRequest{
				FoodItemID: &food.ID, MealSlot: "lunch", Source: "ai_text", QuantityGrams: 100,
				LoggedAt: time.Now(), ResolutionID: &resolutionID, ResolutionIndex: index,
			}, nil)

			require.NoError(t, err)
			assert.Nil(t, log.ResolutionOutcomeID)
			assert.Nil(t, log.ResolutionIndex)
			assert.Empty(t, acc.scored)
		})
	}
}

func TestAnotherUsersResolutionIsNeitherLinkedNorScored(t *testing.T) {
	db := testDB(t)
	owner, intruder := seedUser(t, db), seedUser(t, db)
	food := seedFood(t, db)
	resolutionID := seedResolution(t, db, owner)
	acc := &fakeAccuracy{owner: map[uuid.UUID]uuid.UUID{resolutionID: owner}}
	svc := NewService(NewRepository(db), nutrition.NewRepository(db)).WithAccuracy(acc)

	log, err := svc.LogFood(context.Background(), intruder, LogRequest{
		FoodItemID: &food.ID, MealSlot: "lunch", Source: "ai_text", QuantityGrams: 100,
		LoggedAt: time.Now(), ResolutionID: &resolutionID, ResolutionIndex: intPtr(2),
	}, nil)

	require.NoError(t, err, "a stale or foreign id must never fail the log")
	assert.Nil(t, log.ResolutionOutcomeID)
	assert.Empty(t, acc.scored)
}

func TestChangingTheFoodRescoresTheResolutionAsACorrection(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	first, second := seedFood(t, db), seedFood(t, db)
	resolutionID := seedResolution(t, db, userID)
	acc := &fakeAccuracy{owner: map[uuid.UUID]uuid.UUID{resolutionID: userID}}
	svc := NewService(NewRepository(db), nutrition.NewRepository(db)).WithAccuracy(acc)
	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &first.ID, MealSlot: "lunch", Source: "ai_text", QuantityGrams: 100,
		LoggedAt: time.Now(), ResolutionID: &resolutionID, ResolutionIndex: intPtr(2),
	}, nil)
	require.NoError(t, err)

	_, err = svc.EditLog(context.Background(), userID, log.ID, EditRequest{QuantityGrams: floatPtr(150)})
	require.NoError(t, err)
	_, err = svc.EditLog(context.Background(), userID, log.ID, EditRequest{FoodItemID: &second.ID})
	require.NoError(t, err)

	assert.Equal(t, []scored{
		{resolutionID, 2, first.ID, false},
		{resolutionID, 2, second.ID, true},
	}, acc.scored, "a portion edit says nothing about the food; a food change is the correction")
}

func TestLoggingWithoutAResolutionScoresNothing(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	food := seedFood(t, db)
	acc := &fakeAccuracy{}
	svc := NewService(NewRepository(db), nutrition.NewRepository(db)).WithAccuracy(acc)

	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &food.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: time.Now(),
	}, nil)

	require.NoError(t, err)
	assert.Nil(t, log.ResolutionOutcomeID)
	assert.Empty(t, acc.scored)
}
