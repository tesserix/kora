package admin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/bffauth"
)

// fakeMutator records exactly what reached the repository so every "a
// rejected request must never reach the repository" assertion below has
// something to assert against. calls is deliberately a counter and not a
// bool: a handler that validated correctly but called the repository TWICE
// would pass a bool check.
type fakeMutator struct {
	calls    int
	actor    Actor
	in       FoodInput
	id       uuid.UUID
	expected time.Time
	result   FoodSnapshot
	err      error
}

func (f *fakeMutator) CreateFood(_ context.Context, actor Actor, in FoodInput) (FoodSnapshot, error) {
	f.calls++
	f.actor, f.in = actor, in
	return f.result, f.err
}

func (f *fakeMutator) UpdateFood(_ context.Context, actor Actor, id uuid.UUID, in FoodInput, expected time.Time) (FoodSnapshot, error) {
	f.calls++
	f.actor, f.id, f.in, f.expected = actor, id, in, expected
	return f.result, f.err
}

func (f *fakeMutator) SoftDeleteFood(_ context.Context, actor Actor, id uuid.UUID) (FoodSnapshot, error) {
	f.calls++
	f.actor, f.id = actor, id
	return f.result, f.err
}

// mutationRouter mounts the three mutation routes with a middleware that
// seeds the SAME context keys bffauth.Middleware sets in production. It does
// NOT run bffauth itself: signature verification is pinned end-to-end in
// internal/server/router_test.go, and duplicating it here would make every
// validation test below depend on HMAC plumbing it isn't testing.
func mutationRouter(m FoodMutator) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := NewHandler(nil, m)
	r.Use(func(c *gin.Context) {
		c.Set(bffauth.CtxAdminID, "admin-uid-1")
		c.Set(bffauth.CtxAdminEmail, "admin@tesserix.app")
	})
	r.POST("/v1/admin/foods", h.CreateFood)
	r.PATCH("/v1/admin/foods/:id", h.UpdateFood)
	r.DELETE("/v1/admin/foods/:id", h.SoftDeleteFood)
	return r
}

func do(m FoodMutator, method, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	mutationRouter(m).ServeHTTP(w, req)
	return w
}

// validCreate is the happy-path body every rejection test below mutates ONE
// field of, so each test can be sure the field it broke is what produced the
// 400 — not some other field it forgot to fill in.
const validCreate = `{
	"name": "Rolled oats, dry",
	"brand": "Store brand",
	"serving_desc": "1/2 cup (40g)",
	"serving_grams": 40,
	"kcal_per_100g": 389,
	"protein_per_100g": 16.9,
	"carbs_per_100g": 66,
	"fat_per_100g": 6.9,
	"fiber_per_100g": 10.6
}`

func createBodyWithout(t *testing.T, field string) string {
	t.Helper()
	var m map[string]any
	require.NoError(t, json.Unmarshal([]byte(validCreate), &m))
	delete(m, field)
	b, err := json.Marshal(m)
	require.NoError(t, err)
	return string(b)
}

func createBodyWith(t *testing.T, field string, value any) string {
	t.Helper()
	var m map[string]any
	require.NoError(t, json.Unmarshal([]byte(validCreate), &m))
	m[field] = value
	b, err := json.Marshal(m)
	require.NoError(t, err)
	return string(b)
}

func TestCreateFoodHandlerPassesTheInputThroughAndReturns201(t *testing.T) {
	m := &fakeMutator{result: FoodSnapshot{ID: uuid.New(), Name: "Rolled oats, dry"}}
	w := do(m, http.MethodPost, "/v1/admin/foods", validCreate)

	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	require.Equal(t, 1, m.calls)
	assert.Equal(t, "Rolled oats, dry", m.in.Name)
	assert.Equal(t, "Store brand", m.in.Brand)
	assert.Equal(t, 40.0, m.in.ServingGrams)
	assert.Equal(t, 389.0, m.in.KcalPer100g)
	assert.Equal(t, 10.6, m.in.FiberPer100g)

	var body struct {
		Data FoodSnapshot `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Equal(t, "Rolled oats, dry", body.Data.Name)
}

// An admin food is hand-authored, so an absent provenance means "curated"
// rather than "" — an empty provenance would make the row indistinguishable
// from a data-quality bug in the importers.
func TestCreateFoodHandlerDefaultsProvenanceToCurated(t *testing.T) {
	m := &fakeMutator{}
	w := do(m, http.MethodPost, "/v1/admin/foods", validCreate)

	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	assert.Equal(t, "curated", m.in.Provenance)
}

func TestCreateFoodHandlerRejectsAnUnknownProvenance(t *testing.T) {
	m := &fakeMutator{}
	w := do(m, http.MethodPost, "/v1/admin/foods", createBodyWith(t, "provenance", "made_it_up"))

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Zero(t, m.calls, "a rejected request must never reach the repository")
}

// THE ONE NOBODY WRITES UNTIL IT IS EXPLOITED (task-5 brief). The actor is
// attribution written straight into kora_admin_events — if the body can
// influence it, the audit trail is worthless, because the one person who
// would want to forge it is exactly the person sending the body.
func TestCreateFoodHandlerTakesTheActorFromContextNeverTheBody(t *testing.T) {
	m := &fakeMutator{}
	body := createBodyWith(t, "actor_id", "attacker-uid")
	var withEmail map[string]any
	require.NoError(t, json.Unmarshal([]byte(body), &withEmail))
	withEmail["actor_email"] = "attacker@evil.test"
	withEmail["ActorID"] = "attacker-uid-2"
	raw, err := json.Marshal(withEmail)
	require.NoError(t, err)

	w := do(m, http.MethodPost, "/v1/admin/foods", string(raw))

	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	assert.Equal(t, Actor{ID: "admin-uid-1", Email: "admin@tesserix.app"}, m.actor)
}

// The same guard on the other two mutations: a PATCH and a DELETE body must
// not be able to forge attribution either. DELETE carries no body in normal
// use, which is exactly why it is worth pinning — nothing else would notice
// if the handler started reading one.
func TestUpdateAndDeleteHandlersTakeTheActorFromContextNeverTheBody(t *testing.T) {
	id := uuid.New()
	stamp := time.Now().UTC().Format(time.RFC3339Nano)

	m := &fakeMutator{}
	patch := createBodyWith(t, "updated_at", stamp)
	patch = strings.Replace(patch, `"name"`, `"actor_id":"attacker-uid","actor_email":"attacker@evil.test","name"`, 1)
	w := do(m, http.MethodPatch, "/v1/admin/foods/"+id.String(), patch)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, Actor{ID: "admin-uid-1", Email: "admin@tesserix.app"}, m.actor)

	d := &fakeMutator{}
	w = do(d, http.MethodDelete, "/v1/admin/foods/"+id.String(),
		`{"actor_id":"attacker-uid","actor_email":"attacker@evil.test"}`)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, Actor{ID: "admin-uid-1", Email: "admin@tesserix.app"}, d.actor)
}

func TestCreateFoodHandlerRejectsAnEmptyName(t *testing.T) {
	for _, name := range []string{"", "   ", "\t\n"} {
		m := &fakeMutator{}
		w := do(m, http.MethodPost, "/v1/admin/foods", createBodyWith(t, "name", name))

		assert.Equal(t, http.StatusBadRequest, w.Code, "name %q", name)
		assert.Zero(t, m.calls, "a rejected request must never reach the repository")
	}
}

func TestCreateFoodHandlerRejectsNegativeMacros(t *testing.T) {
	for _, field := range []string{"kcal_per_100g", "protein_per_100g", "carbs_per_100g", "fat_per_100g", "fiber_per_100g"} {
		m := &fakeMutator{}
		w := do(m, http.MethodPost, "/v1/admin/foods", createBodyWith(t, field, -1))

		assert.Equal(t, http.StatusBadRequest, w.Code, field)
		assert.Zero(t, m.calls, "a rejected %s must never reach the repository", field)
	}
}

// "Per-100g-shaped" (task-5 brief) is not the same check as non-negative.
// The realistic operator error is pasting PER-SERVING values into per-100g
// fields — 1200 kcal, 150g protein. Those are non-negative and numeric, so
// only a magnitude bound catches them. A gram-per-100g field cannot exceed
// 100 by definition; kcal cannot exceed ~900 (pure fat).
func TestCreateFoodHandlerRejectsPerServingShapedMacros(t *testing.T) {
	cases := map[string]any{
		"kcal_per_100g":    1200,
		"protein_per_100g": 150,
		"carbs_per_100g":   101,
		"fat_per_100g":     140,
		"fiber_per_100g":   120,
	}
	for field, value := range cases {
		m := &fakeMutator{}
		w := do(m, http.MethodPost, "/v1/admin/foods", createBodyWith(t, field, value))

		assert.Equal(t, http.StatusBadRequest, w.Code, field)
		assert.Zero(t, m.calls, "a rejected %s must never reach the repository", field)
	}
}

// The twin for the bound above: the legitimate extremes must still pass, or
// the validation is just a narrower bug. 100g protein per 100g is pure whey
// isolate; 900 kcal per 100g is pure oil.
func TestCreateFoodHandlerAcceptsTheLegitimateExtremes(t *testing.T) {
	m := &fakeMutator{}
	body := createBodyWith(t, "kcal_per_100g", 900)
	var edge map[string]any
	require.NoError(t, json.Unmarshal([]byte(body), &edge))
	edge["fat_per_100g"] = 100
	edge["protein_per_100g"] = 0
	raw, err := json.Marshal(edge)
	require.NoError(t, err)

	w := do(m, http.MethodPost, "/v1/admin/foods", string(raw))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	assert.Equal(t, 1, m.calls)
}

func TestCreateFoodHandlerRejectsNonPositiveServingGrams(t *testing.T) {
	for _, v := range []any{0, -40} {
		m := &fakeMutator{}
		w := do(m, http.MethodPost, "/v1/admin/foods", createBodyWith(t, "serving_grams", v))

		assert.Equal(t, http.StatusBadRequest, w.Code, "serving_grams %v", v)
		assert.Zero(t, m.calls)
	}
}

// A MISSING macro must be a 400, never a silent zero. This is the difference
// between a pointer-shaped payload and a value-shaped one: with plain
// float64 fields, omitting "protein_per_100g" would store 0 and look exactly
// like an operator who genuinely meant zero protein.
func TestCreateFoodHandlerRejectsAMissingMacroRatherThanDefaultingItToZero(t *testing.T) {
	for _, field := range []string{"name", "serving_grams", "kcal_per_100g", "protein_per_100g", "carbs_per_100g", "fat_per_100g", "fiber_per_100g"} {
		m := &fakeMutator{}
		w := do(m, http.MethodPost, "/v1/admin/foods", createBodyWithout(t, field))

		assert.Equal(t, http.StatusBadRequest, w.Code, "missing %s", field)
		assert.Zero(t, m.calls, "a request missing %s must never reach the repository", field)
	}
}

func TestCreateFoodHandlerRejectsAMalformedBody(t *testing.T) {
	for _, body := range []string{``, `{`, `[]`, `{"kcal_per_100g": "389"}`} {
		m := &fakeMutator{}
		w := do(m, http.MethodPost, "/v1/admin/foods", body)

		assert.Equal(t, http.StatusBadRequest, w.Code, "body %q", body)
		assert.Zero(t, m.calls)
	}
}

// Rider 2: a barcode collision is a 409 naming what was collided with, not
// an opaque 500. The message is deliberately surfaced to this caller —
// unlike RespondServiceError's generic 500 — because the caller is a
// platform admin and the colliding row's name is the whole point.
func TestCreateFoodHandlerMapsDuplicateBarcodeTo409(t *testing.T) {
	m := &fakeMutator{err: fmt.Errorf(
		`admin: create food: barcode "9300675024235" already belongs to an already-retired food "Old oats" (%s): %w`,
		uuid.New(), ErrDuplicateBarcode)}
	w := do(m, http.MethodPost, "/v1/admin/foods", createBodyWith(t, "barcode", "9300675024235"))

	assert.Equal(t, http.StatusConflict, w.Code)
	assert.Contains(t, w.Body.String(), "Old oats", "the 409 must name the collision")
	assert.Contains(t, w.Body.String(), "already-retired")
}

func TestUpdateFoodHandlerPassesTheExpectedUpdatedAtThrough(t *testing.T) {
	id := uuid.New()
	stamp := time.Date(2026, 8, 5, 12, 30, 45, 123456000, time.UTC)
	m := &fakeMutator{result: FoodSnapshot{ID: id}}

	w := do(m, http.MethodPatch, "/v1/admin/foods/"+id.String(),
		createBodyWith(t, "updated_at", stamp.Format(time.RFC3339Nano)))

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, 1, m.calls)
	assert.Equal(t, id, m.id)
	assert.True(t, stamp.Equal(m.expected), "want %s, got %s", stamp, m.expected)
}

// Rider 1 has no value without this: if updated_at may be omitted, every
// client that forgets it silently opts out of optimistic concurrency and the
// clobber this rider exists to prevent comes straight back.
func TestUpdateFoodHandlerRequiresUpdatedAt(t *testing.T) {
	id := uuid.New()
	for _, body := range []string{validCreate, createBodyWith(t, "updated_at", ""), createBodyWith(t, "updated_at", "not-a-timestamp")} {
		m := &fakeMutator{}
		w := do(m, http.MethodPatch, "/v1/admin/foods/"+id.String(), body)

		assert.Equal(t, http.StatusBadRequest, w.Code)
		assert.Zero(t, m.calls, "a PATCH without a usable updated_at must never reach the repository")
	}
}

// Rider 1's payoff: a stale submit is a 409 the portal can turn into "someone
// else edited this — reload", NOT a 404 (which reads as "it's gone") and not
// a 500.
func TestUpdateFoodHandlerMapsStaleUpdateTo409(t *testing.T) {
	id := uuid.New()
	m := &fakeMutator{err: fmt.Errorf("admin: update food: %w", ErrStaleUpdate)}
	w := do(m, http.MethodPatch, "/v1/admin/foods/"+id.String(),
		createBodyWith(t, "updated_at", time.Now().UTC().Format(time.RFC3339Nano)))

	assert.Equal(t, http.StatusConflict, w.Code)
	assert.Contains(t, w.Body.String(), "stale_update")
}

// The twin for the 409 above: a genuinely missing or already-retired row is a
// 404. These two share a code path in the repository (both surface from
// UpdateFood) and must not collapse into one status.
func TestUpdateFoodHandlerMapsRecordNotFoundTo404(t *testing.T) {
	id := uuid.New()
	m := &fakeMutator{err: fmt.Errorf("admin: update food: %w", gorm.ErrRecordNotFound)}
	w := do(m, http.MethodPatch, "/v1/admin/foods/"+id.String(),
		createBodyWith(t, "updated_at", time.Now().UTC().Format(time.RFC3339Nano)))

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestMutationHandlersRejectAMalformedID(t *testing.T) {
	stamp := createBodyWith(t, "updated_at", time.Now().UTC().Format(time.RFC3339Nano))
	// "%20" is percent-encoded whitespace rather than a literal space: a
	// literal space is not a legal request target at all, so it would fail in
	// httptest before reaching the handler and prove nothing about pathID.
	for _, id := range []string{"not-a-uuid", "123", "%20", "00000000-0000-0000-0000-00000000000"} {
		m := &fakeMutator{}
		w := do(m, http.MethodPatch, "/v1/admin/foods/"+id, stamp)
		assert.Equal(t, http.StatusBadRequest, w.Code, "PATCH %q", id)
		assert.Zero(t, m.calls)

		d := &fakeMutator{}
		w = do(d, http.MethodDelete, "/v1/admin/foods/"+id, "")
		assert.Equal(t, http.StatusBadRequest, w.Code, "DELETE %q", id)
		assert.Zero(t, d.calls)
	}
}

// Rider 3: the DELETE response must be able to say the food is now retired.
// Asserting the literal JSON key because the portal reads deleted_at off the
// wire — unmarshalling into FoodSnapshot would round-trip a renamed tag
// invisibly.
func TestSoftDeleteFoodHandlerResponseCarriesTheRetirementFields(t *testing.T) {
	id := uuid.New()
	now := time.Now().UTC()
	m := &fakeMutator{result: FoodSnapshot{ID: id, Name: "Old oats", UpdatedAt: now, DeletedAt: &now}}

	w := do(m, http.MethodDelete, "/v1/admin/foods/"+id.String(), "")

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, 1, m.calls)
	assert.Equal(t, id, m.id)
	assert.Contains(t, w.Body.String(), `"deleted_at"`, "the response must convey that the food is retired")

	var body struct {
		Data FoodSnapshot `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.NotNil(t, body.Data.DeletedAt)
}

func TestSoftDeleteFoodHandlerMapsRecordNotFoundTo404(t *testing.T) {
	m := &fakeMutator{err: fmt.Errorf("admin: soft delete food: %w", gorm.ErrRecordNotFound)}
	w := do(m, http.MethodDelete, "/v1/admin/foods/"+uuid.New().String(), "")

	assert.Equal(t, http.StatusNotFound, w.Code)
}

// Rider 4, the whole point of it: the edit COMMITTED. Telling an operator
// their edit failed when it succeeded makes them do it again — which, with
// rider 1's precondition now in place, would then 409 against their own
// write and look like a second, different fault. The stale-cache fact is
// still reported, in meta, where a client can surface it without treating
// the mutation as failed.
func TestUpdateFoodHandlerRendersACacheBumpFailureAsSuccess(t *testing.T) {
	id := uuid.New()
	m := &fakeMutator{
		result: FoodSnapshot{ID: id, Name: "Rolled oats, dry"},
		err: fmt.Errorf("admin: update food: bump cache generation: %w: %w",
			ErrCacheGenerationBump, errors.New("dial tcp 127.0.0.1:6379: connect: connection refused")),
	}
	w := do(m, http.MethodPatch, "/v1/admin/foods/"+id.String(),
		createBodyWith(t, "updated_at", time.Now().UTC().Format(time.RFC3339Nano)))

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var body struct {
		Data FoodSnapshot   `json:"data"`
		Meta map[string]any `json:"meta"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Equal(t, "Rolled oats, dry", body.Data.Name, "the committed row must still be returned")
	assert.Equal(t, true, body.Meta["cache_bump_failed"])
	assert.NotContains(t, w.Body.String(), "6379", "the infra detail belongs in the log, not the response")
}

// The twin: a successful mutation reports the flag as false rather than
// omitting it, so a client can read one predictable shape instead of
// treating "key absent" and "key false" as different things.
func TestUpdateFoodHandlerReportsNoCacheBumpFailureOnTheHappyPath(t *testing.T) {
	id := uuid.New()
	m := &fakeMutator{result: FoodSnapshot{ID: id}}
	w := do(m, http.MethodPatch, "/v1/admin/foods/"+id.String(),
		createBodyWith(t, "updated_at", time.Now().UTC().Format(time.RFC3339Nano)))

	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Meta map[string]any `json:"meta"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Equal(t, false, body.Meta["cache_bump_failed"])
}

func TestSoftDeleteFoodHandlerRendersACacheBumpFailureAsSuccess(t *testing.T) {
	id := uuid.New()
	now := time.Now().UTC()
	m := &fakeMutator{
		result: FoodSnapshot{ID: id, Name: "Old oats", DeletedAt: &now},
		err: fmt.Errorf("admin: soft delete food: bump cache generation: %w: %w",
			ErrCacheGenerationBump, errors.New("connection refused")),
	}
	w := do(m, http.MethodDelete, "/v1/admin/foods/"+id.String(), "")

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var body struct {
		Data FoodSnapshot   `json:"data"`
		Meta map[string]any `json:"meta"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.NotNil(t, body.Data.DeletedAt, "the retirement committed and must still be reported")
	assert.Equal(t, true, body.Meta["cache_bump_failed"])
}

// The guard that keeps rider 4 from swallowing real failures: a mutation
// that genuinely did NOT commit must still be a 500. Without this, "render
// the cache-bump case as success" is one careless errors.Is away from
// rendering EVERY failure as success.
func TestMutationHandlersReportAGenuineRepositoryFailureAs500(t *testing.T) {
	id := uuid.New()
	stamp := createBodyWith(t, "updated_at", time.Now().UTC().Format(time.RFC3339Nano))
	boom := errors.New("dial tcp 10.0.0.5:5432: connect: connection refused")

	for _, tc := range []struct{ method, path, body string }{
		{http.MethodPost, "/v1/admin/foods", validCreate},
		{http.MethodPatch, "/v1/admin/foods/" + id.String(), stamp},
		{http.MethodDelete, "/v1/admin/foods/" + id.String(), ""},
	} {
		m := &fakeMutator{err: fmt.Errorf("admin: mutate: %w", boom)}
		w := do(m, tc.method, tc.path, tc.body)

		assert.Equal(t, http.StatusInternalServerError, w.Code, tc.method)
		assert.NotContains(t, w.Body.String(), "5432", "internal detail must not reach the client")
	}
}

// A mutation route reached with NO admin identity on the context must not
// record an empty actor — it must refuse. In production bffauth.Middleware
// makes this unreachable, which is exactly why it is worth pinning: if the
// route were ever mounted outside that group, the failure mode should be a
// refusal, not a silent audit row attributed to nobody.
func TestMutationHandlersRefuseWhenNoAdminIdentityIsOnTheContext(t *testing.T) {
	gin.SetMode(gin.TestMode)
	m := &fakeMutator{}
	r := gin.New()
	r.POST("/v1/admin/foods", NewHandler(nil, m).CreateFood)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/admin/foods", strings.NewReader(validCreate))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Zero(t, m.calls, "an unattributable mutation must never reach the repository")
}
