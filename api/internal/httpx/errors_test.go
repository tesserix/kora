package httpx

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestRespondServiceErrorValidation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	RespondServiceError(c, ValidationError{Message: "quantity must be positive"})
	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.JSONEq(t, `{"error":"invalid_input","message":"quantity must be positive"}`, w.Body.String())
}

func TestRespondServiceErrorInfraIsGenericAnd500(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	RespondServiceError(c, fmt.Errorf("foodlog: db exploded: %w", fmt.Errorf("pq: connection refused")))
	assert.Equal(t, http.StatusInternalServerError, w.Code)
	// Must NOT leak the internal message.
	assert.JSONEq(t, `{"error":"internal_error","message":"something went wrong"}`, w.Body.String())
}

func TestValidationErrorWrapsAndUnwraps(t *testing.T) {
	wrapped := fmt.Errorf("context: %w", ValidationError{Message: "bad slot"})
	msg, ok := IsValidation(wrapped)
	assert.True(t, ok)
	assert.Equal(t, "bad slot", msg)
}
