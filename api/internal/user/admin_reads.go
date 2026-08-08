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
