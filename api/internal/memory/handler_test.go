package memory

import (
	"context"
	"encoding/json"
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
