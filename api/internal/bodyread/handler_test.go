package bodyread

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai"
)

func newEngine(h Handler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", uuid.New()); c.Next() }) // matches user.ResolveMiddleware key
	r.POST("/body-composition/read", h.Read)
	return r
}

// newEngineNoUser mounts the same route but WITHOUT the middleware that sets
// user_id in context, matching a request that somehow reached this handler
// without the auth/user-resolve middleware chain in front of it.
func newEngineNoUser(h Handler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/body-composition/read", h.Read)
	return r
}

func buildMultipart(t *testing.T, fieldName, fileName, contentType string, content []byte) (*bytes.Buffer, string) {
	t.Helper()
	buf := &bytes.Buffer{}
	w := multipart.NewWriter(buf)
	part, err := w.CreatePart(map[string][]string{
		"Content-Disposition": {fmt.Sprintf(`form-data; name=%q; filename=%q`, fieldName, fileName)},
		"Content-Type":        {contentType},
	})
	require.NoError(t, err)
	_, err = part.Write(content)
	require.NoError(t, err)
	require.NoError(t, w.Close())
	return buf, w.FormDataContentType()
}

// newTestReader builds a real Reader over a stub provider/cache/meter, for
// tests that need to get past the nil-reader 503 check to exercise the
// handler's own body-parsing/status-mapping logic.
func newTestReader(provider *stubProvider, meter *stubMeter) *Reader {
	return NewReader(provider, newStubCache(), meter)
}

func TestHandler_Read_Unauthenticated(t *testing.T) {
	h := NewHandler(nil)
	r := newEngineNoUser(h)

	body, contentType := buildMultipart(t, "file", "scale.jpg", "image/jpeg", []byte("fake"))
	req := httptest.NewRequest(http.MethodPost, "/body-composition/read", body)
	req.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "unauthorized")
}

func TestHandler_Read_NilReader503(t *testing.T) {
	h := NewHandler(nil)
	r := newEngine(h)

	body, contentType := buildMultipart(t, "file", "scale.jpg", "image/jpeg", []byte("fake"))
	req := httptest.NewRequest(http.MethodPost, "/body-composition/read", body)
	req.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
	assert.Contains(t, w.Body.String(), "unavailable")
}

func TestHandler_Read_NoFilePart(t *testing.T) {
	reader := newTestReader(&stubProvider{reading: ai.BodyCompositionReading{WeightKg: ptr(70)}}, &stubMeter{})
	h := NewHandler(reader)
	r := newEngine(h)

	// No multipart body at all -> FormFile fails with something other than
	// http.MaxBytesError -> 400 invalid_input.
	req := httptest.NewRequest(http.MethodPost, "/body-composition/read", bytes.NewBufferString(""))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=x")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "invalid_input")
}

// TestHandler_Read_TooLarge exercises the case where the multipart PART
// exceeds maxImageBytes but the overall body stays under the hard cap
// (maxImageBodyBytes) — matching TestResolvePhoto_TooLarge.
func TestHandler_Read_TooLarge(t *testing.T) {
	reader := newTestReader(&stubProvider{reading: ai.BodyCompositionReading{WeightKg: ptr(70)}}, &stubMeter{})
	h := NewHandler(reader)
	r := newEngine(h)

	content := bytes.Repeat([]byte("a"), maxImageBytes+1)
	body, contentType := buildMultipart(t, "file", "scale.jpg", "image/jpeg", content)

	req := httptest.NewRequest(http.MethodPost, "/body-composition/read", body)
	req.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusRequestEntityTooLarge, w.Code)
	assert.Contains(t, w.Body.String(), "payload_too_large")
}

// TestHandler_Read_BodyExceedsHardCap sends a request body genuinely larger
// than maxImageBodyBytes (not just larger than maxImageBytes), exercising
// the http.MaxBytesReader path that rejects the upload while it is still
// being read — matching TestResolvePhoto_BodyExceedsHardCap.
func TestHandler_Read_BodyExceedsHardCap(t *testing.T) {
	reader := newTestReader(&stubProvider{reading: ai.BodyCompositionReading{WeightKg: ptr(70)}}, &stubMeter{})
	h := NewHandler(reader)
	r := newEngine(h)

	content := bytes.Repeat([]byte{0}, 9<<20) // 9 MiB, well past maxImageBodyBytes
	body, contentType := buildMultipart(t, "file", "scale.jpg", "image/jpeg", content)
	require.Greater(t, body.Len(), maxImageBodyBytes, "test body must exceed the hard cap to exercise MaxBytesReader")

	req := httptest.NewRequest(http.MethodPost, "/body-composition/read", body)
	req.Header.Set("Content-Type", contentType)
	req.ContentLength = int64(body.Len())
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusRequestEntityTooLarge, w.Code, w.Body.String())
	assert.Contains(t, w.Body.String(), "payload_too_large")
}

func TestHandler_Read_UnreadableIs422(t *testing.T) {
	reader := newTestReader(&stubProvider{reading: ai.BodyCompositionReading{}}, &stubMeter{})
	h := NewHandler(reader)
	r := newEngine(h)

	body, contentType := buildMultipart(t, "file", "scale.jpg", "image/jpeg", []byte("fake-image-bytes"))
	req := httptest.NewRequest(http.MethodPost, "/body-composition/read", body)
	req.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusUnprocessableEntity, w.Code, w.Body.String())
	assert.Contains(t, w.Body.String(), "unreadable")
}

func TestHandler_Read_PartialSuccessIs200WithDroppedFields(t *testing.T) {
	provider := &stubProvider{reading: ai.BodyCompositionReading{
		WeightKg:   ptr(72.4),
		BodyFatPct: ptr(999), // implausible -> dropped by validation
	}}
	reader := newTestReader(provider, &stubMeter{})
	h := NewHandler(reader)
	r := newEngine(h)

	body, contentType := buildMultipart(t, "file", "scale.jpg", "image/jpeg", []byte("fake-image-bytes"))
	req := httptest.NewRequest(http.MethodPost, "/body-composition/read", body)
	req.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var respBody struct {
		Data Result `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &respBody))
	require.NotNil(t, respBody.Data.Reading.WeightKg)
	assert.Equal(t, 72.4, *respBody.Data.Reading.WeightKg)
	require.Len(t, respBody.Data.Dropped, 1)
	assert.Equal(t, "body_fat_pct", respBody.Data.Dropped[0].Field)
}

func TestHandler_Read_BudgetExhaustedIs429(t *testing.T) {
	reader := newTestReader(&stubProvider{reading: ai.BodyCompositionReading{WeightKg: ptr(70)}}, &stubMeter{overBudget: true})
	h := NewHandler(reader)
	r := newEngine(h)

	body, contentType := buildMultipart(t, "file", "scale.jpg", "image/jpeg", []byte("fake-image-bytes"))
	req := httptest.NewRequest(http.MethodPost, "/body-composition/read", body)
	req.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusTooManyRequests, w.Code, w.Body.String())
	assert.Contains(t, w.Body.String(), "budget_exhausted")
}
