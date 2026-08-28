package platformadmin

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// UserAIMetricsRow is one user's resolution activity over the requested
// window, counts only. It carries the same posture as user.AdminDetail: no
// food logs, no coach turns, no target_* value, no firebase_uid, no email —
// this surface counts what happened, it does not narrate it.
type UserAIMetricsRow struct {
	UserID uuid.UUID
	// Attempts, Resolves, Corrections and BudgetRefusals are all counts of
	// food_resolution_outcomes rows: total attempts, kind='resolved',
	// kind='alias' (a PREVIOUS correction paying off — see resolveoutcome.Kind
	// docs), and kind='budget' respectively.
	Attempts       int64
	Resolves       int64
	Corrections    int64
	BudgetRefusals int64
	// LastActivityAt is nil for a row that cannot exist without at least one
	// outcome, so in practice this is never nil for a returned row — kept as
	// a pointer anyway because it comes straight off a SQL max(), which the
	// driver represents as nullable regardless.
	LastActivityAt *time.Time
	// AICalls counts ai_usage_events rows for this user IN THE SAME WINDOW as
	// every other column on this row, NOT filtered to outcome='ok'. See
	// ListUserAIMetrics's doc comment for why.
	AICalls int64
}

// UserAIMetricsResult is a page of per-user rows plus the unpaged total.
type UserAIMetricsResult struct {
	Rows  []UserAIMetricsRow
	Total int64
}

// ListUserAIMetrics returns a paged, sorted slice of per-user resolution
// activity for #507's AI metrics page, plus the query's unpaged total.
//
// Two things distinguish this from a re-mount of user.ListForAdmin:
//
//  1. The base population is food_resolution_outcomes, not users. This page
//     answers "how is resolution doing, per user", so a user who never
//     attempted a resolution in the window has nothing to show here — unlike
//     the user admin list, which starts from every user and shows zeroes.
//  2. Sorting and paging happen INSIDE the query (ORDER BY + LIMIT/OFFSET on
//     the driving aggregate), not after an unbounded read. A per-user
//     resolution table can run to the size of the user base, and reading all
//     of it to slice off one page defeats the point of paging.
//
// user_id IS NOT NULL is applied to BOTH tables this joins, for two different
// reasons: food_resolution_outcomes.user_id is NOT NULL by constraint (its FK
// is ON DELETE CASCADE, so the predicate is a no-op there, kept for clarity),
// but ai_usage_events.user_id is nullable and genuinely holds NULL for two
// things that are not a person — a deleted user's retained usage row (#106)
// and the food-index backfill's system calls (#97). Grouping the join subquery
// by user_id WITHOUT that filter would fold every one of those NULL rows into
// one phantom "user" (SQL treats NULL as a single GROUP BY bucket), and with
// #97 alone that bucket runs to the thousands.
//
// ai_calls is windowed by the SAME [from, to] bound as the driving
// aggregate — the response reports the window back (kora#507: "two
// sections, one window parameter"), so every count on a row must be honest
// about being IN that window, not a lifetime total sitting next to windowed
// figures. It is still deliberately NOT filtered to outcome='ok', mirroring
// user.ListForAdmin's ai_calls column: it counts calls, not actions, because
// one user tap can emit several rows when a fallback leg is abandoned, and a
// success-only count would make a user who tried and failed look like a user
// who never tried.
func (r Repository) ListUserAIMetrics(ctx context.Context, q Query) (UserAIMetricsResult, error) {
	where := "user_id IS NOT NULL"
	args := make([]any, 0, 2)
	if !q.From.IsZero() {
		where += " AND created_at >= ?"
		args = append(args, q.From)
	}
	if !q.To.IsZero() {
		where += " AND created_at <= ?"
		args = append(args, q.To)
	}

	countSQL := fmt.Sprintf(`
		SELECT count(*) FROM (
			SELECT user_id FROM food_resolution_outcomes
			WHERE %s
			GROUP BY user_id
		) counted`, where)

	var total int64
	if err := r.db.WithContext(ctx).Raw(countSQL, args...).Scan(&total).Error; err != nil {
		return UserAIMetricsResult{}, fmt.Errorf("platformadmin: count ai-metrics users: %w", err)
	}

	listSQL := fmt.Sprintf(`
		SELECT o.user_id AS user_id,
		       o.attempts,
		       o.resolves,
		       o.corrections,
		       o.budget_refusals,
		       o.last_activity_at,
		       COALESCE(a.ai_calls, 0) AS ai_calls
		FROM (
			SELECT user_id,
			       count(*) AS attempts,
			       count(*) FILTER (WHERE kind = 'resolved') AS resolves,
			       count(*) FILTER (WHERE kind = 'alias') AS corrections,
			       count(*) FILTER (WHERE kind = 'budget') AS budget_refusals,
			       max(created_at) AS last_activity_at
			FROM food_resolution_outcomes
			WHERE %s
			GROUP BY user_id
		) o
		LEFT JOIN (
			SELECT user_id, count(*) AS ai_calls
			FROM ai_usage_events
			WHERE %s
			GROUP BY user_id
		) a ON a.user_id = o.user_id
		ORDER BY o.attempts DESC, o.user_id
		LIMIT ? OFFSET ?`, where, where)

	// args is used twice in listSQL — once for the driving aggregate's WHERE,
	// once for the ai_usage_events join's — so the arg slice must repeat
	// the same window bounds in the same order before the trailing
	// LIMIT/OFFSET pair.
	listArgs := append(append(append([]any{}, args...), args...), q.Limit, q.Offset())

	var rows []UserAIMetricsRow
	if err := r.db.WithContext(ctx).Raw(listSQL, listArgs...).Scan(&rows).Error; err != nil {
		return UserAIMetricsResult{}, fmt.Errorf("platformadmin: list ai-metrics users: %w", err)
	}

	return UserAIMetricsResult{Rows: rows, Total: total}, nil
}
