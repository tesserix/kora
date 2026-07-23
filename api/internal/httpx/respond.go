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
