package server

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/auth"
	"github.com/tesserix/kora/api/internal/dashboard"
	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/onboarding"
	"github.com/tesserix/kora/api/internal/resolve"
	"github.com/tesserix/kora/api/internal/tracking"
	"github.com/tesserix/kora/api/internal/user"
)

// Deps carries the wired dependencies for the router. Fields are added as
// packages come online (DB in Task 3, Verifier in Task 4).
type Deps struct {
	DB       *gorm.DB
	Verifier auth.TokenVerifier
	Resolver *resolve.Handler
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
		v1.Use(user.ResolveMiddleware(userRepo))
		v1.GET("/me", userHandler.Me)
		v1.POST("/onboarding", onboardingHandler.Submit)

		foodRepo := nutrition.NewRepository(deps.DB)
		logRepo := foodlog.NewRepository(deps.DB)
		logHandler := foodlog.NewHandler(foodlog.NewService(logRepo, foodRepo), logRepo)
		v1.POST("/logs", logHandler.Create)
		v1.GET("/logs", logHandler.List)
		v1.PATCH("/logs/:id", logHandler.Update)
		v1.DELETE("/logs/:id", logHandler.Delete)
		v1.POST("/logs/copy-day", logHandler.CopyDay)
		v1.POST("/logs/:id/repeat", logHandler.Repeat)

		nutritionHandler := nutrition.NewHandler(foodRepo)
		v1.GET("/foods", nutritionHandler.Search)

		trackingRepo := tracking.NewRepository(deps.DB)
		trackingHandler := tracking.NewHandler(trackingRepo)
		v1.POST("/water", trackingHandler.Add)
		v1.GET("/water", trackingHandler.DayTotal)
		v1.POST("/weight", trackingHandler.AddWeight)
		v1.GET("/weight", trackingHandler.ListWeight)

		dashboardHandler := dashboard.NewHandler(dashboard.NewService(logRepo, trackingRepo, deps.DB))
		v1.GET("/dashboard", dashboardHandler.Get)

		if deps.Resolver != nil {
			v1.POST("/resolve/text", deps.Resolver.ResolveText)
			v1.POST("/resolve/photo", deps.Resolver.ResolvePhoto)
			v1.POST("/resolve/voice", deps.Resolver.ResolveVoice)
			v1.POST("/resolve/barcode", deps.Resolver.ResolveBarcode)
		}
	}

	r.NoRoute(func(c *gin.Context) {
		httpx.Error(c, http.StatusNotFound, "not_found", "route not found")
	})

	return r
}
