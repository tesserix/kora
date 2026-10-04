package server

import (
	"mime"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/tesserix/kora/api/internal/httpx"
)

func limitRequestBody() gin.HandlerFunc {
	return func(c *gin.Context) {
		limit := int64(1 << 20)
		mediaType, _, _ := mime.ParseMediaType(c.GetHeader("Content-Type"))
		if mediaType == "multipart/form-data" {
			// Upload handlers enforce their smaller, media-specific limits.
			limit = 16 << 20
		}
		if c.Request.ContentLength > limit {
			httpx.Error(c, http.StatusRequestEntityTooLarge, "body_too_large", "request body is too large")
			return
		}
		if c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		}
		c.Next()
	}
}
