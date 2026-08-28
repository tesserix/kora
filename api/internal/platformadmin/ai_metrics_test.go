package platformadmin

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/resolveoutcome"
)

// ---------- handler unit tests (stubbed sources, no database) ----------

type stubRates struct {
	rates          resolveoutcome.Rates
	err            error
	gotFrom, gotTo time.Time
}

func (s *stubRates) Between(_ context.Context, from, to time.Time) (resolveoutcome.Rates, error) {
	s.gotFrom, s.gotTo = from, to
	return s.rates, s.err
}

type stubUserMetrics struct {
	result UserAIMetricsResult
	err    error
	got    Query
}

func (s *stubUserMetrics) ListUserAIMetrics(_ context.Context, q Query) (UserAIMetricsResult, error) {
	s.got = q
	return s.result, s.err
}

func newAIMetricsHandler(rates *stubRates, users *stubUserMetrics) *AIMetricsHandler {
	h := &AIMetricsHandler{rates: rates, users: users, now: time.Now}
	return h
}

// TestAIMetricsByKindZeroFillsAbsentKinds — resolveoutcome.Rates.ByKind omits
// any kind that did not occur, and its own doc comment says a caller
// rendering a fixed set must supply the zeroes itself. A kind silently
// missing from the console's chart is the exact failure this guards.
func TestAIMetricsByKindZeroFillsAbsentKinds(t *testing.T) {
	rates := &stubRates{rates: resolveoutcome.Rates{
		Attempts: 3,
		ByKind:   map[resolveoutcome.Kind]int64{resolveoutcome.KindResolved: 3},
		FirstTry: 3,
	}}
	h := newAIMetricsHandler(rates, &stubUserMetrics{})

	rec := call(t, http.MethodGet, "/admin/ai-metrics", "/admin/ai-metrics", h.Metrics)
	require.Equal(t, http.StatusOK, rec.Code)

	byKind := decode(t, rec)["data"].(map[string]any)["outcomes"].(map[string]any)["by_kind"].(map[string]any)
	require.Len(t, byKind, len(resolveoutcome.AllKinds), "all ten kinds must be present")
	for _, k := range resolveoutcome.AllKinds {
		if k == resolveoutcome.KindResolved {
			assert.Equal(t, float64(3), byKind[string(k)])
			continue
		}
		assert.Equal(t, float64(0), byKind[string(k)], "kind %q must be zero-filled, not absent", k)
	}
}

// TestAIMetricsEmptyWindowOmitsFirstTryRate asserts on the raw JSON bytes,
// per the brief: FirstTryRate's ok=false must make the field ABSENT, never
// present as 0.0. A rate rendered over no attempts would read as "the
// resolver failed every time", the opposite of "we measured nothing".
func TestAIMetricsEmptyWindowOmitsFirstTryRate(t *testing.T) {
	rates := &stubRates{rates: resolveoutcome.Rates{ByKind: map[resolveoutcome.Kind]int64{}}}
	h := newAIMetricsHandler(rates, &stubUserMetrics{})

	rec := call(t, http.MethodGet, "/admin/ai-metrics", "/admin/ai-metrics", h.Metrics)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.NotContains(t, rec.Body.String(), "first_try_rate_pct",
		"an empty window must not render the field at all, not even as 0.0")
}

// TestAIMetricsGenuineZeroRateRenders is the other half: omitempty on a
// *float64 omits only a nil pointer, so a REAL 0% (attempts happened, none
// were first-try) must still show up as a present 0.
func TestAIMetricsGenuineZeroRateRenders(t *testing.T) {
	rates := &stubRates{rates: resolveoutcome.Rates{
		Attempts: 5,
		ByKind:   map[resolveoutcome.Kind]int64{resolveoutcome.KindError: 5},
	}}
	h := newAIMetricsHandler(rates, &stubUserMetrics{})

	rec := call(t, http.MethodGet, "/admin/ai-metrics", "/admin/ai-metrics", h.Metrics)
	require.Equal(t, http.StatusOK, rec.Code)

	body := decode(t, rec)
	outcomes := body["data"].(map[string]any)["outcomes"].(map[string]any)
	pct, present := outcomes["first_try_rate_pct"]
	require.True(t, present, "a genuine 0%% rate must still be present in the JSON")
	assert.Equal(t, float64(0), pct)
}

// TestAIMetricsUsersEmptyIsAnArrayNotNull is §4.1: a nil slice marshals to
// null, which defeats a consumer's `?? []`.
func TestAIMetricsUsersEmptyIsAnArrayNotNull(t *testing.T) {
	h := newAIMetricsHandler(&stubRates{}, &stubUserMetrics{})

	rec := call(t, http.MethodGet, "/admin/ai-metrics", "/admin/ai-metrics", h.Metrics)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"users":[]`)
	assert.NotContains(t, rec.Body.String(), `"users":null`)
}

// TestAIMetricsEnvelopeShape is §4.1's block, exactly, plus the window and a
// populated user row rendered through stamp().
func TestAIMetricsEnvelopeShape(t *testing.T) {
	userID := uuid.New()
	lastActivity := time.Date(2026, 8, 27, 10, 0, 0, 0, time.UTC)
	users := &stubUserMetrics{result: UserAIMetricsResult{
		Total: 1,
		Rows: []UserAIMetricsRow{{
			UserID: userID, Attempts: 4, Resolves: 2, Corrections: 1,
			BudgetRefusals: 1, AICalls: 6, LastActivityAt: &lastActivity,
		}},
	}}
	h := newAIMetricsHandler(&stubRates{}, users)

	rec := call(t, http.MethodGet, "/admin/ai-metrics", "/admin/ai-metrics?limit=10&page=2", h.Metrics)
	require.Equal(t, http.StatusOK, rec.Code)

	body := decode(t, rec)
	data := body["data"].(map[string]any)
	require.Contains(t, data, "window")
	require.Contains(t, data, "outcomes")

	rows := data["users"].([]any)
	require.Len(t, rows, 1)
	row := rows[0].(map[string]any)
	assert.Equal(t, userID.String(), row["user_id"])
	assert.Equal(t, float64(4), row["attempts"])
	assert.Equal(t, float64(2), row["resolves"])
	assert.Equal(t, float64(1), row["corrections"])
	assert.Equal(t, float64(1), row["budget_refusals"])
	assert.Equal(t, float64(6), row["ai_calls"])
	assert.Equal(t, "2026-08-27T10:00:00Z", row["last_activity_at"], "§4.3: ISO 8601 UTC with offset")

	p := body["pagination"].(map[string]any)
	assert.Equal(t, float64(2), p["page"])
	assert.Equal(t, float64(10), p["limit"])
	assert.Equal(t, float64(1), p["total"])

	assert.Equal(t, 10, users.got.Limit)
	assert.Equal(t, 2, users.got.Page)
}

// TestAIMetricsDefaultsAWindowWhenNoneNamed — window.from/window.to must be
// concrete instants even when the caller names neither bound, because the
// response reports them back rather than merely filtering on them.
func TestAIMetricsDefaultsAWindowWhenNoneNamed(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	rates := &stubRates{}
	h := newAIMetricsHandler(rates, &stubUserMetrics{})
	h.now = func() time.Time { return now }

	rec := call(t, http.MethodGet, "/admin/ai-metrics", "/admin/ai-metrics", h.Metrics)
	require.Equal(t, http.StatusOK, rec.Code)

	window := decode(t, rec)["data"].(map[string]any)["window"].(map[string]any)
	assert.Equal(t, "2026-08-28T12:00:00Z", window["to"])
	assert.Equal(t, now.Add(-defaultAIMetricsWindow).Format(time.RFC3339), window["from"])
	assert.False(t, rates.gotFrom.IsZero())
	assert.Equal(t, now, rates.gotTo)
}

// TestAIMetricsHonoursExplicitFromAndTo proves an explicit window reaches
// both sources unmodified.
func TestAIMetricsHonoursExplicitFromAndTo(t *testing.T) {
	rates := &stubRates{}
	users := &stubUserMetrics{}
	h := newAIMetricsHandler(rates, users)

	rec := call(t, http.MethodGet, "/admin/ai-metrics",
		"/admin/ai-metrics?from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z", h.Metrics)
	require.Equal(t, http.StatusOK, rec.Code)

	want := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	wantTo := time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)
	assert.True(t, rates.gotFrom.Equal(want))
	assert.True(t, rates.gotTo.Equal(wantTo))
	assert.True(t, users.got.From.Equal(want))
	assert.True(t, users.got.To.Equal(wantTo))
}

func TestAIMetricsClampsAnOversizedLimit(t *testing.T) {
	users := &stubUserMetrics{}
	h := newAIMetricsHandler(&stubRates{}, users)

	call(t, http.MethodGet, "/admin/ai-metrics", "/admin/ai-metrics?limit=100000", h.Metrics)
	assert.Equal(t, MaxLimit, users.got.Limit)
}

// TestAIMetricsRatesFailureIsFiveHundred — a source failure must not leak the
// driver error, matching every other handler in this package.
func TestAIMetricsRatesFailureIsFiveHundred(t *testing.T) {
	rec := call(t, http.MethodGet, "/admin/ai-metrics", "/admin/ai-metrics",
		newAIMetricsHandler(&stubRates{err: errors.New("db down")}, &stubUserMetrics{}).Metrics)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, "internal_error", decode(t, rec)["error"])
	assert.NotContains(t, rec.Body.String(), "db down")
}

func TestAIMetricsUsersFailureIsFiveHundred(t *testing.T) {
	rec := call(t, http.MethodGet, "/admin/ai-metrics", "/admin/ai-metrics",
		newAIMetricsHandler(&stubRates{}, &stubUserMetrics{err: errors.New("db down")}).Metrics)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, "internal_error", decode(t, rec)["error"])
	assert.NotContains(t, rec.Body.String(), "db down")
}

// ---------- repository tests (live database) ----------

func seedOutcome(t *testing.T, txn *gorm.DB, userID uuid.UUID, kind resolveoutcome.Kind, createdAt time.Time) {
	t.Helper()
	require.NoError(t, txn.Exec(
		`INSERT INTO food_resolution_outcomes (id, user_id, kind, mode, created_at)
		 VALUES (?, ?, ?, 'text', ?)`,
		uuid.New(), userID, string(kind), createdAt).Error)
}

func seedAIUsageEvent(t *testing.T, txn *gorm.DB, userID *uuid.UUID, outcome string, createdAt time.Time) {
	t.Helper()
	require.NoError(t, txn.Exec(
		`INSERT INTO ai_usage_events (id, user_id, provider, model, call_type, outcome, created_at)
		 VALUES (?, ?, 'gemini', 'flash', 'resolve', ?, ?)`,
		uuid.New(), userID, outcome, createdAt).Error)
}

// TestListUserAIMetricsExcludesNullUserRows proves the ai_usage_events join
// subquery's `user_id IS NOT NULL` filter actually does its job: a NULL-user
// row (the food-index backfill's shape, #97) must not turn into a phantom
// user, and must not inflate a real user's ai_calls either.
func TestListUserAIMetricsExcludesNullUserRows(t *testing.T) {
	txn := tx(t, testDB(t))
	repo := repoOn(txn)
	now := time.Now().UTC()

	user := seedUser(t, txn, "ai-metrics-"+uuid.NewString()+"@kora.test", "Tester", "")
	seedOutcome(t, txn, user, resolveoutcome.KindResolved, now)

	// A successful call for the real user, and a NULL-user system call — the
	// user_id filter must keep the system row from leaking into the result
	// as its own phantom user or inflating the real one's ai_calls.
	seedAIUsageEvent(t, txn, &user, "ok", now)
	seedAIUsageEvent(t, txn, nil, "ok", now)

	result, err := repo.ListUserAIMetrics(context.Background(), Query{Limit: 50, Page: 1})
	require.NoError(t, err)

	require.Len(t, result.Rows, 1, "the NULL-user row must not appear as its own phantom user")
	assert.Equal(t, int64(1), result.Total)
	assert.Equal(t, user, result.Rows[0].UserID)
	assert.Equal(t, int64(1), result.Rows[0].AICalls, "must not be inflated by the NULL-user row")
}

// TestListUserAIMetricsAICallsIncludesFailedCalls is its own test, split out
// from TestListUserAIMetricsExcludesNullUserRows: that test asserts NULL-user
// exclusion, and hiding the outcome!='ok' inclusion rule behind it means
// whichever regression fires first masks the other.
//
// ai_calls deliberately does NOT filter to outcome='ok' — a user with AI
// calls and zero resolved foods is the most actionable row on this page, and
// a success-only count would erase them (mirrors user.ListForAdmin).
func TestListUserAIMetricsAICallsIncludesFailedCalls(t *testing.T) {
	txn := tx(t, testDB(t))
	repo := repoOn(txn)
	now := time.Now().UTC()

	user := seedUser(t, txn, "ai-metrics-failed-"+uuid.NewString()+"@kora.test", "Tester", "")
	seedOutcome(t, txn, user, resolveoutcome.KindResolved, now)
	seedAIUsageEvent(t, txn, &user, "error", now)

	result, err := repo.ListUserAIMetrics(context.Background(), Query{Limit: 50, Page: 1})
	require.NoError(t, err)

	require.Len(t, result.Rows, 1)
	assert.Equal(t, int64(1), result.Rows[0].AICalls, "a failed call must still be counted")
}

// TestListUserAIMetricsAICallsAreWindowed — every other column on the row
// obeys [from, to], and ai_calls must too: an ai_usage_events row outside
// the requested window must not be counted, or a console reading
// "attempts: 2, ai_calls: 900" alongside "window: {from, to}" would read 900
// as happening IN that window when it is a lifetime total.
func TestListUserAIMetricsAICallsAreWindowed(t *testing.T) {
	txn := tx(t, testDB(t))
	repo := repoOn(txn)
	now := time.Now().UTC()

	user := seedUser(t, txn, "ai-metrics-windowed-"+uuid.NewString()+"@kora.test", "Tester", "")
	seedOutcome(t, txn, user, resolveoutcome.KindResolved, now)
	seedAIUsageEvent(t, txn, &user, "ok", now)                    // in window
	seedAIUsageEvent(t, txn, &user, "ok", now.Add(-48*time.Hour)) // out of window

	result, err := repo.ListUserAIMetrics(context.Background(), Query{
		Limit: 50, Page: 1, From: now.Add(-time.Hour),
	})
	require.NoError(t, err)

	require.Len(t, result.Rows, 1)
	assert.Equal(t, int64(1), result.Rows[0].AICalls, "the out-of-window call must not be counted")
}

// TestListUserAIMetricsAttributesEachKindToItsOwnColumn seeds one row of
// each of resolved, alias, budget, plus a fourth kind that belongs in none
// of the three named columns — so a swapped or misspelled FILTER predicate
// (e.g. alias and budget transposed) fails this test rather than passing
// silently, which every prior test seeding only KindResolved could not
// catch.
func TestListUserAIMetricsAttributesEachKindToItsOwnColumn(t *testing.T) {
	txn := tx(t, testDB(t))
	repo := repoOn(txn)
	now := time.Now().UTC()

	user := seedUser(t, txn, "ai-metrics-attrib-"+uuid.NewString()+"@kora.test", "Tester", "")
	seedOutcome(t, txn, user, resolveoutcome.KindResolved, now)
	seedOutcome(t, txn, user, resolveoutcome.KindAlias, now)
	seedOutcome(t, txn, user, resolveoutcome.KindBudget, now)
	seedOutcome(t, txn, user, resolveoutcome.KindNoMatch, now) // counts toward attempts only

	result, err := repo.ListUserAIMetrics(context.Background(), Query{Limit: 50, Page: 1})
	require.NoError(t, err)

	require.Len(t, result.Rows, 1)
	row := result.Rows[0]
	assert.Equal(t, int64(4), row.Attempts, "every kind counts toward attempts")
	assert.Equal(t, int64(1), row.Resolves, "kind='resolved' only")
	assert.Equal(t, int64(1), row.Corrections, "kind='alias' only")
	assert.Equal(t, int64(1), row.BudgetRefusals, "kind='budget' only")
}

// TestListUserAIMetricsPagesInsideTheQuery — total must be the full,
// unpaged count, and the sort must be applied before the page boundary cuts
// the result, not after.
func TestListUserAIMetricsPagesInsideTheQuery(t *testing.T) {
	txn := tx(t, testDB(t))
	repo := repoOn(txn)
	now := time.Now().UTC()

	// Three users with distinct attempt counts, so ORDER BY attempts DESC has
	// something to prove.
	var users []uuid.UUID
	for i, attempts := range []int{1, 3, 2} {
		u := seedUser(t, txn, "ai-metrics-page-"+uuid.NewString()+"@kora.test", "Tester", "")
		users = append(users, u)
		for j := 0; j < attempts; j++ {
			seedOutcome(t, txn, u, resolveoutcome.KindResolved, now.Add(time.Duration(-i*10-j)*time.Minute))
		}
	}

	page1, err := repo.ListUserAIMetrics(context.Background(), Query{Limit: 2, Page: 1})
	require.NoError(t, err)
	assert.Equal(t, int64(3), page1.Total, "total is the full count, not the page length")
	require.Len(t, page1.Rows, 2)
	assert.Equal(t, int64(3), page1.Rows[0].Attempts, "highest attempts sorts first")
	assert.Equal(t, int64(2), page1.Rows[1].Attempts)

	page2, err := repo.ListUserAIMetrics(context.Background(), Query{Limit: 2, Page: 2})
	require.NoError(t, err)
	require.Len(t, page2.Rows, 1, "the remainder, cut inside the query")
	assert.Equal(t, int64(1), page2.Rows[0].Attempts)
}

// TestListUserAIMetricsWindowFiltersOutcomes proves the from/to bound is
// applied to the driving aggregate, not ignored.
func TestListUserAIMetricsWindowFiltersOutcomes(t *testing.T) {
	txn := tx(t, testDB(t))
	repo := repoOn(txn)
	now := time.Now().UTC()

	user := seedUser(t, txn, "ai-metrics-window-"+uuid.NewString()+"@kora.test", "Tester", "")
	seedOutcome(t, txn, user, resolveoutcome.KindResolved, now.Add(-48*time.Hour))
	seedOutcome(t, txn, user, resolveoutcome.KindResolved, now)

	result, err := repo.ListUserAIMetrics(context.Background(), Query{
		Limit: 50, Page: 1, From: now.Add(-time.Hour),
	})
	require.NoError(t, err)
	require.Len(t, result.Rows, 1)
	assert.Equal(t, int64(1), result.Rows[0].Attempts, "the 48h-old outcome must be excluded by the window")
}

// TestBetweenRespectsAnUpperBound proves resolveoutcome.Between actually
// bounds the top of the window rather than behaving exactly like Since.
func TestBetweenRespectsAnUpperBound(t *testing.T) {
	txn := tx(t, testDB(t))
	outcomes := resolveoutcome.NewRepository(txn)
	user := seedUser(t, txn, "ai-metrics-between-"+uuid.NewString()+"@kora.test", "Tester", "")
	now := time.Now().UTC()

	seedOutcome(t, txn, user, resolveoutcome.KindResolved, now.Add(-2*time.Hour))
	seedOutcome(t, txn, user, resolveoutcome.KindResolved, now)

	rates, err := outcomes.Between(context.Background(), now.Add(-3*time.Hour), now.Add(-time.Hour))
	require.NoError(t, err)
	assert.Equal(t, int64(1), rates.Attempts, "only the row inside [from, to] must count")
}
