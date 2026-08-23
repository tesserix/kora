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
	// pendingMetrics, when non-nil, redirects Create's metric recording into
	// this slice instead of incrementing the counter immediately. Only the
	// tx-bound Repository handed to Transaction's fn has this set — see
	// Transaction for why.
	pendingMetrics *[]string
}

func NewRepository(db *gorm.DB) Repository {
	return Repository{db: db}
}

// Transaction runs fn inside a single DB transaction, passing fn a Repository
// bound to that transaction. If fn returns an error, every write made through
// the tx-bound Repository is rolled back; if fn returns nil, the transaction
// commits. Used by CreateBatch for all-or-nothing batch meal logging.
//
// Create, called through the tx-bound Repository, does NOT record the
// kora_food_logs_total metric as each row is inserted — an insert made inside
// an open transaction isn't durable until commit, and a later item in the
// same batch can still roll the whole thing back. Instead, each created row's
// source is collected here and only recorded once db.Transaction returns nil,
// i.e. once postgres has actually committed. A rollback (fn returns an error)
// discards the collected sources along with the rows, so nothing is counted
// for logs that don't exist.
func (r Repository) Transaction(ctx context.Context, fn func(Repository) error) error {
	var pending []string
	if err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return fn(Repository{db: tx, pendingMetrics: &pending})
	}); err != nil {
		return err
	}
	for _, source := range pending {
		metrics.RecordFoodLog(source)
	}
	return nil
}

func (r Repository) Create(ctx context.Context, log FoodLog) (FoodLog, error) {
	created := log
	if err := r.db.WithContext(ctx).Create(&created).Error; err != nil {
		return FoodLog{}, fmt.Errorf("foodlog: create: %w", err)
	}
	if r.pendingMetrics != nil {
		*r.pendingMetrics = append(*r.pendingMetrics, created.Source)
	} else {
		metrics.RecordFoodLog(created.Source)
	}
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

// withFoodUnit is the read scope that carries the logged food's base unit
// alongside the log itself. food_logs has no base_unit column of its own —
// the log stores the RESOLVED quantity_grams and nothing re-resolves on read
// — but a client cannot label a legacy row (one with no entered pair) without
// knowing whether the food is measured in grams or millilitres.
//
// LEFT JOIN, because a log need not resolve to a food item; such a row simply
// gets an empty base unit, which clients already treat as "assume grams".
func (r Repository) withFoodUnit(ctx context.Context) *gorm.DB {
	return r.db.WithContext(ctx).
		Model(&FoodLog{}).
		Select("food_logs.*, food_items.base_unit AS base_unit").
		Joins("LEFT JOIN food_items ON food_items.id = food_logs.food_item_id")
}

// ListByUserAndDay returns the logs whose stored local_date is `day`.
//
// Filters on the STORED local_date rather than deriving a window from the
// user's current profile timezone: a log's day is fixed at capture and must
// not move when the profile changes. See kora#84 and internal/localday.
func (r Repository) ListByUserAndDay(ctx context.Context, userID uuid.UUID, day time.Time) ([]FoodLog, error) {
	var logs []FoodLog
	err := r.withFoodUnit(ctx).
		Where("food_logs.user_id = ? AND food_logs.local_date = ?", userID, day.Format("2006-01-02")).
		Order("food_logs.logged_at ASC").
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

// DaysLoggedBetween counts the DISTINCT local days in [from, before) on which
// the user logged anything (resolved to a food item, the same definition
// ListForUserSince uses).
//
// It replaced an EXISTS "has this user ever logged" check (kora#408). That
// check was used to decide whether silence could be read as observed fasting,
// and a single entry satisfied it permanently — so one stray log turned a week
// of not using the app into a reported seven-day fast. Counting distinct DAYS
// rather than rows matters for the same reason: four entries in one sitting is
// one day of evidence, not four.
func (r Repository) DaysLoggedBetween(ctx context.Context, userID uuid.UUID, from, before time.Time) (int, error) {
	var days int64
	err := r.db.WithContext(ctx).
		Raw(`SELECT COUNT(DISTINCT local_date) FROM food_logs
		     WHERE user_id = ? AND food_item_id IS NOT NULL
		       AND logged_at >= ? AND logged_at < ?`,
			userID, from, before).
		Scan(&days).Error
	if err != nil {
		return 0, fmt.Errorf("foodlog: days logged between: %w", err)
	}
	return int(days), nil
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
			"food_item_id":    log.FoodItemID,
			"logged_at":       log.LoggedAt,
			"meal_slot":       log.MealSlot,
			"description":     log.Description,
			"quantity_grams":  log.QuantityGrams,
			"entered_amount":  log.EnteredAmount,
			"entered_unit":    log.EnteredUnit,
			"kcal":            log.Kcal,
			"protein_g":       log.ProteinG,
			"carbs_g":         log.CarbsG,
			"fat_g":           log.FatG,
			"fiber_g":         log.FiberG,
			"provenance":      log.Provenance,
			"input_phrase":    log.InputPhrase,
			"portion_assumed": log.PortionAssumed,
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
	if err := r.withFoodUnit(ctx).
		Where("food_logs.id = ? AND food_logs.user_id = ?", logID, userID).
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
// Reads the STORED local_date rather than deriving a day from logged_at in the
// profile timezone.
//
// kora#84 fixed the diary this way but left this query on the old derivation,
// which made the two DISAGREE: a meal visible on Tuesday in the diary could be
// counted against Wednesday by the streak, and the user could see both. Same
// day, one answer — and a timezone change can no longer move streak history.
func (r Repository) LoggedDaysDesc(ctx context.Context, userID uuid.UUID, notAfter time.Time, limit int) ([]string, error) {
	if limit <= 0 || limit > 4000 {
		limit = 4000
	}
	// notAfter is a calendar date; days strictly before the day AFTER it are
	// in range, which is the same inclusive-of-notAfter window as before.
	end := time.Date(notAfter.Year(), notAfter.Month(), notAfter.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1)
	var days []string
	err := r.db.WithContext(ctx).
		Raw("SELECT DISTINCT to_char(local_date, 'YYYY-MM-DD') AS day FROM food_logs WHERE user_id = ? AND local_date < ? ORDER BY day DESC LIMIT ?",
			userID, end.Format("2006-01-02"), limit).
		Scan(&days).Error
	if err != nil {
		return nil, fmt.Errorf("foodlog: logged days: %w", err)
	}
	return days, nil
}

// DailyKcal returns total kcal grouped by local calendar day (YYYY-MM-DD in loc)
// over [from, to). Days with no logs are simply absent from the map.
// Buckets on the STORED local_date, so the trends chart agrees with the diary
// and the streak rather than re-deriving a day from the profile timezone. Same
// reasoning as LoggedDaysDesc above — see kora#84.
func (r Repository) DailyKcal(ctx context.Context, userID uuid.UUID, from, to time.Time) (map[string]float64, error) {
	type row struct {
		Day  string
		Kcal float64
	}
	var rows []row
	err := r.db.WithContext(ctx).
		Raw("SELECT to_char(local_date, 'YYYY-MM-DD') AS day, COALESCE(SUM(kcal), 0) AS kcal FROM food_logs WHERE user_id = ? AND local_date >= ? AND local_date < ? GROUP BY day",
			userID, from.Format("2006-01-02"), to.Format("2006-01-02")).
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
