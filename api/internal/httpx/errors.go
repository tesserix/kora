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
	// Attach the real error so RequestLogger emits it on the `errors` field of
	// this request's http_request line, alongside request_id/route/user_id. The
	// CLIENT still gets only "something went wrong" — this changes what we can
	// see, not what we disclose.
	//
	// Without this, a 500 left no trace anywhere: the detail died here and the
	// AI layer logs nothing of its own. That silence is not a small gap. Photo
	// capture was broken by THREE stacked bugs (#82 client, #79 gateway, and a
	// 3s vision budget feeding a text-only fallback), and each one presented
	// identically — a 500 with no detail — so fixing one just revealed the next
	// with no new information. RequestLogger was built with this hook waiting
	// for its first caller; this is it.
	//
	// Errors reaching here are our own wrapped internal errors, so keep it that
	// way: never c.Error() something carrying a request body or a user's words.
	_ = c.Error(err)
	Error(c, http.StatusInternalServerError, "internal_error", "something went wrong")
}
