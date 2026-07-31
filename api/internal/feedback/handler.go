package feedback

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// maxSubjectChars caps the subject, a one-line summary of the bug or request.
const maxSubjectChars = 200

// maxDescriptionChars caps the free-text description. Generous enough for a
// few paragraphs of repro steps or context while bounding the permanent,
// unretained growth of the feedback table.
const maxDescriptionChars = 4000

// maxContextFieldChars caps each client-context field (app_version,
// platform, os_version, device_model). These are short, display-only
// strings — this is generous headroom over any real value, never trusted
// for authorisation.
const maxContextFieldChars = 100

// maxCreateBodyBytes is the hard cap applied to the raw request body ahead
// of JSON parsing, mirroring maxAskBodyBytes in package coach. The headroom
// above the sum of the char caps covers worst-case 4-byte-per-rune UTF-8
// across every field plus the JSON wrapper's fixed overhead.
const maxCreateBodyBytes = (maxSubjectChars+maxDescriptionChars+4*maxContextFieldChars)*4 + 1<<10

// Handler exposes feedback capture over HTTP.
type Handler struct {
	repo Repository
}

// NewHandler builds a Handler over repo.
func NewHandler(repo Repository) Handler {
	return Handler{repo: repo}
}

// createRequest is the POST /v1/feedback request body. UserID is
// deliberately absent: the reporter is always taken from the authenticated
// context (see Create), so a user_id present on the wire is simply never
// read here, not merely overwritten after the fact.
type createRequest struct {
	Kind        string `json:"kind"`
	Subject     string `json:"subject"`
	Description string `json:"description"`
	AppVersion  string `json:"app_version"`
	Platform    string `json:"platform"`
	OSVersion   string `json:"os_version"`
	DeviceModel string `json:"device_model"`
}

// Create stores a bug report or feature request for the authenticated user.
func (h Handler) Create(c *gin.Context) {
	uid, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}

	// Bound the raw body BEFORE JSON parsing so an oversized payload is
	// rejected while streaming in, not after Gin has fully buffered it.
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxCreateBodyBytes)

	var req createRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed request body")
		return
	}

	kind := Kind(req.Kind)
	if !kind.Valid() {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "kind must be bug or feature")
		return
	}

	// Trim before validating so a subject/description of all whitespace is
	// treated as empty rather than accepted.
	subject := strings.TrimSpace(req.Subject)
	if subject == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "subject is required")
		return
	}
	if len(subject) > maxSubjectChars {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "subject exceeds maximum length")
		return
	}

	description := strings.TrimSpace(req.Description)
	if description == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "description is required")
		return
	}
	if len(description) > maxDescriptionChars {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "description exceeds maximum length")
		return
	}

	appVersion := strings.TrimSpace(req.AppVersion)
	platform := strings.TrimSpace(req.Platform)
	osVersion := strings.TrimSpace(req.OSVersion)
	deviceModel := strings.TrimSpace(req.DeviceModel)
	if len(appVersion) > maxContextFieldChars ||
		len(platform) > maxContextFieldChars ||
		len(osVersion) > maxContextFieldChars ||
		len(deviceModel) > maxContextFieldChars {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "client context field exceeds maximum length")
		return
	}

	saved, err := h.repo.Create(c.Request.Context(), Feedback{
		UserID:      uid,
		Kind:        kind,
		Subject:     subject,
		Description: description,
		AppVersion:  appVersion,
		Platform:    platform,
		OSVersion:   osVersion,
		DeviceModel: deviceModel,
	})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not save feedback")
		return
	}

	httpx.OK(c, gin.H{"id": saved.ID, "status": saved.Status})
}
