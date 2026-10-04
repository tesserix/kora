package labelocr

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

const (
	readTimeout      = 25 * time.Second
	maxResponseBytes = 4 << 20
	minSecretBytes   = 32
	maxPause         = time.Second
)

var tenantPattern = regexp.MustCompile(`^ten_[A-Za-z0-9_]{1,64}$`)

// Config is Kora's signed workload identity for Document Intelligence (ADR-0009).
type Config struct {
	UploadURL string
	JobURL    string
	KeyID     string
	Tenant    string
	SecretHex string
}

// Read is the kora.nutrition_label extraction of one photo.
type Read struct {
	Fields   map[string]Field
	Failures []Failure
	// CostUSD is what Document Intelligence measured; zero when it reported none.
	CostUSD float64
}

// Client signs every call as Kora and never sees a storage bucket or path.
type Client struct {
	uploadURL, jobURL, keyID, tenant string
	secret                           []byte
	http                             *http.Client
	pause                            time.Duration
}

// NewClient returns nil when label OCR is unconfigured and an error when it is half-configured.
func NewClient(cfg Config, client *http.Client) (*Client, error) {
	values := []string{cfg.UploadURL, cfg.JobURL, cfg.KeyID, cfg.Tenant, cfg.SecretHex}
	set := 0
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			set++
		}
	}
	if set == 0 {
		return nil, nil
	}
	if set != len(values) {
		return nil, errors.New("labelocr: OCR_UPLOAD_URL, OCR_JOB_URL, OCR_KEY_ID, OCR_TENANT and OCR_KEY_SECRET must be set together")
	}
	if !tenantPattern.MatchString(cfg.Tenant) {
		return nil, fmt.Errorf("labelocr: tenant %q is not a ten_ scope", cfg.Tenant)
	}
	secret, err := hex.DecodeString(strings.TrimSpace(cfg.SecretHex))
	if err != nil {
		return nil, fmt.Errorf("labelocr: key secret is not hex: %w", err)
	}
	if len(secret) < minSecretBytes {
		return nil, fmt.Errorf("labelocr: key secret is %d bytes, need %d", len(secret), minSecretBytes)
	}
	if client == nil {
		client = &http.Client{Timeout: readTimeout}
	}
	return &Client{
		uploadURL: strings.TrimRight(cfg.UploadURL, "/"), jobURL: strings.TrimRight(cfg.JobURL, "/"),
		keyID: cfg.KeyID, tenant: cfg.Tenant, secret: secret, http: client, pause: 250 * time.Millisecond,
	}, nil
}

func sign(secret []byte, keyID, tenant string, ts int64, method, path string) string {
	mac := hmac.New(sha256.New, secret)
	fmt.Fprintf(mac, "%s\n%s\n%d\n%s\n%s", keyID, tenant, ts, method, path)
	return hex.EncodeToString(mac.Sum(nil))
}

type upload struct {
	UploadID        string            `json:"upload_id"`
	Status          string            `json:"status"`
	UploadURL       string            `json:"upload_url"`
	RequiredHeaders map[string]string `json:"required_headers"`
}

type job struct {
	JobID  string `json:"job_id"`
	Status string `json:"status"`
}

type result struct {
	Fields             map[string]Field `json:"fields"`
	ValidationFailures []Failure        `json:"validation_failures"`
	Cost               *struct {
		Currency string `json:"currency"`
		Decimal  string `json:"decimal"`
	} `json:"cost"`
}

// Read uploads one label photo and extracts it with the kora.nutrition_label v1 schema.
func (c *Client) Read(ctx context.Context, photo []byte, mime string) (read Read, err error) {
	ctx, span := otel.Tracer("github.com/tesserix/kora/api/internal/labelocr").Start(ctx, "ocr.job")
	defer func() {
		if err != nil {
			span.SetStatus(codes.Error, "label read failed")
			span.SetAttributes(attribute.Bool("kora.ocr.unreadable", errors.Is(err, ErrUnreadable)))
		} else {
			span.SetAttributes(attribute.Int("kora.ocr.fields", len(read.Fields)), attribute.Int("kora.ocr.failures", len(read.Failures)))
		}
		span.End()
	}()
	ctx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()

	sum := sha256.Sum256(photo)
	digest := hex.EncodeToString(sum[:])
	// A retry of the same photo within ten minutes replays rather than re-extracts.
	key := fmt.Sprintf("kora-%s-%d", digest[:32], time.Now().Unix()/600)

	var up upload
	if err := c.call(ctx, http.MethodPost, c.uploadURL, "/v1/ocr/uploads", map[string]any{
		"content_type": mime, "content_length": len(photo), "sha256": "sha256:" + digest,
	}, key+"-u", &up); err != nil {
		return Read{}, err
	}
	uploadPath := "/v1/ocr/uploads/" + up.UploadID
	var current upload
	if err := c.call(ctx, http.MethodGet, c.uploadURL, uploadPath, nil, "", &current); err != nil {
		return Read{}, err
	}
	if current.Status == "reserved" {
		if err := c.put(ctx, up, photo); err != nil {
			return Read{}, err
		}
		if err := c.call(ctx, http.MethodPost, c.uploadURL, uploadPath+"/complete", nil, "", &current); err != nil {
			return Read{}, err
		}
	}
	if err := c.wait(ctx, c.uploadURL, uploadPath, func(status string) (bool, error) {
		switch status {
		case "accepted":
			return true, nil
		case "rejected", "expired":
			return true, ErrUnreadable
		}
		return false, nil
	}); err != nil {
		return Read{}, err
	}

	var created job
	if err := c.call(ctx, http.MethodPost, c.jobURL, "/v1/ocr/jobs", map[string]any{
		"source":           map[string]string{"upload_id": up.UploadID},
		"document_type":    "general",
		"output":           map[string]bool{"text": false, "markdown": false, "layout": false, "evidence": true},
		"extraction":       map[string]string{"schema_id": "kora.nutrition_label", "schema_version": "1"},
		"processing_class": "interactive",
	}, key+"-j", &created); err != nil {
		return Read{}, err
	}
	jobPath := "/v1/ocr/jobs/" + created.JobID
	if err := c.wait(ctx, c.jobURL, jobPath, func(status string) (bool, error) {
		switch status {
		case "completed", "partial", "review_required":
			return true, nil
		case "rejected", "cancelled", "cancelling":
			return true, ErrUnreadable
		}
		return false, nil
	}); err != nil {
		return Read{}, err
	}

	var res result
	if err := c.call(ctx, http.MethodGet, c.jobURL, jobPath+"/result", nil, "", &res); err != nil {
		return Read{}, err
	}
	read = Read{Fields: res.Fields, Failures: res.ValidationFailures}
	if res.Cost != nil && res.Cost.Currency == "USD" {
		read.CostUSD, _ = strconv.ParseFloat(res.Cost.Decimal, 64) // the schema pattern guarantees a decimal
	}
	return read, nil
}

func (c *Client) wait(ctx context.Context, base, path string, settled func(string) (bool, error)) error {
	pause := c.pause
	for {
		var state struct {
			Status string `json:"status"`
		}
		if err := c.call(ctx, http.MethodGet, base, path, nil, "", &state); err != nil {
			return err
		}
		if done, err := settled(state.Status); done {
			return err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("labelocr: wait for %s: %w", state.Status, ctx.Err())
		case <-time.After(pause):
		}
		pause = min(pause*3/2, maxPause)
	}
}

func (c *Client) put(ctx context.Context, up upload, photo []byte) error {
	if !strings.HasPrefix(up.UploadURL, "https://") {
		return errors.New("labelocr: upload capability is not https")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, up.UploadURL, bytes.NewReader(photo))
	if err != nil {
		return fmt.Errorf("labelocr: build upload: %w", err)
	}
	for k, v := range up.RequiredHeaders {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("labelocr: upload: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("labelocr: upload returned %d", resp.StatusCode)
	}
	return nil
}

func (c *Client) call(ctx context.Context, method, base, path string, body any, idempotency string, into any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("labelocr: encode %s: %w", path, err)
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, reader)
	if err != nil {
		return fmt.Errorf("labelocr: build %s: %w", path, err)
	}
	ts := time.Now().Unix()
	req.Header.Set("X-OCR-Key-Id", c.keyID)
	req.Header.Set("X-OCR-Tenant-Id", c.tenant)
	req.Header.Set("X-OCR-Timestamp", strconv.FormatInt(ts, 10))
	req.Header.Set("X-OCR-Signature", sign(c.secret, c.keyID, c.tenant, ts, method, req.URL.RequestURI()))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if idempotency != "" {
		req.Header.Set("Idempotency-Key", idempotency)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("labelocr: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return fmt.Errorf("labelocr: read %s: %w", path, err)
	}
	if resp.StatusCode/100 != 2 {
		var e struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(raw, &e) // the status alone is enough when the body is not the error shape
		if resp.StatusCode == http.StatusUnprocessableEntity {
			return fmt.Errorf("labelocr: %s %s: %s: %w", method, path, e.Code, ErrUnreadable)
		}
		return fmt.Errorf("labelocr: %s %s returned %d %s", method, path, resp.StatusCode, e.Code)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		return fmt.Errorf("labelocr: decode %s: %w", path, err)
	}
	return nil
}
