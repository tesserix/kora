package labelocr

import (
	"bytes"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestLabelAPIReportsReviewOutageSeparatelyFromUnreadableImage(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
		code   string
		budget Budget
		calls  int
	}{
		{"review service unavailable", errors.New("synthetic provider outage"), http.StatusServiceUnavailable, "ai_analysis_unavailable", nil, 1},
		{"review confirms no label", ErrUnreadable, http.StatusUnprocessableEntity, "label_unreadable", nil, 1},
		{"quota exhausted before review", nil, http.StatusTooManyRequests, "budget_exhausted", &oneAttemptBudget{}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			router := gin.New()
			router.Use(func(c *gin.Context) { c.Set("user_id", uuid.New()) })
			reviewer := &stubReviewer{err: tc.err}
			budget := tc.budget
			if budget == nil {
				budget = &stubBudget{within: true}
			}
			router.POST("/label", NewHandler(&stubReader{read: Read{Status: "review_required"}}, budget, reviewer).Read)
			var body bytes.Buffer
			form := multipart.NewWriter(&body)
			part, err := form.CreateFormFile("file", "label.jpg")
			require.NoError(t, err)
			_, err = part.Write(jpeg)
			require.NoError(t, err)
			require.NoError(t, form.Close())
			request := httptest.NewRequest(http.MethodPost, "/label", &body)
			request.Header.Set("Content-Type", form.FormDataContentType())
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			require.Equal(t, tc.status, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), tc.code)
			require.NotContains(t, response.Body.String(), "synthetic provider outage")
			require.Equal(t, tc.calls, reviewer.calls)
		})
	}
}
