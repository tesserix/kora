package labelocr

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type stubReader struct {
	read  Read
	err   error
	mime  string
	calls int
}

func (s *stubReader) Read(_ context.Context, _ []byte, mime string) (Read, error) {
	s.calls++
	s.mime = mime
	return s.read, s.err
}

var jpeg = append([]byte("\xff\xd8\xff\xe0\x00\x10JFIF\x00"), bytes.Repeat([]byte{0}, 64)...)

type stubBudget struct {
	within bool
	err    error
}

func (b stubBudget) WithinBudget(context.Context, uuid.UUID) (bool, error) { return b.within, b.err }

func post(t *testing.T, reader Reader, body []byte, signedIn bool) *httptest.ResponseRecorder {
	t.Helper()
	return postWithBudget(t, reader, stubBudget{within: true}, body, signedIn)
}

func postWithBudget(t *testing.T, reader Reader, budget Budget, body []byte, signedIn bool) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	if signedIn {
		r.Use(func(c *gin.Context) { c.Set("user_id", uuid.New()); c.Next() })
	}
	r.POST("/label", NewHandler(reader, budget).Read)

	var form bytes.Buffer
	w := multipart.NewWriter(&form)
	part, err := w.CreateFormFile("file", "label.jpg")
	require.NoError(t, err)
	_, _ = part.Write(body)
	require.NoError(t, w.Close())
	req := httptest.NewRequest(http.MethodPost, "/label", &form)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestHandlerReturnsTheCheckedLabel(t *testing.T) {
	raw, _ := json.Marshal(430)
	reader := &stubReader{read: Read{Fields: map[string]Field{"per_100g.energy_kcal": {Value: raw, Confidence: 0.9}}}}

	rec := post(t, reader, jpeg, true)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, "image/jpeg", reader.mime, "type comes from the bytes, not the client")
	var body struct {
		Data Label `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, BasisPer100g, body.Data.Basis)
	assert.InDelta(t, 430, *body.Data.Per100.EnergyKcal, 1e-9)
}

func TestHandlerRejectsNonImagesBeforeCallingDocumentIntelligence(t *testing.T) {
	reader := &stubReader{}
	rec := post(t, reader, []byte("%PDF-1.7 not a photo"), true)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Zero(t, reader.calls)
}

func TestHandlerReportsAnUnreadableLabelAs422(t *testing.T) {
	rec := post(t, &stubReader{err: ErrUnreadable}, jpeg, true)
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	assert.Contains(t, rec.Body.String(), "label_unreadable")
}

func TestHandlerRequiresASignedInUser(t *testing.T) {
	reader := &stubReader{}
	rec := post(t, reader, jpeg, false)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Zero(t, reader.calls)
}

func TestHandlerSpendsNothingOnceTheAIBudgetIsExhausted(t *testing.T) {
	reader := &stubReader{}
	rec := postWithBudget(t, reader, stubBudget{within: false}, jpeg, true)
	assert.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Contains(t, rec.Body.String(), "budget_exhausted")
	assert.Zero(t, reader.calls)
}

func TestHandlerFailsClosedWhenTheBudgetCannotBeChecked(t *testing.T) {
	reader := &stubReader{}
	rec := postWithBudget(t, reader, stubBudget{err: errors.New("db down")}, jpeg, true)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Zero(t, reader.calls)
}
