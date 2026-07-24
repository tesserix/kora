package resolve

import (
	"bytes"
	"context"
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
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
)

type stubTP struct {
	text    ai.Resolution
	photo   ai.Resolution
	err     error
	gotMime string
	gotSize int
}

func (s *stubTP) ResolveText(ctx context.Context, uid uuid.UUID, phrase string) (ai.Resolution, error) {
	return s.text, s.err
}

func (s *stubTP) ResolvePhoto(ctx context.Context, uid uuid.UUID, img []byte, mime string) (ai.Resolution, error) {
	s.gotMime = mime
	s.gotSize = len(img)
	return s.photo, s.err
}

func newEngine(h Handler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", uuid.New()); c.Next() }) // matches user.ResolveMiddleware key
	g := r.Group("/resolve")
	g.POST("/text", h.ResolveText)
	g.POST("/photo", h.ResolvePhoto)
	g.POST("/barcode", h.ResolveBarcode)
	return r
}

func doJSON(r *gin.Engine, method, path string, body any) *httptest.ResponseRecorder {
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestResolveText_Success(t *testing.T) {
	tp := &stubTP{text: ai.Resolution{
		Tier: ai.TierAuto,
		Candidates: []ai.ResolvedCandidate{{
			Item:       nutrition.FoodItem{Name: "Chicken Breast"},
			MatchScore: 0.95,
			MatchTier:  nutrition.MatchFullText,
		}},
		Provenance: "afcd",
	}}
	h := NewHandler(tp, nil)
	r := newEngine(h)

	w := doJSON(r, http.MethodPost, "/resolve/text", map[string]string{"phrase": "chicken"})

	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Data ai.Resolution `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Equal(t, ai.TierAuto, body.Data.Tier)
	require.Len(t, body.Data.Candidates, 1)
	assert.Equal(t, "Chicken Breast", body.Data.Candidates[0].Item.Name)
}

func TestResolveText_EmptyPhrase(t *testing.T) {
	h := NewHandler(&stubTP{}, nil)
	r := newEngine(h)

	w := doJSON(r, http.MethodPost, "/resolve/text", map[string]string{"phrase": ""})

	require.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "invalid_input")
}

func TestResolveText_MissingPhrase(t *testing.T) {
	h := NewHandler(&stubTP{}, nil)
	r := newEngine(h)

	w := doJSON(r, http.MethodPost, "/resolve/text", map[string]string{})

	require.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "invalid_input")
}

func TestResolveText_InfraErrorMapsTo500(t *testing.T) {
	tp := &stubTP{err: fmt.Errorf("ai: provider timeout: %w", fmt.Errorf("dial tcp: timeout"))}
	h := NewHandler(tp, nil)
	r := newEngine(h)

	w := doJSON(r, http.MethodPost, "/resolve/text", map[string]string{"phrase": "chicken"})

	require.Equal(t, http.StatusInternalServerError, w.Code)
	assert.JSONEq(t, `{"error":"internal_error","message":"something went wrong"}`, w.Body.String())
}

func TestResolveText_ValidationErrorMapsTo400(t *testing.T) {
	tp := &stubTP{err: httpx.ValidationError{Message: "budget exceeded"}}
	h := NewHandler(tp, nil)
	r := newEngine(h)

	w := doJSON(r, http.MethodPost, "/resolve/text", map[string]string{"phrase": "chicken"})

	require.Equal(t, http.StatusBadRequest, w.Code)
	assert.JSONEq(t, `{"error":"invalid_input","message":"budget exceeded"}`, w.Body.String())
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

func TestResolvePhoto_Success(t *testing.T) {
	tp := &stubTP{photo: ai.Resolution{Tier: ai.TierConfirm, Provenance: "off"}}
	h := NewHandler(tp, nil)
	r := newEngine(h)

	content := []byte("fake-jpeg-bytes")
	body, contentType := buildMultipart(t, "file", "meal.jpg", "image/jpeg", content)

	req := httptest.NewRequest(http.MethodPost, "/resolve/photo", body)
	req.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, "image/jpeg", tp.gotMime)
	assert.Equal(t, len(content), tp.gotSize)
}

func TestResolvePhoto_NoFile(t *testing.T) {
	h := NewHandler(&stubTP{}, nil)
	r := newEngine(h)

	body := &bytes.Buffer{}
	w2 := multipart.NewWriter(body)
	require.NoError(t, w2.Close())

	req := httptest.NewRequest(http.MethodPost, "/resolve/photo", body)
	req.Header.Set("Content-Type", w2.FormDataContentType())
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "invalid_input")
}

func TestResolvePhoto_TooLarge(t *testing.T) {
	h := NewHandler(&stubTP{}, nil)
	r := newEngine(h)

	content := bytes.Repeat([]byte("a"), maxPhotoBytes+1)
	body, contentType := buildMultipart(t, "file", "meal.jpg", "image/jpeg", content)

	req := httptest.NewRequest(http.MethodPost, "/resolve/photo", body)
	req.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusRequestEntityTooLarge, w.Code)
	assert.Contains(t, w.Body.String(), "payload_too_large")
}

func TestResolveBarcode_Found(t *testing.T) {
	item := &nutrition.FoodItem{
		Name:        "Cola 330ml",
		Provenance:  nutrition.ProvenanceOFF,
		KcalPer100g: 42,
	}
	bc := func(ctx context.Context, code string) (*nutrition.FoodItem, bool, error) {
		assert.Equal(t, "123", code)
		return item, true, nil
	}
	h := NewHandler(&stubTP{}, bc)
	r := newEngine(h)

	w := doJSON(r, http.MethodPost, "/resolve/barcode", map[string]string{"barcode": "123"})

	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Data ai.Resolution `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Equal(t, ai.TierAuto, body.Data.Tier)
	require.Len(t, body.Data.Candidates, 1)
	c := body.Data.Candidates[0]
	assert.Equal(t, item.KcalPer100g, c.Kcal)
	assert.Equal(t, nutrition.ProvenanceOFF, body.Data.Provenance)
}

func TestResolveBarcode_Unknown(t *testing.T) {
	bc := func(ctx context.Context, code string) (*nutrition.FoodItem, bool, error) {
		return nil, false, nil
	}
	h := NewHandler(&stubTP{}, bc)
	r := newEngine(h)

	w := doJSON(r, http.MethodPost, "/resolve/barcode", map[string]string{"barcode": "999"})

	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Data ai.Resolution `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Equal(t, ai.TierFollowUp, body.Data.Tier)
	assert.Empty(t, body.Data.Candidates)
	assert.Equal(t, "barcode", body.Data.Provenance)
	assert.NotEmpty(t, body.Data.FollowUpQuestion)
}

func TestResolveBarcode_MissingBarcode(t *testing.T) {
	h := NewHandler(&stubTP{}, nil)
	r := newEngine(h)

	w := doJSON(r, http.MethodPost, "/resolve/barcode", map[string]string{})

	require.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "invalid_input")
}

func TestResolveBarcode_InfraError(t *testing.T) {
	bc := func(ctx context.Context, code string) (*nutrition.FoodItem, bool, error) {
		return nil, false, fmt.Errorf("off: unreachable")
	}
	h := NewHandler(&stubTP{}, bc)
	r := newEngine(h)

	w := doJSON(r, http.MethodPost, "/resolve/barcode", map[string]string{"barcode": "123"})

	require.Equal(t, http.StatusInternalServerError, w.Code)
	assert.Contains(t, w.Body.String(), "internal_error")
}
