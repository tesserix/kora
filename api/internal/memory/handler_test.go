package memory

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/tesserix/kora/api/internal/foodlog"
)

type fakeLogs struct{ logs []foodlog.FoodLog }

func (f fakeLogs) ListForUserSince(_ context.Context, _ uuid.UUID, _ time.Time) ([]foodlog.FoodLog, error) {
	return f.logs, nil
}

// errBadLogs is a LogSource fake that always fails, to exercise the handler's
// RespondServiceError branch (infra errors map to 500).
type errBadLogs struct{}

func (errBadLogs) ListForUserSince(_ context.Context, _ uuid.UUID, _ time.Time) ([]foodlog.FoodLog, error) {
	return nil, errors.New("boom")
}

func TestGetMemoryReturnsSections(t *testing.T) {
	gin.SetMode(gin.TestMode)
	base := time.Now().Add(-24 * time.Hour)
	svc := NewService(fakeLogs{logs: []foodlog.FoodLog{log(eggs, "Eggs", "breakfast", 100, 155, base)}})
	h := NewHandler(svc)

	r := gin.New()
	r.GET("/v1/memory", func(c *gin.Context) {
		c.Set("user_id", uuid.New()) // match the key/type user.IDFromContext reads
		h.Get(c)
	})
	req, _ := http.NewRequest(http.MethodGet, "/v1/memory", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200 got %d", w.Code)
	}
	var body Memory
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Recents) != 1 {
		t.Fatalf("want 1 recent, got %d", len(body.Recents))
	}
}

func TestGetMemoryMissingUserIDReturns401(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc := NewService(fakeLogs{})
	h := NewHandler(svc)

	r := gin.New()
	r.GET("/v1/memory", func(c *gin.Context) {
		// deliberately not setting "user_id" in context
		h.Get(c)
	})
	req, _ := http.NewRequest(http.MethodGet, "/v1/memory", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401 got %d", w.Code)
	}
}

func TestGetMemoryBuildErrorReturns500(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc := NewService(errBadLogs{})
	h := NewHandler(svc)

	r := gin.New()
	r.GET("/v1/memory", func(c *gin.Context) {
		c.Set("user_id", uuid.New()) // match the key/type user.IDFromContext reads
		h.Get(c)
	})
	req, _ := http.NewRequest(http.MethodGet, "/v1/memory", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500 got %d", w.Code)
	}
}
