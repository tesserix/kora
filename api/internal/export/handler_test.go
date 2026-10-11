package export

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
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/user"
)

type stubReader struct {
	doc  Document
	err  error
	seen uuid.UUID
}

func (s *stubReader) ForUser(_ context.Context, id uuid.UUID) (Document, error) {
	s.seen = id
	return s.doc, s.err
}

// serveExport runs the handler with an optional authenticated identity.
// A nil id means "no identity on the context", which is what an unauthenticated
// request looks like once ResolveMiddleware has declined to set one.
func serveExport(t *testing.T, h Handler, id *uuid.UUID) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/v1/me/export", func(c *gin.Context) {
		if id != nil {
			user.SetIDForTest(c, *id)
		}
		h.Export(c)
	})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/me/export", nil))
	return rec
}

// TestExportRequiresAnIdentity — this endpoint returns one person's entire
// health history. Unauthenticated must never reach the service at all.
func TestExportRequiresAnIdentity(t *testing.T) {
	src := &stubReader{}
	rec := serveExport(t, NewHandler(src, nil), nil)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Equal(t, uuid.Nil, src.seen, "the service must not be reached without an identity")
}

// TestExportUsesTheContextIdentityNotTheRequest — there is no user id in the
// request to forge, and this pins that the handler reads the authenticated
// one. An export endpoint that took an id from the caller would be a way to
// read any account.
func TestExportUsesTheContextIdentity(t *testing.T) {
	id := uuid.New()
	src := &stubReader{doc: Document{UserID: id.String()}}

	rec := serveExport(t, NewHandler(src, nil), &id)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, id, src.seen)
}

// TestExportIsNotCachedAnywhere — a shared or on-disk cache holding this
// response is a copy of someone's health history that nobody accounted for.
func TestExportIsNotCachedAnywhere(t *testing.T) {
	id := uuid.New()
	rec := serveExport(t, NewHandler(&stubReader{}, nil), &id)

	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
}

func TestExportIsServedAsADatedAttachment(t *testing.T) {
	id := uuid.New()
	h := NewHandler(&stubReader{}, nil)
	h.now = func() time.Time {
		return time.Date(2026, 8, 26, 12, 0, 0, 0, time.FixedZone("AEST", 10*3600))
	}

	rec := serveExport(t, h, &id)

	assert.Equal(t, `attachment; filename="kora-export-2026-08-26.json"`,
		rec.Header().Get("Content-Disposition"),
		"UTC-dated, so two exports on the same day from different timezones agree")
}

// TestExportIsNotDoubleWrapped pins the envelope the client actually parses.
//
// Two things must hold together: the document is served at the TOP level (not
// nested under httpx.OK's "data"), and its table map is keyed "tables" rather
// than "data". The mobile apiFetch returns `envelope.data ?? envelope`, so a
// top-level "data" here would be unwrapped as if it were httpx.OK's envelope
// and the client would silently lose format_version, exported_at, counts and
// redacted — no error, no failed parse, just a smaller object.
func TestExportIsNotDoubleWrapped(t *testing.T) {
	id := uuid.New()
	src := &stubReader{doc: Document{
		FormatVersion: FormatVersion,
		UserID:        id.String(),
		Tables:        map[string][]map[string]any{"food_logs": {}},
	}}

	rec := serveExport(t, NewHandler(src, nil), &id)
	require.Equal(t, http.StatusOK, rec.Code)

	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))

	assert.Contains(t, body, "format_version")
	assert.NotContains(t, body, "data",
		"a top-level \"data\" key would be eaten by the client's envelope unwrapping")

	tables, ok := body["tables"].(map[string]any)
	require.True(t, ok, "tables must be the table map, not a nested envelope")
	assert.Contains(t, tables, "food_logs")
}

// TestExportFailureLeaksNothing — the error names the failing table, which is
// useful in a log and is nobody's business on the wire.
func TestExportFailureLeaksNothing(t *testing.T) {
	id := uuid.New()
	src := &stubReader{err: errors.New("export: weight_entries: relation does not exist")}

	rec := serveExport(t, NewHandler(src, nil), &id)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.NotContains(t, rec.Body.String(), "weight_entries")
	assert.NotContains(t, rec.Body.String(), "relation")

	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "internal_error", body["error"])
}
