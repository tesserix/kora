package feedback

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// adminRouter wires AdminHandler's List/UpdateStatus routes with no auth
// middleware — bffauth is Task 4's concern, not this handler's.
func adminRouter(h AdminHandler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/v1/admin/feedback", h.List)
	r.PATCH("/v1/admin/feedback/:id", h.UpdateStatus)
	return r
}

// seedAdminFeedback wraps reads_test.go's seedFeedback and returns the full
// row, since these handler tests need the row's id and current status rather
// than just the id.
func seedAdminFeedback(t *testing.T, db *gorm.DB, userID uuid.UUID, kind Kind, status Status) Feedback {
	t.Helper()
	id := seedFeedback(t, db, userID, kind, status, "subject", time.Now())
	var f Feedback
	require.NoError(t, db.First(&f, "id = ?", id).Error)
	return f
}

// ---------------------------------------------------------------------------
// GET /v1/admin/feedback
// ---------------------------------------------------------------------------

func TestAdminList_NoFiltersReturnsEnvelope(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	seedAdminFeedback(t, db, userID, KindBug, StatusOpen)
	repo := NewRepository(db)
	router := adminRouter(NewAdminHandler(repo))

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/feedback", nil))

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var body struct {
		Data struct {
			Items []Item `json:"items"`
			Total int64  `json:"total"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.GreaterOrEqual(t, len(body.Data.Items), 1)
	require.GreaterOrEqual(t, body.Data.Total, int64(1))
}

func TestAdminList_StatusFilters(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	seedAdminFeedback(t, db, userID, KindBug, StatusOpen)
	closed := seedAdminFeedback(t, db, userID, KindBug, StatusClosed)
	repo := NewRepository(db)
	router := adminRouter(NewAdminHandler(repo))

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/feedback?status=closed", nil))

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var body struct {
		Data struct {
			Items []Item `json:"items"`
			Total int64  `json:"total"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	for _, it := range body.Data.Items {
		require.Equal(t, StatusClosed, it.Status)
	}
	found := false
	for _, it := range body.Data.Items {
		if it.ID == closed.ID {
			found = true
		}
	}
	require.True(t, found, "the closed row must be present in the filtered result")
}

// TestAdminList_UnrecognisedStatusIs400 pins the specific defect this
// endpoint exists to avoid: an unrecognised filter value must never be
// silently ignored and return an unfiltered 200 — the operator would believe
// they are looking at a filtered list and be wrong.
func TestAdminList_UnrecognisedStatusIs400(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	router := adminRouter(NewAdminHandler(repo))

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/feedback?status=nonsense", nil))

	require.Equal(t, http.StatusBadRequest, w.Code)
	var body struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "invalid_input", body.Error)
}

func TestAdminList_KindFilters(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	seedAdminFeedback(t, db, userID, KindFeature, StatusOpen)
	bug := seedAdminFeedback(t, db, userID, KindBug, StatusOpen)
	repo := NewRepository(db)
	router := adminRouter(NewAdminHandler(repo))

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/feedback?kind=bug", nil))

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var body struct {
		Data struct {
			Items []Item `json:"items"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	for _, it := range body.Data.Items {
		require.Equal(t, KindBug, it.Kind)
	}
	found := false
	for _, it := range body.Data.Items {
		if it.ID == bug.ID {
			found = true
		}
	}
	require.True(t, found)
}

func TestAdminList_UnrecognisedKindIs400(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	router := adminRouter(NewAdminHandler(repo))

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/feedback?kind=nonsense", nil))

	require.Equal(t, http.StatusBadRequest, w.Code)
	var body struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "invalid_input", body.Error)
}

func TestAdminList_MalformedLimitIs400(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	router := adminRouter(NewAdminHandler(repo))

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/feedback?limit=abc", nil))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestAdminList_NegativeLimitIs400(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	router := adminRouter(NewAdminHandler(repo))

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/feedback?limit=-1", nil))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestAdminList_NegativeOffsetIs400(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	router := adminRouter(NewAdminHandler(repo))

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/feedback?offset=-1", nil))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

// TestAdminList_OversizedLimitClampsNotErrors pins the distinction the brief
// calls out: limit=500 is NOT the same defect as status=nonsense. It is a
// legitimate value that gets clamped to MaxLimit, not rejected.
func TestAdminList_OversizedLimitClampsNotErrors(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	router := adminRouter(NewAdminHandler(repo))

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/admin/feedback?limit=500", nil))

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var body struct {
		Data struct {
			Items []Item `json:"items"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.LessOrEqual(t, len(body.Data.Items), MaxLimit)
}

// ---------------------------------------------------------------------------
// PATCH /v1/admin/feedback/:id
// ---------------------------------------------------------------------------

func doPatch(router *gin.Engine, id string, payload map[string]any) *httptest.ResponseRecorder {
	body, _ := json.Marshal(payload)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/v1/admin/feedback/"+id, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)
	return w
}

func TestAdminUpdateStatus_SetsStatusAndReturnsRow(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedAdminFeedback(t, db, userID, KindBug, StatusOpen)
	repo := NewRepository(db)
	router := adminRouter(NewAdminHandler(repo))

	w := doPatch(router, f.ID.String(), map[string]any{"status": "in_progress"})

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var body struct {
		Data Feedback `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, StatusInProgress, body.Data.Status)

	var got Feedback
	require.NoError(t, db.First(&got, "id = ?", f.ID).Error)
	require.Equal(t, StatusInProgress, got.Status)
}

// TestAdminUpdateStatus_InvalidStatusLeavesRowUnchanged re-reads the row
// rather than trusting the response code alone: a handler that wrote first
// and validated second would pass a status-code-only assertion while
// corrupting data.
func TestAdminUpdateStatus_InvalidStatusLeavesRowUnchanged(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedAdminFeedback(t, db, userID, KindBug, StatusOpen)
	repo := NewRepository(db)
	router := adminRouter(NewAdminHandler(repo))

	w := doPatch(router, f.ID.String(), map[string]any{"status": "nonsense"})

	require.Equal(t, http.StatusBadRequest, w.Code)
	var body struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "invalid_input", body.Error)

	var got Feedback
	require.NoError(t, db.First(&got, "id = ?", f.ID).Error)
	require.Equal(t, StatusOpen, got.Status, "an invalid status must never reach the database")
}

func TestAdminUpdateStatus_UnknownUUIDIs404(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	router := adminRouter(NewAdminHandler(repo))

	w := doPatch(router, uuid.New().String(), map[string]any{"status": "closed"})
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
}

func TestAdminUpdateStatus_NonUUIDIdIs400NotNotFound(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	router := adminRouter(NewAdminHandler(repo))

	w := doPatch(router, "not-a-uuid", map[string]any{"status": "closed"})
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.NotEqual(t, http.StatusNotFound, w.Code)
}
