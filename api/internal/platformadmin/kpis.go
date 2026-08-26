package platformadmin

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
)

// KPIsHandler serves GET /admin/kpis.
type KPIsHandler struct{}

// NewKPIsHandler builds the handler.
func NewKPIsHandler() *KPIsHandler { return &KPIsHandler{} }

// KPIs handles GET /admin/kpis with a deliberate 501.
//
// §3.1 gives two legitimate answers and forbids a third. Kora returns
// `501 not_implemented`, so the console renders "not instrumented" rather
// than a tile of em-dashes that reads as zero activity — the exact
// misreading the contract cites dwellm8 for.
//
// This is a decision, not a stub, and the distinction matters to whoever
// reads this next:
//
//   - `{}` and a map of zeroes are BOTH forbidden. A zero here would claim
//     Kora measured something and found none of it.
//   - Kora is pre-launch. The honest headline numbers during R6 are about
//     the beta — active testers, meals logged, resolutions that failed — and
//     #43 is the issue that decides which of those Kora considers headline.
//     Choosing them here, ahead of #43, would mean the console renders
//     whatever was convenient to query rather than what anyone decided.
//   - Two of the candidate numbers are not even computable yet: nothing
//     persists a resolution outcome (see inbox.go and health.go), so
//     "resolutions that failed" has no source.
//
// When #43 lands this becomes a thin projection over it, and the shape to
// copy is mark8ly's KPIRegistry — a declared key list driving both the 200
// and the 501, so a key can never be silently dropped. Do not add a value
// here without adding that registry with it.
func (h *KPIsHandler) KPIs(c *gin.Context) {
	httpx.Error(c, http.StatusNotImplemented, "not_implemented",
		"kora does not report business KPIs yet")
}

// Ensure the handler satisfies gin's expectations at compile time rather than
// at route registration.
var _ gin.HandlerFunc = (*KPIsHandler)(nil).KPIs
