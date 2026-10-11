package billing

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Entitlement is what a paid order bought: extra provider-backed requests,
// bounded by a total, a daily rate and an expiry.
type Entitlement struct {
	ID        uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID    uuid.UUID `json:"-"`
	OrderID   uuid.UUID `json:"order_id"`
	PackCode  string    `json:"pack_code"`
	Unlimited bool      `json:"unlimited"`
	// GrantTotal and DailyCap are POINTERS because unlimited entitlements
	// store NULL for both — a zero would read as "grants nothing", which is
	// the opposite of what an unlimited pack means.
	GrantTotal *int      `json:"grant_total"`
	Consumed   int       `json:"consumed"`
	DailyCap   *int      `json:"daily_cap"`
	StartsAt   time.Time `json:"starts_at"`
	ExpiresAt  time.Time `json:"expires_at"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

func (Entitlement) TableName() string { return "ai_entitlements" }

// Remaining is how many requests are left on this entitlement. An unlimited
// entitlement reports 0 and callers must check Unlimited first — there is no
// honest finite number to return.
func (e Entitlement) Remaining() int {
	if e.Unlimited || e.GrantTotal == nil {
		return 0
	}
	if left := *e.GrantTotal - e.Consumed; left > 0 {
		return left
	}
	return 0
}

// live reports whether e can be spent at t: inside its window, and with
// something left to spend.
func (e Entitlement) live(t time.Time) bool {
	if t.Before(e.StartsAt) || !t.Before(e.ExpiresAt) {
		return false
	}
	return e.Unlimited || e.Remaining() > 0
}

// grantEntitlement writes the entitlement a paid order bought, inside that
// order's own transaction. The unique index on order_id means a replayed
// webhook cannot grant twice; ON CONFLICT DO NOTHING turns that collision into
// a no-op rather than a 500 the gateway would then retry forever.
func grantEntitlement(tx *gorm.DB, userID, orderID uuid.UUID, pack Pack, now time.Time) error {
	var grantTotal, dailyCap *int
	if !pack.Unlimited {
		grant, perDay := pack.Grant, pack.DailyCap
		grantTotal, dailyCap = &grant, &perDay
	}
	return tx.Exec(`
		INSERT INTO ai_entitlements
			(user_id, order_id, pack_code, unlimited, grant_total, daily_cap, starts_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (order_id) DO NOTHING`,
		userID, orderID, pack.Code, pack.Unlimited, grantTotal, dailyCap,
		now.UTC(), now.UTC().Add(packValidity),
	).Error
}

// liveEntitlements loads the user's spendable entitlements, oldest expiry
// first so the one closest to expiring is used before one the user can still
// spend next week.
//
// forUpdate locks them, which the admission path needs and the read-only
// status path does not.
func liveEntitlements(tx *gorm.DB, userID uuid.UUID, now time.Time, forUpdate bool) ([]Entitlement, error) {
	q := tx.Where("user_id = ? AND starts_at <= ? AND expires_at > ?", userID, now.UTC(), now.UTC()).
		Order("expires_at ASC")
	if forUpdate {
		q = q.Clauses(clause.Locking{Strength: "UPDATE"})
	}
	var rows []Entitlement
	if err := q.Find(&rows).Error; err != nil {
		return nil, err
	}
	out := rows[:0]
	for _, row := range rows {
		if row.live(now) {
			out = append(out, row)
		}
	}
	return out, nil
}

// dayCounts returns today's spend for each of ids, keyed by entitlement id.
func dayCounts(tx *gorm.DB, ids []uuid.UUID, day time.Time) (map[uuid.UUID]int, error) {
	counts := make(map[uuid.UUID]int, len(ids))
	if len(ids) == 0 {
		return counts, nil
	}
	var rows []struct {
		EntitlementID uuid.UUID `gorm:"column:entitlement_id"`
		RequestCount  int       `gorm:"column:request_count"`
	}
	if err := tx.Raw(`
		SELECT entitlement_id, request_count
		FROM ai_entitlement_days
		WHERE entitlement_id IN ? AND day = ?`,
		ids, day).Scan(&rows).Error; err != nil {
		return nil, err
	}
	for _, row := range rows {
		counts[row.EntitlementID] = row.RequestCount
	}
	return counts, nil
}

// spendEntitlement charges one request to the first entitlement that can take
// it, and reports whether any could. An unlimited entitlement is charged too:
// its per-day row is what makes paid usage auditable, and without it an
// unlimited pack would leave no trace of what it covered.
func spendEntitlement(tx *gorm.DB, userID uuid.UUID, now time.Time) (bool, error) {
	live, err := liveEntitlements(tx, userID, now, true)
	if err != nil {
		return false, err
	}
	if len(live) == 0 {
		return false, nil
	}
	day := utcDay(now)
	ids := make([]uuid.UUID, 0, len(live))
	for _, e := range live {
		ids = append(ids, e.ID)
	}
	counts, err := dayCounts(tx, ids, day)
	if err != nil {
		return false, err
	}

	for _, e := range live {
		if !e.Unlimited && e.DailyCap != nil && counts[e.ID] >= *e.DailyCap {
			continue
		}
		if err := tx.Exec(`
			INSERT INTO ai_entitlement_days (entitlement_id, day, request_count, updated_at)
			VALUES (?, ?, 1, ?)
			ON CONFLICT (entitlement_id, day)
			DO UPDATE SET request_count = ai_entitlement_days.request_count + 1,
			              updated_at = EXCLUDED.updated_at`,
			e.ID, day, now.UTC()).Error; err != nil {
			return false, err
		}
		if e.Unlimited {
			return true, nil
		}
		if err := tx.Exec(`
			UPDATE ai_entitlements
			SET consumed = consumed + 1, updated_at = ?
			WHERE id = ?`, now.UTC(), e.ID).Error; err != nil {
			return false, err
		}
		return true, nil
	}
	return false, nil
}

func utcDay(t time.Time) time.Time {
	u := t.UTC()
	return time.Date(u.Year(), u.Month(), u.Day(), 0, 0, 0, 0, time.UTC)
}
