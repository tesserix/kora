package httpx

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
)

// ValidationError is a client-safe, 400-worthy error. Its message is intended
// for display. Any error that is NOT a ValidationError is treated as infra and
// returned as a generic 500 (its detail is never sent to the client).
type ValidationError struct {
	Message string
}

func (e ValidationError) Error() string { return e.Message }

func IsValidation(err error) (string, bool) {
	var ve ValidationError
	if errors.As(err, &ve) {
		return ve.Message, true
	}
	return "", false
}

func RespondServiceError(c *gin.Context, err error) {
	if msg, ok := IsValidation(err); ok {
		Error(c, http.StatusBadRequest, "invalid_input", msg)
		return
	}
	Error(c, http.StatusInternalServerError, "internal_error", "something went wrong")
}
