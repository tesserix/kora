package server

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/auth"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/onboarding"
	"github.com/tesserix/kora/api/internal/user"
)

// Deps carries the wired dependencies for the router. Fields are added as
// packages come online (DB in Task 3, Verifier in Task 4).
type Deps struct {
	DB       *gorm.DB
	Verifier auth.TokenVerifier
}

func NewRouter(deps Deps) *gin.Engine {
	r := gin.New()
	r.Use(gin.Recovery())

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	r.GET("/ready", func(c *gin.Context) {
		if deps.DB == nil {
			httpx.Error(c, http.StatusServiceUnavailable, "not_ready", "database unavailable")
			return
		}
		sqlDB, err := deps.DB.DB()
		if err != nil || sqlDB.Ping() != nil {
			httpx.Error(c, http.StatusServiceUnavailable, "not_ready", "database unavailable")
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ready"})
	})

	if deps.DB != nil && deps.Verifier != nil {
		userRepo := user.NewRepository(deps.DB)
		userHandler := user.NewHandler(userRepo)
		onboardingHandler := onboarding.NewHandler(userRepo)

		v1 := r.Group("/v1", auth.Middleware(deps.Verifier))
		v1.GET("/me", userHandler.Me)
		v1.POST("/onboarding", onboardingHandler.Submit)
	}

	r.NoRoute(func(c *gin.Context) {
		httpx.Error(c, http.StatusNotFound, "not_found", "route not found")
	})

	return r
}
