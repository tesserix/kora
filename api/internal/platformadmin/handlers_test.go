package platformadmin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/admin"
	"github.com/tesserix/kora/api/internal/feedback"
)

func init() { gin.SetMode(gin.TestMode) }

// call serves one request against a bare engine carrying just the handler
// under test. The platform signature is verified by package platformauth and
// tested there; mounting it here would only prove that middleware runs.
func call(t *testing.T, method, path, target string, h gin.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	r := gin.New()
	r.Handle(method, path, h)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	return body
}

// ---------- audit-logs (#431) ----------

type stubAudit struct {
	result AuditResult
	err    error
	got    AuditFilter
}

func (s *stubAudit) ListAudit(_ context.Context, f AuditFilter) (AuditResult, error) {
	s.got = f
	return s.result, s.err
}

func TestAuditLogsReturnsTheContractEnvelope(t *testing.T) {
	id, target := uuid.New(), uuid.New()
	src := &stubAudit{result: AuditResult{
		Total: 1,
		Entries: []admin.AdminEvent{{
			ID:         id,
			ActorEmail: "operator@tesserix.app",
			Action:     admin.ActionFoodUpdated,
			TargetType: admin.TargetTypeFood,
			TargetID:   &target,
			CreatedAt:  time.Date(2026, 8, 25, 9, 31, 0, 0, time.UTC),
		}},
	}}

	rec := call(t, http.MethodGet, "/admin/audit-logs", "/admin/audit-logs",
		NewAuditHandler(src, nil).List)
	require.Equal(t, http.StatusOK, rec.Code)

	body := decode(t, rec)
	rows := body["data"].([]any)
	require.Len(t, rows, 1)

	row := rows[0].(map[string]any)
	assert.Equal(t, id.String(), row["id"])
	assert.Equal(t, "operator@tesserix.app", row["actor"])
	assert.Equal(t, admin.ActionFoodUpdated, row["action"])
	assert.Equal(t, target.String(), row["target"])
	assert.Equal(t, "2026-08-25T09:31:00Z", row["timestamp"], "§4.3: ISO 8601 UTC with offset")

	// §4.1's block, exactly.
	p := body["pagination"].(map[string]any)
	assert.Equal(t, float64(1), p["page"])
	assert.Equal(t, float64(DefaultLimit), p["limit"])
	assert.Equal(t, float64(1), p["total"])

	// The row must NOT carry before/after snapshots.
	assert.NotContains(t, row, "before")
	assert.NotContains(t, row, "after")
}

// TestAuditLogsEmptyIsNotAnError is §4.5, and the one the contract is most
// explicit about: `data` must be [] and never null, or a consumer's `?? []`
// is defeated exactly when there is no data.
func TestAuditLogsEmptyIsNotAnError(t *testing.T) {
	rec := call(t, http.MethodGet, "/admin/audit-logs", "/admin/audit-logs",
		NewAuditHandler(&stubAudit{}, nil).List)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"data":[]`)
	assert.NotContains(t, rec.Body.String(), `"data":null`)
}

// TestAuditLogsHonoursTheFanOutBounds — the console asks every product the
// same bounded question. A product that ignores the bound makes one slow
// product degrade the whole estate timeline.
func TestAuditLogsHonoursTheFanOutBounds(t *testing.T) {
	src := &stubAudit{}
	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	h := NewAuditHandler(src, nil)
	h.now = func() time.Time { return now }

	call(t, http.MethodGet, "/admin/audit-logs",
		"/admin/audit-logs?limit=25&since_hours=48&action=food.deleted&actor=a@b.c&resource_type=food_item",
		h.List)

	assert.Equal(t, 25, src.got.Limit)
	assert.Equal(t, now.Add(-48*time.Hour), src.got.From)
	assert.Equal(t, "food.deleted", src.got.Action)
	assert.Equal(t, "a@b.c", src.got.Actor)
	assert.Equal(t, "food_item", src.got.ResourceType)
}

func TestAuditLogsClampsAnOversizedLimit(t *testing.T) {
	src := &stubAudit{}
	call(t, http.MethodGet, "/admin/audit-logs", "/admin/audit-logs?limit=100000",
		NewAuditHandler(src, nil).List)
	assert.Equal(t, MaxLimit, src.got.Limit, "a ceiling here is the backstop for a fan-out asking for too much")
}

// TestAuditLogsIgnoresAnUnparseableBound — a product that 400s on a parameter
// another product tolerates takes the whole estate timeline down with it.
func TestAuditLogsIgnoresAnUnparseableBound(t *testing.T) {
	src := &stubAudit{}
	rec := call(t, http.MethodGet, "/admin/audit-logs", "/admin/audit-logs?limit=banana&since_hours=-4",
		NewAuditHandler(src, nil).List)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, DefaultLimit, src.got.Limit)
	assert.True(t, src.got.From.IsZero())
}

func TestAuditLogsPreferesExplicitFromOverSinceHours(t *testing.T) {
	src := &stubAudit{}
	h := NewAuditHandler(src, nil)
	h.now = func() time.Time { return time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC) }

	call(t, http.MethodGet, "/admin/audit-logs",
		"/admin/audit-logs?since_hours=48&from=2026-08-01T00:00:00Z", h.List)

	assert.Equal(t, time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), src.got.From.UTC())
}

func TestAuditLogsReportsASourceFailureAsFiveHundred(t *testing.T) {
	rec := call(t, http.MethodGet, "/admin/audit-logs", "/admin/audit-logs",
		NewAuditHandler(&stubAudit{err: errors.New("db down")}, nil).List)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, "internal_error", decode(t, rec)["error"])
	assert.NotContains(t, rec.Body.String(), "db down", "the driver error stays in the log")
}

func TestAuditActorFallsBackFromEmailToIDToSystem(t *testing.T) {
	assert.Equal(t, "e@x.io", auditActor(admin.AdminEvent{ActorEmail: "e@x.io", ActorID: "op_1"}))
	assert.Equal(t, "op_1", auditActor(admin.AdminEvent{ActorID: "op_1"}))
	assert.Equal(t, "system", auditActor(admin.AdminEvent{}))
	assert.Equal(t, "op_1", auditActor(admin.AdminEvent{ActorEmail: "   ", ActorID: "op_1"}))
}

func TestAuditTargetFallsBackToTheType(t *testing.T) {
	id := uuid.New()
	assert.Equal(t, id.String(), auditTarget(admin.AdminEvent{TargetType: "food_item", TargetID: &id}))
	assert.Equal(t, "food_item", auditTarget(admin.AdminEvent{TargetType: "food_item"}))
}

// ---------- inbox (#432) ----------

type stubInbox struct {
	result InboxResult
	err    error
	limit  int
	offset int
}

func (s *stubInbox) ListInbox(_ context.Context, limit, offset int) (InboxResult, error) {
	s.limit, s.offset = limit, offset
	return s.result, s.err
}

func TestInboxReturnsItemsAndTotal(t *testing.T) {
	id := uuid.New()
	src := &stubInbox{result: InboxResult{
		Total: 12,
		Items: []feedback.Feedback{{
			ID:         id,
			Kind:       feedback.KindBug,
			Subject:    "Barcode scan hangs",
			Status:     feedback.StatusOpen,
			Platform:   "ios",
			AppVersion: "1.0.0",
			CreatedAt:  time.Date(2026, 8, 25, 9, 31, 0, 0, time.UTC),
		}},
	}}

	rec := call(t, http.MethodGet, "/admin/inbox", "/admin/inbox",
		NewInboxHandler(src, nil).List)
	require.Equal(t, http.StatusOK, rec.Code)

	body := decode(t, rec)
	assert.Equal(t, float64(12), body["total"])

	items := body["items"].([]any)
	require.Len(t, items, 1)
	item := items[0].(map[string]any)

	assert.Equal(t, id.String(), item["id"])
	assert.Equal(t, KindFeedback, item["kind"])
	assert.Equal(t, "Barcode scan hangs", item["title"])
	assert.Equal(t, "bug · ios 1.0.0", item["subtitle"])
	assert.Equal(t, "2026-08-25T09:31:00Z", item["waiting_since"])
	assert.Equal(t, SeverityHigh, item["severity"], "a defect is not the same waiting as a suggestion")
	assert.Empty(t, item["actions"], "declare only actions Kora can execute")
}

// TestInboxDueAtIsNullNotAbsentAndNotInvented — Kora has no SLA on this
// queue. The console sorts and colours by due_at, so a fabricated deadline is
// worse than an absent one.
func TestInboxDueAtIsNullNotAbsentAndNotInvented(t *testing.T) {
	src := &stubInbox{result: InboxResult{Total: 1, Items: []feedback.Feedback{{
		ID: uuid.New(), Kind: feedback.KindFeature, Subject: "s", CreatedAt: time.Now(),
	}}}}

	rec := call(t, http.MethodGet, "/admin/inbox", "/admin/inbox",
		NewInboxHandler(src, nil).List)

	items := decode(t, rec)["items"].([]any)
	item := items[0].(map[string]any)
	require.Contains(t, item, "due_at")
	assert.Nil(t, item["due_at"])
}

func TestInboxFeatureRequestIsNormalSeverity(t *testing.T) {
	src := &stubInbox{result: InboxResult{Total: 1, Items: []feedback.Feedback{{
		ID: uuid.New(), Kind: feedback.KindFeature, Subject: "s", CreatedAt: time.Now(),
	}}}}

	rec := call(t, http.MethodGet, "/admin/inbox", "/admin/inbox",
		NewInboxHandler(src, nil).List)

	item := decode(t, rec)["items"].([]any)[0].(map[string]any)
	assert.Equal(t, SeverityNormal, item["severity"])
}

func TestInboxEmptyIsNotAnError(t *testing.T) {
	rec := call(t, http.MethodGet, "/admin/inbox", "/admin/inbox",
		NewInboxHandler(&stubInbox{}, nil).List)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"items":[]`)
	assert.NotContains(t, rec.Body.String(), `"items":null`)
}

// TestInboxSubtitleNeverCarriesTheDescription — free text a user typed, up to
// 4000 characters, rendered on one line by the console.
func TestInboxSubtitleNeverCarriesTheDescription(t *testing.T) {
	secret := "the user typed something long and private here"
	src := &stubInbox{result: InboxResult{Total: 1, Items: []feedback.Feedback{{
		ID: uuid.New(), Kind: feedback.KindBug, Subject: "s",
		Description: secret, CreatedAt: time.Now(),
	}}}}

	rec := call(t, http.MethodGet, "/admin/inbox", "/admin/inbox",
		NewInboxHandler(src, nil).List)
	assert.NotContains(t, rec.Body.String(), secret)
}

// TestOpenFeedbackStatusesExcludeTerminalOnes guards the derivation: a status
// added to feedback.Status must not fall silently into or out of the inbox.
func TestOpenFeedbackStatusesExcludeTerminalOnes(t *testing.T) {
	assert.Contains(t, openFeedbackStatuses, feedback.StatusOpen)
	assert.Contains(t, openFeedbackStatuses, feedback.StatusInProgress)
	assert.NotContains(t, openFeedbackStatuses, feedback.StatusResolved)
	assert.NotContains(t, openFeedbackStatuses, feedback.StatusClosed)
}

func TestInboxReportsASourceFailureAsFiveHundred(t *testing.T) {
	rec := call(t, http.MethodGet, "/admin/inbox", "/admin/inbox",
		NewInboxHandler(&stubInbox{err: errors.New("db down")}, nil).List)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

// ---------- entities (#433) ----------

type stubEntities struct {
	result EntityResult
	err    error
	gotQ   string
	gotTyp string
}

func (s *stubEntities) SearchEntities(_ context.Context, typ, q string, _, _ int) (EntityResult, error) {
	s.gotTyp, s.gotQ = typ, q
	return s.result, s.err
}

func entitiesRequest(t *testing.T, target string, src EntitySource) *httptest.ResponseRecorder {
	t.Helper()
	return call(t, http.MethodGet, "/admin/entities/:type", target,
		NewEntitiesHandler(src, nil).Search)
}

func TestEntitiesReturnsTheContractEnvelope(t *testing.T) {
	src := &stubEntities{result: EntityResult{Total: 1, Items: []Entity{{
		ID: "u1", Type: TypeUsers, Label: "Alex", Sublabel: "@alex",
		CreatedAt: "2026-08-25T09:31:00Z",
	}}}}

	rec := entitiesRequest(t, "/admin/entities/users?q=alex", src)
	require.Equal(t, http.StatusOK, rec.Code)

	body := decode(t, rec)
	assert.Len(t, body["data"].([]any), 1)
	assert.Contains(t, body, "pagination")
	assert.Equal(t, TypeUsers, src.gotTyp)
	assert.Equal(t, "alex", src.gotQ)
}

// TestEntitiesRefusesABlankSearch is the enumeration guard. A search endpoint
// over user records must not answer "everything" when asked for nothing.
func TestEntitiesRefusesABlankSearch(t *testing.T) {
	for _, target := range []string{
		"/admin/entities/users",
		"/admin/entities/users?q=",
		"/admin/entities/users?q=%20%20",
		"/admin/entities/users?q=a",
	} {
		t.Run(target, func(t *testing.T) {
			src := &stubEntities{}
			rec := entitiesRequest(t, target, src)

			assert.Equal(t, http.StatusBadRequest, rec.Code)
			assert.Equal(t, "invalid_input", decode(t, rec)["error"])
			assert.Empty(t, src.gotQ, "the search must not reach the database at all")
		})
	}
}

// TestEntitiesUnknownTypeIsNotFoundNotEmpty — "Kora has no such type" and
// "this type has no matches" are different answers and must not look alike.
func TestEntitiesUnknownTypeIsNotFound(t *testing.T) {
	rec := entitiesRequest(t, "/admin/entities/orders?q=alex", &stubEntities{})

	require.Equal(t, http.StatusNotFound, rec.Code)
	body := decode(t, rec)
	assert.Equal(t, "not_found", body["error"])
	assert.Contains(t, body["message"], TypeUsers)
	assert.Contains(t, body["message"], TypeFoods)
}

func TestEntitiesEmptyIsNotAnError(t *testing.T) {
	rec := entitiesRequest(t, "/admin/entities/foods?q=zzz", &stubEntities{})

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"data":[]`)
	assert.NotContains(t, rec.Body.String(), `"data":null`)
}

// TestUserEntityCarriesNoMoreThanTheDirectoryNeeds — every column the
// projection does not select is one that cannot leak. Asserted on the JSON,
// because a field added to Entity with a json tag is what would break this.
func TestUserEntityCarriesNoMoreThanTheDirectoryNeeds(t *testing.T) {
	email := "alex@example.com"
	handle := "alex"
	name := "Alex"
	e := toUserEntity(userRow{
		ID: uuid.New(), Email: &email, DisplayName: &name, Handle: &handle,
		CreatedAt: time.Now(),
	})

	raw, err := json.Marshal(e)
	require.NoError(t, err)

	var fields map[string]any
	require.NoError(t, json.Unmarshal(raw, &fields))
	assert.ElementsMatch(t,
		[]string{"id", "type", "label", "sublabel", "created_at"},
		keysOf(fields))
}

// TestUserEntityPrefersTheHandleOverTheEmail — the handle is unique and
// public; the email is only reached for a user who has no handle to show.
func TestUserEntityPrefersTheHandleOverTheEmail(t *testing.T) {
	email, handle, name := "alex@example.com", "alex", "Alex"

	withHandle := toUserEntity(userRow{ID: uuid.New(), Email: &email, DisplayName: &name, Handle: &handle})
	assert.Equal(t, "alex", withHandle.Sublabel)
	assert.NotContains(t, withHandle.Sublabel, "@example.com")

	withoutHandle := toUserEntity(userRow{ID: uuid.New(), Email: &email, DisplayName: &name})
	assert.Equal(t, email, withoutHandle.Sublabel)
}

// TestUserEntityAlwaysHasALabel — display_name and email are both nullable
// and handle is opt-in, so all three can be absent at once. A blank label is
// a row the operator cannot click with confidence.
func TestUserEntityAlwaysHasALabel(t *testing.T) {
	id := uuid.New()
	assert.Equal(t, id.String(), toUserEntity(userRow{ID: id}).Label)

	handle := "alex"
	assert.Equal(t, "alex", toUserEntity(userRow{ID: id, Handle: &handle}).Label)
}

func TestEntitiesReportsASourceFailureAsFiveHundred(t *testing.T) {
	rec := entitiesRequest(t, "/admin/entities/users?q=alex",
		&stubEntities{err: errors.New("db down")})
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
}

// ---------- health (#434) ----------

func healthResponse(t *testing.T, rec *httptest.ResponseRecorder) map[string]string {
	t.Helper()
	body := decode(t, rec)
	data := body["data"].(map[string]any)
	require.Contains(t, data, "checked_at")

	statuses := map[string]string{}
	for _, raw := range data["dependencies"].([]any) {
		row := raw.(map[string]any)
		statuses[row["name"].(string)] = row["status"].(string)
	}
	return statuses
}

func TestHealthReportsEveryRegisteredDependency(t *testing.T) {
	probes := map[string]Probe{
		DepPostgres: func(context.Context) (map[string]int64, error) { return nil, nil },
		DepRedis:    func(context.Context) (map[string]int64, error) { return nil, nil },
	}

	rec := call(t, http.MethodGet, "/admin/health", "/admin/health",
		NewHealthHandler(probes, nil).Health)
	require.Equal(t, http.StatusOK, rec.Code)

	statuses := healthResponse(t, rec)
	assert.Len(t, statuses, len(DependencyRegistry), "membership comes from the registry, not from what happened to be probed")
	assert.Equal(t, StatusOK, statuses[DepPostgres])
	assert.Equal(t, StatusOK, statuses[DepRedis])
}

// TestHealthReportsAFailedProbeAsDown is the whole point of #434: Redis being
// unreachable in prod (#105) is a fact only Kora knows.
func TestHealthReportsAFailedProbeAsDown(t *testing.T) {
	probes := map[string]Probe{
		DepPostgres: func(context.Context) (map[string]int64, error) { return nil, nil },
		DepRedis: func(context.Context) (map[string]int64, error) {
			return nil, errors.New("dial tcp: connection refused")
		},
	}

	rec := call(t, http.MethodGet, "/admin/health", "/admin/health",
		NewHealthHandler(probes, nil).Health)

	statuses := healthResponse(t, rec)
	assert.Equal(t, StatusDown, statuses[DepRedis])
	assert.Equal(t, StatusOK, statuses[DepPostgres], "one dependency failing must not take the others with it")
	assert.NotContains(t, rec.Body.String(), "dial tcp", "the driver error stays in the log")
}

// TestHealthReportsAnUnwiredProbeAsUnknown — "registered as measured, never
// measured" must not render as ok. This is the check that turns a wiring
// mistake into something visible rather than a permanently green tile.
func TestHealthReportsAnUnwiredProbeAsUnknown(t *testing.T) {
	rec := call(t, http.MethodGet, "/admin/health", "/admin/health",
		NewHealthHandler(nil, nil).Health)

	statuses := healthResponse(t, rec)
	assert.Equal(t, StatusUnknown, statuses[DepPostgres])
	assert.Equal(t, StatusUnknown, statuses[DepRedis])
}

// TestHealthNeverReportsAnUninstrumentedDependencyAsOK — a health endpoint
// that returns ok because it did not check anything converts an outage into a
// green tile.
func TestHealthNeverReportsAnUninstrumentedDependencyAsOK(t *testing.T) {
	// Every probe wired and passing, including ones for dependencies the
	// registry says are NOT instrumented — the registry must still win.
	probes := map[string]Probe{}
	for _, key := range DependencyRegistry {
		probes[key.Name] = func(context.Context) (map[string]int64, error) { return nil, nil }
	}

	rec := call(t, http.MethodGet, "/admin/health", "/admin/health",
		NewHealthHandler(probes, nil).Health)

	statuses := healthResponse(t, rec)
	for _, key := range DependencyRegistry {
		if !key.Instrumented {
			assert.Equal(t, StatusNotInstrumented, statuses[key.Name],
				"%s is not probed; a passing probe map must not make it ok", key.Name)
		}
	}
}

// TestHealthIsAlwaysTwoHundred — "Kora says Redis is down" and "Kora's health
// endpoint is down" are different events to the console.
func TestHealthIsAlwaysTwoHundred(t *testing.T) {
	probes := map[string]Probe{
		DepPostgres: func(context.Context) (map[string]int64, error) { return nil, errors.New("down") },
		DepRedis:    func(context.Context) (map[string]int64, error) { return nil, errors.New("down") },
	}

	rec := call(t, http.MethodGet, "/admin/health", "/admin/health",
		NewHealthHandler(probes, nil).Health)
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestHealthBoundsASlowProbe(t *testing.T) {
	blocked := map[string]Probe{
		DepPostgres: func(ctx context.Context) (map[string]int64, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
		DepRedis: func(context.Context) (map[string]int64, error) { return nil, nil },
	}

	start := time.Now()
	rec := call(t, http.MethodGet, "/admin/health", "/admin/health",
		NewHealthHandler(blocked, nil).Health)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, StatusDown, healthResponse(t, rec)[DepPostgres])
	assert.Less(t, time.Since(start), 2*probeTimeout,
		"a dependency that never answers must not hold the console's page open")
}

func TestHealthCheckedAtIsRFC3339UTC(t *testing.T) {
	h := NewHealthHandler(nil, nil)
	h.now = func() time.Time { return time.Date(2026, 8, 26, 12, 0, 0, 0, time.FixedZone("IST", 5*3600+1800)) }

	rec := call(t, http.MethodGet, "/admin/health", "/admin/health", h.Health)
	data := decode(t, rec)["data"].(map[string]any)
	assert.Equal(t, "2026-08-26T06:30:00Z", data["checked_at"])
}

// ---------- kpis (#435) ----------

// TestKPIsReturnsAnHonest501 — §3.1 forbids the third answer. `{}` or a map
// of zeroes renders as a tile of em-dashes that reads as "zero activity"
// rather than "nothing measured".
func TestKPIsReturnsAnHonest501(t *testing.T) {
	rec := call(t, http.MethodGet, "/admin/kpis", "/admin/kpis", NewKPIsHandler().KPIs)

	require.Equal(t, http.StatusNotImplemented, rec.Code)
	body := decode(t, rec)
	assert.Equal(t, "not_implemented", body["error"])
	assert.NotEmpty(t, body["message"])

	assert.NotContains(t, body, "data", "a payload alongside a 501 is the ambiguity this endpoint exists to avoid")
	assert.NotEqual(t, "{}", strings.TrimSpace(rec.Body.String()))
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
