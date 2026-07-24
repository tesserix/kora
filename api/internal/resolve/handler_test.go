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

// newEngineNoUser mounts the same routes but WITHOUT the middleware that
// sets user_id in context, so IDFromContext fails — matching a request that
// somehow reached these handlers without the auth/user-resolve middleware
// chain in front of them.
func newEngineNoUser(h Handler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
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

func TestResolveText_Unauthorized(t *testing.T) {
	h := NewHandler(&stubTP{}, nil)
	r := newEngineNoUser(h)

	w := doJSON(r, http.MethodPost, "/resolve/text", map[string]string{"phrase": "chicken"})

	require.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "unauthorized")
}

func TestResolvePhoto_Unauthorized(t *testing.T) {
	h := NewHandler(&stubTP{}, nil)
	r := newEngineNoUser(h)

	content := []byte("fake-jpeg-bytes")
	body, contentType := buildMultipart(t, "file", "meal.jpg", "image/jpeg", content)

	req := httptest.NewRequest(http.MethodPost, "/resolve/photo", body)
	req.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "unauthorized")
}

func TestResolveBarcode_Unauthorized(t *testing.T) {
	h := NewHandler(&stubTP{}, nil)
	r := newEngineNoUser(h)

	w := doJSON(r, http.MethodPost, "/resolve/barcode", map[string]string{"barcode": "123"})

	require.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "unauthorized")
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
	tp := &stubTP{photo: ai.Resolution{
		Tier:       ai.TierConfirm,
		Provenance: "off",
		Candidates: []ai.ResolvedCandidate{{Item: nutrition.FoodItem{Name: "Salad Bowl"}, MatchScore: 0.8}},
	}}
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

	var respBody struct {
		Data ai.Resolution `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &respBody))
	assert.Equal(t, ai.TierConfirm, respBody.Data.Tier)
	assert.Equal(t, "off", respBody.Data.Provenance)
	require.Len(t, respBody.Data.Candidates, 1)
	assert.Equal(t, "Salad Bowl", respBody.Data.Candidates[0].Item.Name)
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

// TestResolvePhoto_BodyExceedsHardCap sends a request body genuinely larger
// than maxPhotoBodyBytes (not just larger than maxPhotoBytes), exercising
// the http.MaxBytesReader path that rejects the upload while it is still
// being read — before ParseMultipartForm has a chance to fully buffer it.
func TestResolvePhoto_BodyExceedsHardCap(t *testing.T) {
	h := NewHandler(&stubTP{}, nil)
	r := newEngine(h)

	content := bytes.Repeat([]byte{0}, 9<<20) // 9 MiB, well past maxPhotoBodyBytes
	body, contentType := buildMultipart(t, "file", "meal.jpg", "image/jpeg", content)
	require.Greater(t, body.Len(), maxPhotoBodyBytes, "test body must exceed the hard cap to exercise MaxBytesReader")

	req := httptest.NewRequest(http.MethodPost, "/resolve/photo", body)
	req.Header.Set("Content-Type", contentType)
	req.ContentLength = int64(body.Len())
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusRequestEntityTooLarge, w.Code, w.Body.String())
	assert.Contains(t, w.Body.String(), "payload_too_large")
}

func TestResolveBarcode_Found(t *testing.T) {
	item := &nutrition.FoodItem{
		Name:        "Cola 330ml",
		Provenance:  nutrition.ProvenanceOFF,
		KcalPer100g: 42,
	}
	bc := func(ctx context.Context, code string) (*nutrition.FoodItem, bool, error) {
		assert.Equal(t, "5449000000123", code)
		return item, true, nil
	}
	h := NewHandler(&stubTP{}, bc)
	r := newEngine(h)

	w := doJSON(r, http.MethodPost, "/resolve/barcode", map[string]string{"barcode": "5449000000123"})

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

	w := doJSON(r, http.MethodPost, "/resolve/barcode", map[string]string{"barcode": "00000000999"})

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

	w := doJSON(r, http.MethodPost, "/resolve/barcode", map[string]string{"barcode": "5449000000123"})

	require.Equal(t, http.StatusInternalServerError, w.Code)
	assert.Contains(t, w.Body.String(), "internal_error")
}

func TestResolveBarcode_NonDigitFormatIsRejected(t *testing.T) {
	bc := func(ctx context.Context, code string) (*nutrition.FoodItem, bool, error) {
		t.Fatal("barcode resolver must not be called for a malformed barcode")
		return nil, false, nil
	}
	h := NewHandler(&stubTP{}, bc)
	r := newEngine(h)

	w := doJSON(r, http.MethodPost, "/resolve/barcode", map[string]string{"barcode": "abc123"})

	require.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "invalid_input")
}

func TestResolveBarcode_TooShortIsRejected(t *testing.T) {
	bc := func(ctx context.Context, code string) (*nutrition.FoodItem, bool, error) {
		t.Fatal("barcode resolver must not be called for a malformed barcode")
		return nil, false, nil
	}
	h := NewHandler(&stubTP{}, bc)
	r := newEngine(h)

	w := doJSON(r, http.MethodPost, "/resolve/barcode", map[string]string{"barcode": "123"})

	require.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "invalid_input")
}
