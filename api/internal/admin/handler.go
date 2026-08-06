package admin

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
)

type Handler struct {
	foods     FoodReader
	mutations FoodMutator
}

// NewHandler takes both surfaces rather than exposing a second constructor
// for the mutation half: two constructors would let router.go wire the read
// side and forget the write side, and the resulting 500s would only appear
// on the first mutation attempt in production.
func NewHandler(foods FoodReader, mutations FoodMutator) Handler {
	return Handler{foods: foods, mutations: mutations}
}

// ListFoods serves GET /v1/admin/foods?q=&limit=&offset=.
//
// Unset limit/offset are passed through as zero rather than defaulted here, so
// there is exactly ONE place that decides what a page is (the repository). Two
// defaulting sites drift.
func (h Handler) ListFoods(c *gin.Context) {
	limit, err := intParam(c, "limit")
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "limit must be a non-negative integer")
		return
	}
	offset, err := intParam(c, "offset")
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "offset must be a non-negative integer")
		return
	}

	result, err := h.foods.ListFoods(c.Request.Context(), ListParams{
		Query:  c.Query("q"),
		Limit:  limit,
		Offset: offset,
	})
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	// Never let a nil slice serialise as null: the portal page maps over it.
	if result.Items == nil {
		result.Items = []nutrition.FoodItem{}
	}
	httpx.OK(c, result)
}

func intParam(c *gin.Context, name string) (int, error) {
	raw := c.Query(name)
	if raw == "" {
		return 0, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, err
	}
	if v < 0 {
		return 0, strconv.ErrRange
	}
	return v, nil
}
