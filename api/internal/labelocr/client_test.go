package labelocr

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The shared signing vector's key is the bytes 0x00, 0x11, ... 0xff.
var (
	testSecretHex   = hex.EncodeToString([]byte{0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff})
	clientSecretHex = testSecretHex + testSecretHex
)

func TestSignMatchesTheDocumentIntelligenceVector(t *testing.T) {
	secret, _ := hex.DecodeString(testSecretHex)
	got := sign(secret, "roamie-v1", "roamie-public", 1_790_000_000, "POST", "/v1/ocr/uploads")
	assert.Equal(t, "b7f53c908733d93e2b1e1fa1104ea4623851f33171565154079c8674644e606d", got)
}

type fakeDI struct {
	t           *testing.T
	mu          sync.Mutex
	uploadState string
	jobPolls    int
	jobFinal    string
	stored      []byte
	jobRequest  map[string]any
	idempotency []string
	server      *httptest.Server
}

func newFakeDI(t *testing.T, jobFinal string) *fakeDI {
	f := &fakeDI{t: t, uploadState: "reserved", jobFinal: jobFinal}
	f.server = httptest.NewTLSServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeDI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Path == "/storage" {
		f.stored, _ = io.ReadAll(r.Body)
		assert.Equal(f.t, "image/jpeg", r.Header.Get("Content-Type"))
		f.uploadState = "reserved-put"
		return
	}
	secret, _ := hex.DecodeString(clientSecretHex)
	ts, _ := strconv.ParseInt(r.Header.Get("X-OCR-Timestamp"), 10, 64)
	want := sign(secret, r.Header.Get("X-OCR-Key-Id"), r.Header.Get("X-OCR-Tenant-Id"), ts, r.Method, r.URL.RequestURI())
	if r.Header.Get("X-OCR-Signature") != want || r.Header.Get("X-OCR-Tenant-Id") != "ten_kora_public" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if key := r.Header.Get("Idempotency-Key"); key != "" {
		f.idempotency = append(f.idempotency, key)
	}
	reply := func(status int, body any) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
	switch r.Method + " " + r.URL.Path {
	case "POST /v1/ocr/uploads":
		reply(201, map[string]any{
			"upload_id": "upl_1", "method": "PUT", "upload_url": f.server.URL + "/storage",
			"required_headers": map[string]string{"Content-Type": "image/jpeg"}, "expires_at": "2026-10-04T00:00:00Z",
		})
	case "GET /v1/ocr/uploads/upl_1":
		state := f.uploadState
		if state == "reserved-put" {
			state = "uploaded"
		}
		reply(200, map[string]any{"upload_id": "upl_1", "status": state})
	case "POST /v1/ocr/uploads/upl_1/complete":
		f.uploadState = "accepted"
		reply(200, map[string]any{"upload_id": "upl_1", "status": "uploaded"})
	case "POST /v1/ocr/jobs":
		_ = json.NewDecoder(r.Body).Decode(&f.jobRequest)
		reply(202, map[string]any{"job_id": "job_1", "status": "accepted", "created_at": "2026-10-04T00:00:00Z"})
	case "GET /v1/ocr/jobs/job_1":
		f.jobPolls++
		status := "processing"
		if f.jobPolls > 1 {
			status = f.jobFinal
		}
		reply(200, map[string]any{"job_id": "job_1", "status": status, "created_at": "2026-10-04T00:00:00Z"})
	case "GET /v1/ocr/jobs/job_1/result":
		reply(200, map[string]any{
			"fields": map[string]any{
				"per_100g.energy_kcal": map[string]any{"value": 430, "confidence": 0.93, "evidence": []any{map[string]any{}}},
			},
			"validation_failures": []any{map[string]any{"code": "sugars_exceed_carbohydrate", "severity": "warning"}},
			"cost":                map[string]any{"currency": "USD", "decimal": "0.0015"},
		})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *fakeDI) client(t *testing.T) *Client {
	c, err := NewClient(Config{
		UploadURL: f.server.URL, JobURL: f.server.URL,
		KeyID: "kora-v1", Tenant: "ten_kora_public", SecretHex: clientSecretHex,
	}, f.server.Client())
	require.NoError(t, err)
	c.pause = time.Millisecond
	return c
}

func TestReadRunsUploadAndExtractionThroughDocumentIntelligence(t *testing.T) {
	fake := newFakeDI(t, "completed")
	photo := []byte("\xff\xd8label")

	read, err := fake.client(t).Read(t.Context(), photo, "image/jpeg")

	require.NoError(t, err)
	assert.Equal(t, photo, fake.stored)
	assert.Equal(t, map[string]any{"schema_id": "kora.nutrition_label", "schema_version": "1"}, fake.jobRequest["extraction"])
	assert.Equal(t, "interactive", fake.jobRequest["processing_class"])
	assert.Len(t, fake.idempotency, 2)
	assert.NotEqual(t, fake.idempotency[0], fake.idempotency[1])
	assert.InDelta(t, 0.93, read.Fields["per_100g.energy_kcal"].Confidence, 1e-9)
	assert.Equal(t, []Failure{{Code: "sugars_exceed_carbohydrate", Severity: "warning"}}, read.Failures)
	assert.InDelta(t, 0.0015, read.CostUSD, 1e-12)
}

func TestReadAcceptsReviewRequiredResults(t *testing.T) {
	read, err := newFakeDI(t, "review_required").client(t).Read(t.Context(), []byte("x"), "image/jpeg")
	require.NoError(t, err)
	require.Equal(t, "review_required", read.Status)
}

func TestReadTreatsARejectedJobAsUnreadable(t *testing.T) {
	_, err := newFakeDI(t, "rejected").client(t).Read(t.Context(), []byte("x"), "image/jpeg")
	assert.True(t, errors.Is(err, ErrUnreadable))
}

func TestReadStopsAtTheCallerDeadline(t *testing.T) {
	fake := newFakeDI(t, "processing")
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()

	_, err := fake.client(t).Read(ctx, []byte("x"), "image/jpeg")

	assert.ErrorIs(t, err, context.DeadlineExceeded)
}

func TestNewClientIsNilWhenUnconfiguredAndRejectsBadConfig(t *testing.T) {
	c, err := NewClient(Config{}, nil)
	assert.NoError(t, err)
	assert.Nil(t, c)

	for name, cfg := range map[string]Config{
		"tenant":   {UploadURL: "http://u", JobURL: "http://j", KeyID: "k", Tenant: "kora", SecretHex: clientSecretHex},
		"secret":   {UploadURL: "http://u", JobURL: "http://j", KeyID: "k", Tenant: "ten_kora", SecretHex: "zz"},
		"short":    {UploadURL: "http://u", JobURL: "http://j", KeyID: "k", Tenant: "ten_kora", SecretHex: testSecretHex},
		"half-set": {UploadURL: "http://u", Tenant: "ten_kora"},
	} {
		_, err := NewClient(cfg, nil)
		assert.Error(t, err, name)
	}
}
