package admin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
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

func handlerRouter(l FoodLister) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/v1/admin/foods", NewHandler(l).ListFoods)
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
func TestListFoodsHandlerReturns200ForAnEmptyIndex(t *testing.T) {
	l := &fakeLister{result: ListResult{Items: []nutrition.FoodItem{}, Total: 0}}
	w := httptest.NewRecorder()
	handlerRouter(l).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/foods", nil))

	require.Equal(t, http.StatusOK, w.Code)
	// items must serialise as [] and never null — the page maps over it.
	assert.Contains(t, w.Body.String(), `"items":[]`)
}
