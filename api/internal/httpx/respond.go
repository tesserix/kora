// Package httpx defines the JSON response envelope shared by all handlers.
package httpx

import "github.com/gin-gonic/gin"

type errorBody struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func Error(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, errorBody{Error: code, Message: message})
}

func OK(c *gin.Context, data any) {
	c.JSON(200, gin.H{"data": data})
}

// OKWithMeta responds with the standard data envelope plus a meta object, for
// the few endpoints that must report something about the operation that is not
// part of the resource itself. Additive: OK's shape is unchanged.
func OKWithMeta(c *gin.Context, data any, meta any) {
	c.JSON(200, gin.H{"data": data, "meta": meta})
}
