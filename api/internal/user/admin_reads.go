package user

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// AdminRow is one row of the admin user list: activation facts for a single
// user. It deliberately never carries firebase_uid, apple_refresh_token, or
// any target_* VALUE -- HasTargets is a boolean derived from whether
// target_kcal is set, and the underlying number never leaves the API.
//
// target_kcal is NOT NULL DEFAULT 0 (migration 000002_phase1_core.up.sql),
// so "IS NOT NULL" as the brief specified is always true and would report
// every user as having targets. The onboarding handler writes a nonzero
// target_kcal (internal/onboarding/handler.go); an un-onboarded user's row
// stays at the column default of 0. HasTargets uses "> 0" instead.
type AdminRow struct {
	ID          uuid.UUID  `json:"id"`
	Email       string     `json:"email"`
	DisplayName string     `json:"display_name"`
	CreatedAt   time.Time  `json:"created_at"`
	OnboardedAt *time.Time `json:"onboarded_at"`
	Timezone    string     `json:"timezone"`
	HasTargets  bool       `json:"has_targets"`
	LogCount    int64      `json:"log_count"`
	FirstLog    *time.Time `json:"first_log"`
	LastWrite   *time.Time `json:"last_write"`
	AICalls     int64      `json:"ai_calls"`
}

// AdminSummary is the four-number strip shown above the admin user table.
type AdminSummary struct {
	Users            int64 `json:"users"`
	Onboarded        int64 `json:"onboarded"`
	EverLogged       int64 `json:"ever_logged"`
	TriedNeverLogged int64 `json:"tried_never_logged"`
}

// AdminListResult is the full payload for GET /v1/admin/users.
type AdminListResult struct {
	Items   []AdminRow   `json:"items"`
	Summary AdminSummary `json:"summary"`
}

// AdminDetail is one user's activation row plus a DELETION PREVIEW: how much
// of their data exists, and what deleting them hands to somebody else.
//
// Counts only. A user's actual food logs, weights and coach turns are their
// own history, not an admin surface -- and AdminRow, which this embeds,
// already carries no firebase_uid, no apple_refresh_token and no target_*
// value. HasAppleToken is a boolean derived from the token's PRESENCE; the
// token itself never leaves the API.
type AdminDetail struct {
	AdminRow
	Counts        map[string]int64 `json:"counts"`
	Transfers     []Transfer       `json:"transfers"`
	HasAppleToken bool             `json:"has_apple_token"`
}

// adminCountTables are the per-user tables whose row counts the detail panel
// shows. Every entry must have a user_id column; the names are interpolated
// into the query (they are compile-time constants from this slice, never
// request input, so there is nothing user-controlled to inject).
var adminCountTables = []string{
	"food_logs", "weight_entries", "water_entries", "saved_meals",
	"food_aliases", "pins", "device_tokens", "coach_turns",
	"group_members", "challenge_participants", "feedback", "ai_usage_events",
}

// GetForAdmin returns one user's activation row plus a deletion preview: what
// exists, and what deleting them will hand to somebody else.
//
// The row is taken from ListForAdmin rather than re-derived, so the detail
// panel and the table it was opened from can never disagree -- including on
// has_targets, which is target_kcal > 0 and NOT "IS NOT NULL" (the column is
// NOT NULL DEFAULT 0, so IS NOT NULL is a constant true).
func (r Repository) GetForAdmin(ctx context.Context, id uuid.UUID) (AdminDetail, error) {
	var d AdminDetail

	list, err := r.ListForAdmin(ctx)
	if err != nil {
		return d, err
	}
	found := false
	for _, row := range list.Items {
		if row.ID == id {
			d.AdminRow, found = row, true
			break
		}
	}
	if !found {
		return d, ErrNotFound
	}

	d.Counts = map[string]int64{}
	for _, table := range adminCountTables {
		var n int64
		if err := r.db.WithContext(ctx).
			Raw(`SELECT count(*) FROM `+table+` WHERE user_id = ?`, id).Scan(&n).Error; err != nil {
			return AdminDetail{}, fmt.Errorf("user: count %s: %w", table, err)
		}
		d.Counts[table] = n
	}

	// The SAME query the deletion runs, minus the UPDATEs, so the preview
	// cannot drift from the behaviour it predicts.
	transfers, err := previewTransfers(r.db.WithContext(ctx), id)
	if err != nil {
		return AdminDetail{}, err
	}
	d.Transfers = transfers

	// Presence only. COALESCE because the column is '' for rows created via
	// UpsertByFirebaseUID but NULL is still representable.
	var token string
	if err := r.db.WithContext(ctx).
		Raw(`SELECT COALESCE(apple_refresh_token, '') FROM users WHERE id = ?`, id).
		Scan(&token).Error; err != nil {
		return AdminDetail{}, fmt.Errorf("user: read apple token presence: %w", err)
	}
	d.HasAppleToken = token != ""

	return d, nil
}

// ListForAdmin returns every user with their activation facts, newest signup
// first, plus the summary strip's four counts.
//
// ai_calls deliberately does NOT filter outcome = 'ok': it counts every AI
// call, including failures, because a user with AI calls but zero food logs
// -- the "tried and failed" cohort -- is the most actionable row on the page.
// Filtering to successes would erase it. It is a count of calls, not
// captures: one user action can emit several rows when a fallback leg is
// abandoned.
//
// No pagination: correct for a handful of beta users, wrong for thousands.
// Add it when the list stops fitting on a screen -- the threshold is
// genuinely unknown and is not invented here.
func (r Repository) ListForAdmin(ctx context.Context) (AdminListResult, error) {
	var out AdminListResult

	rows := []AdminRow{}
	err := r.db.WithContext(ctx).Raw(`
		SELECT u.id, COALESCE(u.email, '') AS email,
		       COALESCE(u.display_name, '') AS display_name,
		       u.created_at, u.onboarded_at, u.timezone,
		       (u.target_kcal > 0) AS has_targets,
		       COALESCE(l.log_count, 0) AS log_count,
		       l.first_log,
		       GREATEST(l.last_log, a.last_ai_call) AS last_write,
		       COALESCE(a.ai_calls, 0) AS ai_calls
		FROM users u
		LEFT JOIN (
			SELECT user_id, count(*) AS log_count,
			       min(logged_at) AS first_log, max(logged_at) AS last_log
			FROM food_logs GROUP BY user_id
		) l ON l.user_id = u.id
		LEFT JOIN (
			SELECT user_id, count(*) AS ai_calls, max(created_at) AS last_ai_call
			FROM ai_usage_events WHERE user_id IS NOT NULL GROUP BY user_id
		) a ON a.user_id = u.id
		ORDER BY u.created_at DESC`).Scan(&rows).Error
	if err != nil {
		return out, fmt.Errorf("user: admin list: %w", err)
	}
	out.Items = rows

	// Computed from the rows already fetched rather than four more round
	// trips -- and it keeps the strip arithmetically consistent with the
	// table under it, which a separate query cannot guarantee.
	out.Summary.Users = int64(len(rows))
	for _, row := range rows {
		if row.OnboardedAt != nil {
			out.Summary.Onboarded++
		}
		switch {
		case row.LogCount > 0:
			out.Summary.EverLogged++
		case row.AICalls > 0:
			out.Summary.TriedNeverLogged++
		}
	}
	return out, nil
}
