package admin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/foodlog"
)

// ---------------------------------------------------------------------------
// GetFood — the food detail behind the edit form and the delete confirmation.
// ---------------------------------------------------------------------------

// The edit form CANNOT be built without this endpoint: PATCH requires an
// updated_at precondition (rider 1), and ListFoods returns nutrition.FoodItem,
// which has no updated_at field at all. Reading the row twice from the list is
// not an option — there is nothing there to read.
func TestGetFoodReturnsTheUpdatedAtTheEditFormMustEcho(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	item := food("zzz-detail-oats", "Brand")
	require.NoError(t, tx.Create(&item).Error)
	id := item.ID

	got, err := NewRepository(tx).GetFood(context.Background(), id)
	require.NoError(t, err)

	assert.Equal(t, id, got.Food.ID)
	assert.Equal(t, "zzz-detail-oats", got.Food.Name)
	assert.False(t, got.Food.UpdatedAt.IsZero(), "updated_at is the PATCH precondition; a zero value makes editing impossible")
}

// The delete confirmation must show how many logs reference the food BEFORE
// retiring it (task-8 brief). The count is computed here, in SQL, precisely so
// the client never has to invent one.
func TestGetFoodCountsTheLogsReferencingIt(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	item := food("zzz-detail-counted", "Brand")
	require.NoError(t, tx.Create(&item).Error)
	id := item.ID

	userID := seedUser(t, tx)
	for i := 0; i < 3; i++ {
		require.NoError(t, tx.Create(&foodlog.FoodLog{
			UserID: userID, FoodItemID: &id, LoggedAt: time.Now().UTC(),
			MealSlot: "lunch", Source: "manual", Description: "zzz-detail-counted",
			QuantityGrams: 100, Kcal: 100,
		}).Error)
	}

	got, err := NewRepository(tx).GetFood(context.Background(), id)
	require.NoError(t, err)
	assert.Equal(t, int64(3), got.LogCount)
}

// The twin: a food nothing references reports 0, not a missing field and not
// an error. Without this, "counts the logs" would pass on a repository that
// returned the total number of logs in the table.
func TestGetFoodReportsZeroLogsForAnUnreferencedFood(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	lonelyItem, otherItem := food("zzz-detail-lonely", "Brand"), food("zzz-detail-other", "Brand")
	require.NoError(t, tx.Create(&lonelyItem).Error)
	require.NoError(t, tx.Create(&otherItem).Error)
	lonely, other := lonelyItem.ID, otherItem.ID

	userID := seedUser(t, tx)
	require.NoError(t, tx.Create(&foodlog.FoodLog{
		UserID: userID, FoodItemID: &other, LoggedAt: time.Now().UTC(),
		MealSlot: "lunch", Source: "manual", Description: "other", QuantityGrams: 100, Kcal: 100,
	}).Error)

	got, err := NewRepository(tx).GetFood(context.Background(), lonely)
	require.NoError(t, err)
	assert.Equal(t, int64(0), got.LogCount, "the count must be scoped to THIS food, not the whole table")
}

// GetFood is deliberately NOT live-only. An already-retired food must still be
// loadable so the audit page can show what was retired, and so a stale portal
// tab lands on "this food is retired" instead of a bare 404. deleted_at is on
// the response, so the caller can tell the difference — the same reasoning as
// rider 3.
func TestGetFoodLoadsAnAlreadyRetiredFoodAndSaysSo(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	item := food("zzz-detail-retired", "Brand")
	require.NoError(t, tx.Create(&item).Error)
	id := item.ID
	require.NoError(t, tx.Exec("UPDATE food_items SET deleted_at = now() WHERE id = ?", id).Error)

	got, err := NewRepository(tx).GetFood(context.Background(), id)
	require.NoError(t, err)
	require.NotNil(t, got.Food.DeletedAt, "a retired food must be loadable AND legible as retired")
}

func TestGetFoodReturnsRecordNotFoundForAnUnknownID(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)

	_, err := NewRepository(tx).GetFood(context.Background(), uuid.New())
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
}

// ---------------------------------------------------------------------------
// ListEvents — the audit page (task 9).
// ---------------------------------------------------------------------------

func seedEvent(t *testing.T, tx *gorm.DB, action string, target *uuid.UUID, at time.Time) {
	t.Helper()
	require.NoError(t, tx.Exec(
		`INSERT INTO kora_admin_events (actor_id, actor_email, action, target_type, target_id, before, after, created_at)
		 VALUES (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)`,
		"admin-uid-1", "admin@tesserix.app", action, TargetTypeFood, target,
		`{"name":"before"}`, `{"name":"after"}`, at,
	).Error)
}

// Newest-first is the whole point of an audit page: the thing an operator
// needs is what just happened. Asserted with three rows whose insertion order
// deliberately does NOT match their created_at order, so a repository that
// simply returned insertion order would fail.
func TestListEventsReturnsNewestFirst(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	base := time.Now().UTC()
	id := uuid.New()
	seedEvent(t, tx, ActionFoodUpdated, &id, base.Add(-2*time.Hour))
	seedEvent(t, tx, ActionFoodDeleted, &id, base)
	seedEvent(t, tx, ActionFoodCreated, &id, base.Add(-1*time.Hour))

	got, err := NewRepository(tx).ListEvents(context.Background(), EventListParams{TargetID: &id})
	require.NoError(t, err)
	require.Len(t, got.Items, 3)
	assert.Equal(t, ActionFoodDeleted, got.Items[0].Action)
	assert.Equal(t, ActionFoodCreated, got.Items[1].Action)
	assert.Equal(t, ActionFoodUpdated, got.Items[2].Action)
}

// Total counts MATCHES, not the page — the same contract ListFoods documents,
// so the portal can render "showing 2 of 3".
func TestListEventsTotalCountsMatchesNotThePage(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	id := uuid.New()
	base := time.Now().UTC()
	for i := 0; i < 3; i++ {
		seedEvent(t, tx, ActionFoodUpdated, &id, base.Add(-time.Duration(i)*time.Minute))
	}

	got, err := NewRepository(tx).ListEvents(context.Background(), EventListParams{TargetID: &id, Limit: 2})
	require.NoError(t, err)
	assert.Len(t, got.Items, 2, "the page is bounded by Limit")
	assert.Equal(t, int64(3), got.Total, "Total must report matches, not the page length")
}

// The before/after snapshots are the audit trail's actual content — an events
// list that dropped them would look complete and be useless. Asserted as
// parsed JSON, not as a non-empty string, so a repository returning the
// literal text "null" would fail.
func TestListEventsCarriesTheBeforeAndAfterSnapshots(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	id := uuid.New()
	seedEvent(t, tx, ActionFoodUpdated, &id, time.Now().UTC())

	got, err := NewRepository(tx).ListEvents(context.Background(), EventListParams{TargetID: &id})
	require.NoError(t, err)
	require.Len(t, got.Items, 1)

	var before, after map[string]any
	require.NoError(t, json.Unmarshal(got.Items[0].Before, &before))
	require.NoError(t, json.Unmarshal(got.Items[0].After, &after))
	assert.Equal(t, "before", before["name"])
	assert.Equal(t, "after", after["name"])
	assert.Equal(t, "admin@tesserix.app", got.Items[0].ActorEmail)
}

// Filtering by target is what makes "history for THIS food" possible on the
// detail page. Seeds a second target so an unfiltered query would return both.
func TestListEventsFiltersByTarget(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	mine, theirs := uuid.New(), uuid.New()
	now := time.Now().UTC()
	seedEvent(t, tx, ActionFoodUpdated, &mine, now)
	seedEvent(t, tx, ActionFoodUpdated, &theirs, now)

	got, err := NewRepository(tx).ListEvents(context.Background(), EventListParams{TargetID: &mine})
	require.NoError(t, err)
	require.Len(t, got.Items, 1)
	require.NotNil(t, got.Items[0].TargetID)
	assert.Equal(t, mine, *got.Items[0].TargetID)
	assert.Equal(t, int64(1), got.Total, "Total must respect the filter too, not count every event")
}

// Paging must be STABLE. created_at is not unique — the three mutations behind
// a single portal action can land inside the same clock tick — so an ORDER BY
// on it alone lets a row repeat on one page and vanish from the next.
//
// Asserting "the two pages do not overlap" is NOT enough to detect a missing
// tiebreaker: with a small table Postgres returns heap order consistently, so
// the pages happen not to overlap even with an unstable sort, and the test
// passes while the bug is present (verified by mutation — it survived).
//
// So this asserts the ORDER instead, and rigs it to be deterministic: the rows
// all share one created_at and are INSERTED IN ASCENDING ID ORDER, so heap
// order is ascending. A correct `created_at DESC, id DESC` must return them
// descending — the exact reverse of the order a tiebreaker-less query yields.
func TestListEventsOrdersByIDWhenCreatedAtTies(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	target := uuid.New()
	same := time.Now().UTC()

	ids := make([]uuid.UUID, 6)
	for i := range ids {
		ids[i] = uuid.New()
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
	for _, id := range ids {
		require.NoError(t, tx.Exec(
			`INSERT INTO kora_admin_events (id, actor_id, actor_email, action, target_type, target_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			id, "admin-uid-1", "admin@tesserix.app", ActionFoodUpdated, TargetTypeFood, target, same,
		).Error)
	}

	got, err := NewRepository(tx).ListEvents(context.Background(), EventListParams{TargetID: &target})
	require.NoError(t, err)
	require.Len(t, got.Items, 6)

	gotIDs := make([]string, len(got.Items))
	for i, e := range got.Items {
		gotIDs[i] = e.ID.String()
	}
	want := make([]string, len(ids))
	for i, id := range ids {
		want[len(ids)-1-i] = id.String()
	}
	assert.Equal(t, want, gotIDs, "tied created_at must fall back to a DESCENDING id, or paging is unstable")
}

// The consequence the ordering above exists to prevent, asserted directly:
// two consecutive pages must cover every row exactly once.
func TestListEventsPagesCoverEveryRowExactlyOnce(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	id := uuid.New()
	same := time.Now().UTC()
	for i := 0; i < 6; i++ {
		seedEvent(t, tx, ActionFoodUpdated, &id, same)
	}

	repo := NewRepository(tx)
	first, err := repo.ListEvents(context.Background(), EventListParams{TargetID: &id, Limit: 3, Offset: 0})
	require.NoError(t, err)
	second, err := repo.ListEvents(context.Background(), EventListParams{TargetID: &id, Limit: 3, Offset: 3})
	require.NoError(t, err)

	seen := map[uuid.UUID]bool{}
	for _, e := range append(append([]AdminEvent{}, first.Items...), second.Items...) {
		require.False(t, seen[e.ID], "row %s appeared on both pages", e.ID)
		seen[e.ID] = true
	}
	assert.Len(t, seen, 6, "paging must cover every row exactly once")
}

func TestListEventsClampsItsLimitLikeListFoods(t *testing.T) {
	assert.Equal(t, DefaultLimit, clampLimit(0))
	assert.Equal(t, MaxLimit, clampLimit(MaxLimit+1))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

type fakeReader struct {
	detail    FoodDetail
	detailErr error
	gotID     uuid.UUID

	events    EventListResult
	eventsErr error
	gotParams EventListParams
	calls     int
}

func (f *fakeReader) ListFoods(context.Context, ListParams) (ListResult, error) {
	return ListResult{}, nil
}

func (f *fakeReader) GetFood(_ context.Context, id uuid.UUID) (FoodDetail, error) {
	f.calls++
	f.gotID = id
	return f.detail, f.detailErr
}

func (f *fakeReader) ListEvents(_ context.Context, p EventListParams) (EventListResult, error) {
	f.calls++
	f.gotParams = p
	return f.events, f.eventsErr
}

func readerRouter(r FoodReader) *gin.Engine {
	gin.SetMode(gin.TestMode)
	e := gin.New()
	h := NewHandler(r, nil)
	e.GET("/v1/admin/foods/:id", h.GetFood)
	e.GET("/v1/admin/events", h.ListEvents)
	return e
}

func TestGetFoodHandlerReturnsTheDetailEnvelope(t *testing.T) {
	id := uuid.New()
	now := time.Now().UTC()
	f := &fakeReader{detail: FoodDetail{
		Food:     FoodSnapshot{ID: id, Name: "oats", UpdatedAt: now},
		LogCount: 7,
	}}

	w := httptest.NewRecorder()
	readerRouter(f).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods/"+id.String(), nil))

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, id, f.gotID)

	var body struct {
		Data FoodDetail `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Equal(t, "oats", body.Data.Food.Name)
	assert.Equal(t, int64(7), body.Data.LogCount)
	// Pinned as literal keys: the portal reads these off the wire, so a
	// renamed tag must fail here rather than round-trip invisibly.
	assert.Contains(t, w.Body.String(), `"log_count":7`)
	assert.Contains(t, w.Body.String(), `"updated_at"`)
}

func TestGetFoodHandlerMapsRecordNotFoundTo404(t *testing.T) {
	f := &fakeReader{detailErr: gorm.ErrRecordNotFound}
	w := httptest.NewRecorder()
	readerRouter(f).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods/"+uuid.New().String(), nil))
	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestGetFoodHandlerRejectsAMalformedID(t *testing.T) {
	f := &fakeReader{}
	w := httptest.NewRecorder()
	readerRouter(f).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods/not-a-uuid", nil))
	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Zero(t, f.calls, "a rejected request must never reach the repository")
}

func TestListEventsHandlerPassesPagingAndTargetThrough(t *testing.T) {
	target := uuid.New()
	f := &fakeReader{events: EventListResult{Items: []AdminEvent{{Action: ActionFoodDeleted}}, Total: 1}}

	w := httptest.NewRecorder()
	readerRouter(f).ServeHTTP(w, httptest.NewRequest(http.MethodGet,
		"/v1/admin/events?limit=10&offset=20&target_id="+target.String(), nil))

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, 10, f.gotParams.Limit)
	assert.Equal(t, 20, f.gotParams.Offset)
	require.NotNil(t, f.gotParams.TargetID)
	assert.Equal(t, target, *f.gotParams.TargetID)
}

func TestListEventsHandlerTreatsAnAbsentTargetAsUnfiltered(t *testing.T) {
	f := &fakeReader{}
	w := httptest.NewRecorder()
	readerRouter(f).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/events", nil))

	require.Equal(t, http.StatusOK, w.Code)
	assert.Nil(t, f.gotParams.TargetID, "no target_id means every event, not a zero-UUID filter that matches nothing")
}

func TestListEventsHandlerRejectsAMalformedTargetID(t *testing.T) {
	f := &fakeReader{}
	w := httptest.NewRecorder()
	readerRouter(f).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/events?target_id=nope", nil))

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Zero(t, f.calls, "a rejected request must never reach the repository")
}

// Same guard the food index has: a nil slice must serialise as [] and never
// null, because the audit page maps over it.
func TestListEventsHandlerNeverSerialisesItemsAsNull(t *testing.T) {
	f := &fakeReader{events: EventListResult{Items: nil, Total: 0}}
	w := httptest.NewRecorder()
	readerRouter(f).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/events", nil))

	require.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), `"items":[]`)
}

// assertErr stands in for any infrastructure failure. Its message is asserted
// as ABSENT from every response body below — internal detail must not reach
// the client.
var assertErr = errors.New("boom: dial tcp 10.0.0.5:5432: connect: connection refused")

func TestReadHandlersReportRepositoryFailureAs500(t *testing.T) {
	f := &fakeReader{detailErr: assertErr, eventsErr: assertErr}

	w := httptest.NewRecorder()
	readerRouter(f).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods/"+uuid.New().String(), nil))
	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.NotContains(t, w.Body.String(), "boom")

	w = httptest.NewRecorder()
	readerRouter(f).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/events", nil))
	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.NotContains(t, w.Body.String(), "boom")
}
