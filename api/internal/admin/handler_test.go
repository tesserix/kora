package admin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
)

type fakeLister struct {
	got    ListParams
	result ListResult
	err    error
}

func (f *fakeLister) ListFoods(_ context.Context, p ListParams) (ListResult, error) {
	f.got = p
	return f.result, f.err
}

// fakeLister satisfies the whole FoodReader surface so the list tests below
// keep exercising ONLY ListFoods. These two are never called by them; they
// exist because Handler depends on the full read interface.
func (f *fakeLister) GetFood(context.Context, uuid.UUID) (FoodDetail, error) {
	return FoodDetail{}, errors.New("fakeLister: GetFood is not part of these tests")
}

func (f *fakeLister) ListEvents(context.Context, EventListParams) (EventListResult, error) {
	return EventListResult{}, errors.New("fakeLister: ListEvents is not part of these tests")
}

func handlerRouter(l FoodReader) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/v1/admin/foods", NewHandler(l, nil).ListFoods)
	return r
}

func TestListFoodsHandlerPassesQueryAndPagingThrough(t *testing.T) {
	l := &fakeLister{result: ListResult{Items: []nutrition.FoodItem{{Name: "oats"}}, Total: 1}}
	w := httptest.NewRecorder()
	handlerRouter(l).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods?q=oats&limit=10&offset=20", nil))

	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, ListParams{Query: "oats", Limit: 10, Offset: 20}, l.got)

	var body struct {
		Data ListResult `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Equal(t, int64(1), body.Data.Total)
	require.Len(t, body.Data.Items, 1)
	assert.Equal(t, "oats", body.Data.Items[0].Name)

	// Unmarshalling into ListResult round-trips the "total" JSON tag
	// invisibly even if the tag were renamed — the portal reads data.total
	// directly off the wire, so pin the literal key here.
	assert.Contains(t, w.Body.String(), `"total":1`)
}

// The twin for the test above: absent params must NOT silently become the
// values of a previous request or a hardcoded default that differs from the
// repository's. Zero means "unset" and the repository applies its own default.
func TestListFoodsHandlerDefaultsMissingParamsToZero(t *testing.T) {
	l := &fakeLister{}
	w := httptest.NewRecorder()
	handlerRouter(l).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods", nil))

	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, ListParams{Query: "", Limit: 0, Offset: 0}, l.got)
}

func TestListFoodsHandlerRejectsNonNumericLimit(t *testing.T) {
	l := &fakeLister{}
	w := httptest.NewRecorder()
	handlerRouter(l).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods?limit=abc", nil))

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Equal(t, ListParams{}, l.got, "a rejected request must never reach the repository")
}

func TestListFoodsHandlerRejectsNegativeOffset(t *testing.T) {
	l := &fakeLister{}
	w := httptest.NewRecorder()
	handlerRouter(l).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods?offset=-5", nil))

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Equal(t, ListParams{}, l.got)
}

// An infrastructure failure must be a 500, never an empty 200. An empty list
// renders as "no foods found", which reads as a fact about the index rather
// than a fault — the same class of silent failure this project keeps hitting.
func TestListFoodsHandlerReportsRepositoryFailureAs500(t *testing.T) {
	l := &fakeLister{err: errors.New("connection refused")}
	w := httptest.NewRecorder()
	handlerRouter(l).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods", nil))

	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.NotContains(t, w.Body.String(), "connection refused", "internal detail must not reach the client")
}

// The twin: an EMPTY index is a legitimate 200 with an empty list, not a 500.
// The fixture uses a nil slice (not an already-non-nil empty one) because
// GORM isn't the only thing that can produce a ListResult: a future
// FoodLister — a cache decorator, a stub, a hand-built ListResult{} — can
// leave Items nil, and Go's encoding/json serialises a nil slice as `null`,
// which would crash the portal page that maps over it. This is what
// actually exercises the handler's nil-to-[] guard.
func TestListFoodsHandlerReturns200ForAnEmptyIndex(t *testing.T) {
	l := &fakeLister{result: ListResult{Items: nil, Total: 0}}
	w := httptest.NewRecorder()
	handlerRouter(l).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods", nil))

	require.Equal(t, http.StatusOK, w.Code)
	// items must serialise as [] and never null — the page maps over it.
	assert.Contains(t, w.Body.String(), `"items":[]`)
}
