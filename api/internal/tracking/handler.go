package tracking

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/guardrails"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/localday"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	repo Repository
	// signals is optional so every existing NewHandler caller (onboarding,
	// tests) compiles unchanged. A nil source means the risk state is
	// unknown, which WeightTrend treats as a reason to suppress -- never as
	// a reason to show a figure.
	signals SignalsSource
}

func NewHandler(repo Repository) Handler {
	return Handler{repo: repo}
}

// WithSignals returns a copy of the handler that can gate a trend on the
// Protective policy.
func (h Handler) WithSignals(s SignalsSource) Handler {
	h.signals = s
	return h
}

func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

type addWaterRequest struct {
	VolumeML int       `json:"volume_ml"`
	LoggedAt time.Time `json:"logged_at"`
	// LocalDate is the device-local day at capture — see kora#84 and
	// internal/localday. Empty falls back to the profile zone.
	LocalDate string `json:"local_date"`
}

func (h Handler) Add(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var req addWaterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	localDate, err := localday.Resolve(req.LocalDate, orNow(req.LoggedAt), user.LocFromContext(c))
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	e, err := h.repo.AddWater(c.Request.Context(), userID, req.VolumeML, req.LoggedAt, localDate)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": e})
}

func (h Handler) DayTotal(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	day, err := time.Parse("2006-01-02", c.Query("date"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "date must be YYYY-MM-DD")
		return
	}
	total, err := h.repo.WaterTotalForDay(c.Request.Context(), userID, day)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not total water")
		return
	}
	httpx.OK(c, gin.H{"volume_ml": total})
}

type addWeightRequest struct {
	WeightKg float64   `json:"weight_kg"`
	LoggedAt time.Time `json:"logged_at"`
	// LocalDate is the device-local day at capture — see kora#84 and
	// internal/localday. Empty falls back to the profile zone.
	LocalDate string `json:"local_date"`
	// Body composition is optional and every metric is a pointer, so an
	// omitted field stays absent instead of arriving as a measured 0 (kora#45).
	// Derived values — BMI, fat-free mass, fat mass in kg — are not accepted
	// here at all; see migration 000039 for why.
	BodyFatPct         *float64 `json:"body_fat_pct"`
	SubcutaneousFatPct *float64 `json:"subcutaneous_fat_pct"`
	VisceralFatRating  *float64 `json:"visceral_fat_rating"`
	SkeletalMusclePct  *float64 `json:"skeletal_muscle_pct"`
	MuscleMassKg       *float64 `json:"muscle_mass_kg"`
	BodyWaterPct       *float64 `json:"body_water_pct"`
	ProteinPct         *float64 `json:"protein_pct"`
	BoneMassKg         *float64 `json:"bone_mass_kg"`
	// ScaleBMRKcal is stored for comparison only — it never feeds a calorie
	// target, which stays derived by internal/onboarding/calc.go.
	ScaleBMRKcal *float64 `json:"scale_bmr_kcal"`
	// Tape measurements in centimetres (kora#45). Optional and independent of
	// each other: a caller who measured only their waist sends only waist_cm.
	NeckCm  *float64 `json:"neck_cm"`
	ChestCm *float64 `json:"chest_cm"`
	WaistCm *float64 `json:"waist_cm"`
	HipCm   *float64 `json:"hip_cm"`
	ArmCm   *float64 `json:"arm_cm"`
	ThighCm *float64 `json:"thigh_cm"`
	// Source is the measuring instrument. Empty defaults to manual in the
	// repository; an unrecognised value is a 400, not a constraint violation.
	Source Source `json:"source"`
}

func (req addWeightRequest) composition() BodyComposition {
	return BodyComposition{
		BodyFatPct:         req.BodyFatPct,
		SubcutaneousFatPct: req.SubcutaneousFatPct,
		VisceralFatRating:  req.VisceralFatRating,
		SkeletalMusclePct:  req.SkeletalMusclePct,
		MuscleMassKg:       req.MuscleMassKg,
		BodyWaterPct:       req.BodyWaterPct,
		ProteinPct:         req.ProteinPct,
		BoneMassKg:         req.BoneMassKg,
		ScaleBMRKcal:       req.ScaleBMRKcal,
		NeckCm:             req.NeckCm,
		ChestCm:            req.ChestCm,
		WaistCm:            req.WaistCm,
		HipCm:              req.HipCm,
		ArmCm:              req.ArmCm,
		ThighCm:            req.ThighCm,
		Source:             req.Source,
	}
}

func (h Handler) AddWeight(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var req addWeightRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	localDate, err := localday.Resolve(req.LocalDate, orNow(req.LoggedAt), user.LocFromContext(c))
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	e, err := h.repo.AddWeightEntry(c.Request.Context(), userID, WeightInput{
		WeightKg:    req.WeightKg,
		LoggedAt:    req.LoggedAt,
		LocalDate:   localDate,
		Composition: req.composition(),
	})
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": e})
}

func (h Handler) ListWeight(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	to, err := time.Parse(time.RFC3339, c.Query("to"))
	if err != nil {
		to = endOfUTCDay(time.Now())
	}
	from, err := time.Parse(time.RFC3339, c.Query("from"))
	if err != nil {
		from = to.AddDate(-1, 0, 0)
	}
	entries, err := h.repo.WeightSeries(c.Request.Context(), userID, from, to)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load weight series")
		return
	}
	httpx.OK(c, entries)
}

// endOfUTCDay is the exclusive upper bound of `t`'s UTC day.
//
// It is what ListWeight defaults `to` to, rather than time.Now(), because
// "the weight series" means everything logged up to and including today, and
// a client that omits `to` is asking for exactly that (kora#378). Defaulting
// to the current instant instead silently excluded any entry stamped later
// today -- which a date-only entry always is before midday UTC, since the
// client sends one as `T12:00:00Z`. The result was a weigh-in that saved
// correctly and then did not appear, with no error on any layer to say so.
//
// Deliberately a whole UTC day and not a local one: this handler has no
// reliable timezone for the caller, and erring wide only ever includes an
// entry the user themselves logged. Erring narrow hides their data.
func endOfUTCDay(t time.Time) time.Time {
	u := t.UTC()
	return time.Date(u.Year(), u.Month(), u.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1)
}

// orNow mirrors the repository's zero-time defaulting so the local day is
// resolved against the SAME instant that will be persisted. Without this a
// client omitting logged_at would have its day computed from the zero time.
func orNow(t time.Time) time.Time {
	if t.IsZero() {
		return time.Now()
	}
	return t
}

// knownMetrics is the allow-list of series a rate may be fitted over. It is
// explicit, with no permissive default, because an unrecognised name must be
// a 400 rather than an empty series silently reported as insufficient_data
// -- or, worse, a fabricated zero fitted through the gap. It is kept in
// lockstep with metricValue by TestKnownMetricAgreesWithMetricValue.
var knownMetrics = map[string]bool{
	"weight_kg":            true,
	"body_fat_pct":         true,
	"subcutaneous_fat_pct": true,
	"visceral_fat_rating":  true,
	"skeletal_muscle_pct":  true,
	"muscle_mass_kg":       true,
	"body_water_pct":       true,
	"protein_pct":          true,
	"bone_mass_kg":         true,
	"scale_bmr_kcal":       true,
	"neck_cm":              true,
	"chest_cm":             true,
	"waist_cm":             true,
	"hip_cm":               true,
	"arm_cm":               true,
	"thigh_cm":             true,
}

func knownMetric(metric string) bool { return knownMetrics[metric] }

// rangeDays mirrors the client's WEIGHT_RANGE_DAYS. An unrecognised key
// falls back to a month rather than to zero days, which would otherwise turn
// a typo into a permanent insufficient_data.
func rangeDays(key string) int {
	switch key {
	case "1W":
		return 7
	case "3M":
		return 90
	case "1Y":
		return 365
	default:
		return 30
	}
}

type trendBasis struct {
	Readings int `json:"readings"`
	Days     int `json:"days"`
}

// trendResponse omits the rate and its basis when they are absent, so a
// suppressed result carries no figure on the wire at all -- not a null, not
// a zero. The client cannot render what was never sent.
type trendResponse struct {
	Status           string      `json:"status"`
	RatePerWeek      *float64    `json:"rate_per_week,omitempty"`
	Basis            *trendBasis `json:"basis,omitempty"`
	SpansInstruments bool        `json:"spans_instruments"`
	ShowSupport      bool        `json:"show_support"`
}

func suppressed(c *gin.Context, showSupport bool) {
	c.JSON(http.StatusOK, gin.H{"data": trendResponse{Status: "suppressed", ShowSupport: showSupport}})
}

// WeightTrend serves the rate of change shown beneath the Trends chart.
//
// The risk lookup comes FIRST and fails closed: a weight-loss figure is the
// single most harmful thing this API can show a user the eating-disorder
// policy has flagged, so an unknown risk state is treated exactly like a
// known-at-risk one. HTTP 200 with a suppressed status -- rather than a 5xx
// -- is deliberate: a grounding failure is not the caller's error, and a
// retry loop on the Trends screen would be worse than a missing figure.
func (h Handler) WeightTrend(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	metric := c.Query("metric")
	if !knownMetric(metric) {
		httpx.Error(c, http.StatusBadRequest, "invalid_metric", "unknown metric")
		return
	}

	if h.signals == nil {
		suppressed(c, false)
		return
	}
	// The location is per request, never a server-wide default: the risk
	// computation excludes "today" by LOCAL day.
	signals, err := h.signals.SignalsFor(c.Request.Context(), userID, user.LocFromContext(c))
	if err != nil {
		suppressed(c, false)
		return
	}
	if guardrails.AtRisk(signals) {
		suppressed(c, true)
		return
	}

	to := endOfUTCDay(time.Now())
	from := to.AddDate(0, 0, -rangeDays(c.Query("range")))
	entries, err := h.repo.WeightSeries(c.Request.Context(), userID, from, to)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load weight series")
		return
	}

	points, spans := PointsForMetric(entries, metric)
	result, fitted := WeeklyRate(points)
	if !fitted {
		c.JSON(http.StatusOK, gin.H{"data": trendResponse{Status: "insufficient_data", SpansInstruments: spans}})
		return
	}
	basis := trendBasis{Readings: result.Basis.Readings, Days: result.Basis.Days}
	c.JSON(http.StatusOK, gin.H{"data": trendResponse{
		Status: "ok", RatePerWeek: &result.PerWeek, Basis: &basis, SpansInstruments: spans,
	}})
}
