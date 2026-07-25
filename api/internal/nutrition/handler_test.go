package nutrition

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestFoodsEndpointReturnsCandidates(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2a'") })

	// Unique nonce token (same technique as TestResolveFullTextRanksByName
	// in resolve_test.go) keeps this deterministic regardless of whatever
	// else is in the shared food index, so ranking can't pick a different
	// row first.
	nonce := "zqxfoodep" + uuid.NewString()[:8]
	name := "Grilled chicken breast " + nonce
	_, err := repo.Insert(context.Background(), []FoodItem{
		{Name: name, Brand: "test2a", Provenance: ProvenanceAFCD, KcalPer100g: 165},
	})
	require.NoError(t, err)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/foods", NewHandler(repo).Search)
	req := httptest.NewRequest(http.MethodGet, "/foods?q="+nonce, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Data []Candidate `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.NotEmpty(t, body.Data)
	require.Equal(t, name, body.Data[0].Item.Name)
}
