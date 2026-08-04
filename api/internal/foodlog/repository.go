package foodlog

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/metrics"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository {
	return Repository{db: db}
}

// Transaction runs fn inside a single DB transaction, passing fn a Repository
// bound to that transaction. If fn returns an error, every write made through
// the tx-bound Repository is rolled back; if fn returns nil, the transaction
// commits. Used by CreateBatch for all-or-nothing batch meal logging.
func (r Repository) Transaction(ctx context.Context, fn func(Repository) error) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return fn(Repository{db: tx})
	})
}

func (r Repository) Create(ctx context.Context, log FoodLog) (FoodLog, error) {
	created := log
	if err := r.db.WithContext(ctx).Create(&created).Error; err != nil {
		return FoodLog{}, fmt.Errorf("foodlog: create: %w", err)
	}
	metrics.RecordFoodLog(created.Source)
	return created, nil
}

// CreateIdempotent inserts log, or returns the already-stored row when its ID
// is taken. The offline queue replays writes whose response was lost, so a
// replay MUST be indistinguishable from a first delivery — otherwise a flaky
// reconnect duplicates the user's meal.
//
// ON CONFLICT DO NOTHING is used rather than catching a duplicate-key error:
// gorm.Config here has no TranslateError, so gorm.ErrDuplicatedKey is never
// returned, and sniffing SQLSTATE 23505 would make pgconn a direct dependency
// for one branch. RowsAffected == 0 means the row already existed.
func (r Repository) CreateIdempotent(ctx context.Context, log FoodLog) (FoodLog, error) {
	created := log
	res := r.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&created)
	if res.Error != nil {
		return FoodLog{}, fmt.Errorf("foodlog: create idempotent: %w", res.Error)
	}
	if res.RowsAffected > 0 {
		// Only a real insert counts. RowsAffected == 0 below means the offline
		// queue replayed a write whose response was lost — that is the same
		// meal, not a new one, and counting it would inflate the photo-share
		// metric in proportion to connection flakiness.
		metrics.RecordFoodLog(created.Source)
		return created, nil
	}

	var existing FoodLog
	if err := r.db.WithContext(ctx).First(&existing, "id = ?", log.ID).Error; err != nil {
		return FoodLog{}, fmt.Errorf("foodlog: load existing: %w", err)
	}
	if existing.UserID != log.UserID {
		// Deliberately does not name the id: the caller must not learn that
		// somebody else's log has this id.
		return FoodLog{}, httpx.ValidationError{Message: "invalid id"}
	}
	return existing, nil
}

// ListByUserAndDay returns logs whose logged_at falls on `day` in location `loc`.
func (r Repository) ListByUserAndDay(ctx context.Context, userID uuid.UUID, day time.Time, loc *time.Location) ([]FoodLog, error) {
	start := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, loc)
	end := start.Add(24 * time.Hour)
	var logs []FoodLog
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND logged_at >= ? AND logged_at < ?", userID, start, end).
		Order("logged_at ASC").
		Find(&logs).Error
	if err != nil {
		return nil, fmt.Errorf("foodlog: list by day: %w", err)
	}
	return logs, nil
}

// ListForUserSince returns the user's logs at or after `since` that resolved to
// a food item (food_item_id NOT NULL), oldest first. Used by the memory engine.
func (r Repository) ListForUserSince(ctx context.Context, userID uuid.UUID, since time.Time) ([]FoodLog, error) {
	var logs []FoodLog
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND food_item_id IS NOT NULL AND logged_at >= ?", userID, since).
		Order("logged_at ASC").
		Find(&logs).Error
	if err != nil {
		return nil, fmt.Errorf("foodlog: list for user since: %w", err)
	}
	return logs, nil
}

// HasLoggedBefore reports whether the user has any log (resolved to a food
// item, same definition ListForUserSince uses) strictly before `before`. It
// exists to answer "has this user ever logged anything?" over an unbounded
// lookback — distinguishing a user who has simply never logged from one
// with established history who has since gone silent, which a single
// bounded-window read can't tell apart (see coach.LogSource). An
// EXISTS/LIMIT-1 read: only presence matters, so no rows are fetched.
func (r Repository) HasLoggedBefore(ctx context.Context, userID uuid.UUID, before time.Time) (bool, error) {
	var exists bool
	err := r.db.WithContext(ctx).
		Raw("SELECT EXISTS (SELECT 1 FROM food_logs WHERE user_id = ? AND food_item_id IS NOT NULL AND logged_at < ? LIMIT 1) AS logged_before",
			userID, before).
		Scan(&exists).Error
	if err != nil {
		return false, fmt.Errorf("foodlog: has logged before: %w", err)
	}
	return exists, nil
}

// LastPortionForPhrase returns the QuantityGrams from userID's most recent
// food_logs row whose input_phrase matches phrase (case/whitespace
// insensitive, same normalization nutrition.AddAlias writes with), or
// found=false if none exists. It exists so a personal-alias short-circuit
// (see ai.Resolver.ResolveText) can inherit the portion the user actually
// logged last time they used this exact phrase — an alias hit only tells the
// resolver WHICH food, not HOW MUCH, and food_logs.input_phrase is the only
// place that portion was ever recorded.
func (r Repository) LastPortionForPhrase(ctx context.Context, userID uuid.UUID, phrase string) (float64, bool, error) {
	key := strings.ToLower(strings.TrimSpace(phrase))
	if key == "" {
		return 0, false, nil
	}
	var grams []float64
	if err := r.db.WithContext(ctx).
		Raw(`SELECT quantity_grams FROM food_logs
		     WHERE user_id = ? AND input_phrase IS NOT NULL AND lower(trim(input_phrase)) = ?
		     ORDER BY logged_at DESC LIMIT 1`, userID, key).
		Scan(&grams).Error; err != nil {
		return 0, false, fmt.Errorf("foodlog: last portion for phrase: %w", err)
	}
	if len(grams) == 0 {
		return 0, false, nil
	}
	return grams[0], true, nil
}

// Update persists changes to an existing log, scoped to its owner. It updates
// by (id AND user_id) so a user can never edit another user's log; if no row
// matches, it returns gorm.ErrRecordNotFound wrapped.
func (r Repository) Update(ctx context.Context, log FoodLog) (FoodLog, error) {
	res := r.db.WithContext(ctx).
		Model(&FoodLog{}).
		Where("id = ? AND user_id = ?", log.ID, log.UserID).
		Updates(map[string]any{
			"food_item_id":   log.FoodItemID,
			"logged_at":      log.LoggedAt,
			"meal_slot":      log.MealSlot,
			"description":    log.Description,
			"quantity_grams": log.QuantityGrams,
			"kcal":           log.Kcal,
			"protein_g":      log.ProteinG,
			"carbs_g":        log.CarbsG,
			"fat_g":          log.FatG,
			"fiber_g":        log.FiberG,
			"provenance":     log.Provenance,
			"input_phrase":   log.InputPhrase,
		})
	if res.Error != nil {
		return FoodLog{}, fmt.Errorf("foodlog: update: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return FoodLog{}, fmt.Errorf("foodlog: update: %w", gorm.ErrRecordNotFound)
	}
	return r.GetByID(ctx, log.UserID, log.ID)
}

func (r Repository) GetByID(ctx context.Context, userID, logID uuid.UUID) (FoodLog, error) {
	var log FoodLog
	if err := r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", logID, userID).
		First(&log).Error; err != nil {
		return FoodLog{}, fmt.Errorf("foodlog: get by id: %w", err)
	}
	return log, nil
}

func (r Repository) Delete(ctx context.Context, userID, logID uuid.UUID) error {
	res := r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", logID, userID).
		Delete(&FoodLog{})
	if res.Error != nil {
		return fmt.Errorf("foodlog: delete: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return fmt.Errorf("foodlog: delete: not found")
	}
	return nil
}

// LoggedDaysDesc returns distinct calendar days (YYYY-MM-DD in loc) that have at
// least one log at or before `notAfter`'s day, most-recent first, capped at limit.
func (r Repository) LoggedDaysDesc(ctx context.Context, userID uuid.UUID, notAfter time.Time, loc *time.Location, limit int) ([]string, error) {
	if limit <= 0 || limit > 4000 {
		limit = 4000
	}
	end := time.Date(notAfter.Year(), notAfter.Month(), notAfter.Day(), 0, 0, 0, 0, loc).Add(24 * time.Hour)
	tz := loc.String()
	var days []string
	err := r.db.WithContext(ctx).
		Raw("SELECT DISTINCT to_char(logged_at AT TIME ZONE ?, 'YYYY-MM-DD') AS day FROM food_logs WHERE user_id = ? AND logged_at < ? ORDER BY day DESC LIMIT ?",
			tz, userID, end, limit).
		Scan(&days).Error
	if err != nil {
		return nil, fmt.Errorf("foodlog: logged days: %w", err)
	}
	return days, nil
}

// DailyKcal returns total kcal grouped by local calendar day (YYYY-MM-DD in loc)
// over [from, to). Days with no logs are simply absent from the map.
func (r Repository) DailyKcal(ctx context.Context, userID uuid.UUID, from, to time.Time, loc *time.Location) (map[string]float64, error) {
	tz := loc.String()
	type row struct {
		Day  string
		Kcal float64
	}
	var rows []row
	err := r.db.WithContext(ctx).
		Raw("SELECT to_char(logged_at AT TIME ZONE ?, 'YYYY-MM-DD') AS day, COALESCE(SUM(kcal), 0) AS kcal FROM food_logs WHERE user_id = ? AND logged_at >= ? AND logged_at < ? GROUP BY day",
			tz, userID, from, to).
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("foodlog: daily kcal: %w", err)
	}
	out := make(map[string]float64, len(rows))
	for _, rw := range rows {
		out[rw.Day] = rw.Kcal
	}
	return out, nil
}
