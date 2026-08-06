package server

import (
	"fmt"
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/admin"
	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/auth"
	"github.com/tesserix/kora/api/internal/bffauth"
	"github.com/tesserix/kora/api/internal/billing"
	"github.com/tesserix/kora/api/internal/challenges"
	"github.com/tesserix/kora/api/internal/coach"
	"github.com/tesserix/kora/api/internal/compare"
	"github.com/tesserix/kora/api/internal/dashboard"
	"github.com/tesserix/kora/api/internal/devices"
	"github.com/tesserix/kora/api/internal/feedback"
	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/groups"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/memory"
	"github.com/tesserix/kora/api/internal/notifications"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/onboarding"
	"github.com/tesserix/kora/api/internal/pins"
	"github.com/tesserix/kora/api/internal/resolve"
	"github.com/tesserix/kora/api/internal/savedmeals"
	"github.com/tesserix/kora/api/internal/social"
	"github.com/tesserix/kora/api/internal/tracking"
	"github.com/tesserix/kora/api/internal/user"
)

// Deps carries the wired dependencies for the router. Fields are added as
// packages come online (DB in Task 3, Verifier in Task 4).
type Deps struct {
	DB       *gorm.DB
	Verifier auth.TokenVerifier
	Resolver *resolve.Handler
	// Provider is the AI backend the coach's Q&A endpoint generates text
	// with. If nil (e.g. GEMINI_API_KEY unset), coach.Service.Ask degrades
	// gracefully instead of calling it — /coach/nudges is unaffected either
	// way since it never touches the provider.
	Provider ai.Provider
	// ResolveCache is the SAME cache instance the resolve engine reads
	// Resolutions from (see cmd/api/main.go's buildResolveHandler). It is
	// wired into foodlog.Service so a post-log correction can evict the
	// stale cached Resolution for the corrected phrase immediately, instead
	// of waiting out the cache's TTL. Nil when the resolve engine is
	// disabled (no GEMINI_API_KEY) or Redis is unreachable — foodlog.Service
	// treats a nil cache as a silent no-op.
	ResolveCache ai.Cache
	// BFFHMACKey is the shared secret the tesserix-home admin portal signs
	// /v1/admin/* requests with. When nil the admin routes are not mounted
	// at all, so an unconfigured environment answers 404 rather than 401 —
	// the difference matters when diagnosing a deployment.
	BFFHMACKey []byte
}

func NewRouter(deps Deps) *gin.Engine {
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(RequestLogger())

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
		notificationsSvc := notifications.NewService(notifications.NewRepository(deps.DB), groups.NewRepository(deps.DB))
		notificationsHandler := notifications.NewHandler(notificationsSvc)

		v1 := r.Group("/v1", auth.Middleware(deps.Verifier))
		v1.Use(user.ResolveMiddleware(userRepo))
		v1.GET("/me", userHandler.Me)
		v1.PATCH("/me/share-progress", userHandler.UpdateShareProgress)
		v1.POST("/onboarding", onboardingHandler.Submit)
		v1.GET("/notifications", notificationsHandler.List)
		v1.GET("/notifications/unread-count", notificationsHandler.UnreadCount)
		v1.POST("/notifications/read", notificationsHandler.MarkAllRead)

		devicesHandler := devices.NewHandler(devices.NewRepository(deps.DB))
		v1.POST("/devices", devicesHandler.Register)
		v1.DELETE("/devices/:token", devicesHandler.Delete)

		foodRepo := nutrition.NewRepository(deps.DB)
		logRepo := foodlog.NewRepository(deps.DB)
		// deps.ResolveCache may be a nil ai.Cache (resolve engine disabled or
		// Redis unreachable); WithResolutionCache treats a nil cache as a
		// silent no-op, so this wiring is safe either way.
		logHandler := foodlog.NewHandler(foodlog.NewService(logRepo, foodRepo).WithResolutionCache(deps.ResolveCache), logRepo)
		v1.POST("/logs", logHandler.Create)
		v1.GET("/logs", logHandler.List)
		v1.GET("/logs/:id", logHandler.Get)
		v1.PATCH("/logs/:id", logHandler.Update)
		v1.DELETE("/logs/:id", logHandler.Delete)
		v1.POST("/logs/copy-day", logHandler.CopyDay)
		v1.POST("/logs/:id/repeat", logHandler.Repeat)
		v1.POST("/logs/batch", logHandler.CreateBatch)

		memSvc := memory.NewService(logRepo)
		memoryHandler := memory.NewHandler(memSvc)
		v1.GET("/memory", memoryHandler.Get)

		nutritionHandler := nutrition.NewHandler(foodRepo)
		v1.GET("/foods", nutritionHandler.Search)

		// Admin surface. A SEPARATE group from v1: /v1 carries
		// auth.Middleware (Firebase end-user tokens) and these callers are
		// platform admins with no Firebase identity and no Kora user row.
		// Gin's radix tree keeps /v1/foods and /v1/admin/foods distinct, so
		// the two groups never collide.
		if len(deps.BFFHMACKey) > 0 {
			adminHandler := admin.NewHandler(
				admin.NewRepository(deps.DB),
				admin.NewMutationRepository(deps.DB, resolveGeneration(deps.ResolveCache)),
			)
			adminGroup := r.Group("/v1/admin", bffauth.Middleware(deps.BFFHMACKey, 0))
			adminGroup.GET("/foods", adminHandler.ListFoods)
			adminGroup.GET("/foods/:id", adminHandler.GetFood)
			adminGroup.GET("/events", adminHandler.ListEvents)
			adminGroup.POST("/foods", adminHandler.CreateFood)
			adminGroup.PATCH("/foods/:id", adminHandler.UpdateFood)
			adminGroup.DELETE("/foods/:id", adminHandler.SoftDeleteFood)
		}

		pinsHandler := pins.NewHandler(pins.NewService(pins.NewRepository(deps.DB), foodRepo))
		v1.GET("/pins", pinsHandler.List)
		v1.POST("/pins", pinsHandler.Create)
		v1.DELETE("/pins/:foodItemId", pinsHandler.Delete)

		smHandler := savedmeals.NewHandler(savedmeals.NewService(savedmeals.NewRepository(deps.DB), foodRepo))
		v1.GET("/saved-meals", smHandler.List)
		v1.POST("/saved-meals", smHandler.Create)
		v1.PUT("/saved-meals/:id", smHandler.Update)
		v1.DELETE("/saved-meals/:id", smHandler.Delete)

		trackingRepo := tracking.NewRepository(deps.DB)
		trackingHandler := tracking.NewHandler(trackingRepo)
		v1.POST("/water", trackingHandler.Add)
		v1.GET("/water", trackingHandler.DayTotal)
		v1.POST("/weight", trackingHandler.AddWeight)
		v1.GET("/weight", trackingHandler.ListWeight)

		socialRepo := social.NewRepository(deps.DB)
		socialHandler := social.NewHandler(social.NewService(socialRepo, userRepo).WithNotifier(notificationsSvc))
		v1.GET("/friends", socialHandler.ListFriends)
		v1.GET("/friends/requests", socialHandler.ListRequests)
		v1.POST("/friends/requests", socialHandler.SendRequest)
		v1.POST("/friends/requests/:id/accept", socialHandler.Accept)
		v1.POST("/friends/requests/:id/decline", socialHandler.Decline)
		v1.DELETE("/friends/:userId", socialHandler.Unfriend)
		v1.GET("/friends/code", socialHandler.Code)

		compareHandler := compare.NewHandler(compare.NewService(socialRepo, userRepo, logRepo))
		v1.GET("/friends/progress", compareHandler.Get)

		dashSvc := dashboard.NewService(logRepo, trackingRepo, deps.DB)
		dashboardHandler := dashboard.NewHandler(dashSvc)
		v1.GET("/dashboard", dashboardHandler.Get)

		groupsRepo := groups.NewRepository(deps.DB)
		groupsSvc := groups.NewService(groupsRepo, socialRepo, groups.NewCode).WithNotifier(notificationsSvc)
		groupsHandler := groups.NewHandler(groupsSvc, groupsRepo, compare.NewService(socialRepo, userRepo, logRepo))
		v1.POST("/groups", groupsHandler.Create)
		v1.GET("/groups", groupsHandler.List)
		v1.POST("/groups/join", groupsHandler.Join)
		v1.GET("/groups/:id", groupsHandler.Detail)
		v1.GET("/groups/:id/code", groupsHandler.Code)
		v1.GET("/groups/:id/progress", groupsHandler.Progress)
		v1.POST("/groups/:id/invite", groupsHandler.Invite)
		v1.DELETE("/groups/:id/members/:userId", groupsHandler.RemoveMember)
		v1.PATCH("/groups/:id", groupsHandler.Rename)
		v1.DELETE("/groups/:id", groupsHandler.Delete)

		challengesRepo := challenges.NewRepository(deps.DB)
		challengesHandler := challenges.NewHandler(challenges.NewService(challengesRepo, groupsRepo, logRepo).WithNotifier(notificationsSvc))
		v1.POST("/groups/:id/challenges", challengesHandler.Create)
		v1.GET("/groups/:id/challenges", challengesHandler.List)
		v1.POST("/challenges/:cid/join", challengesHandler.Join)
		v1.DELETE("/challenges/:cid/join", challengesHandler.Leave)
		v1.GET("/challenges/:cid", challengesHandler.Detail)
		v1.DELETE("/challenges/:cid", challengesHandler.Delete)

		if deps.Resolver != nil {
			v1.POST("/resolve/text", deps.Resolver.ResolveText)
			v1.POST("/resolve/photo", deps.Resolver.ResolvePhoto)
			v1.POST("/resolve/voice", deps.Resolver.ResolveVoice)
			v1.POST("/resolve/barcode", deps.Resolver.ResolveBarcode)
		}

		coachGrounder := coach.NewGrounder(dashSvc, logRepo, memSvc, trackingRepo)
		coachMeter := billing.NewMeter(deps.DB)
		coachThread := coach.NewThreadRepository(deps.DB)
		coachHandler := coach.NewHandler(coach.NewService(&coachGrounder, deps.Provider, coachMeter, &coachThread))
		v1.GET("/coach/nudges", coachHandler.Nudges)
		v1.POST("/coach/ask", coachHandler.Ask)
		v1.GET("/coach/thread", coachHandler.Thread)

		feedbackHandler := feedback.NewHandler(feedback.NewRepository(deps.DB))
		v1.POST("/feedback", feedbackHandler.Create)
	}

	r.NoRoute(func(c *gin.Context) {
		httpx.Error(c, http.StatusNotFound, "not_found", "route not found")
	})

	return r
}

// resolveGeneration narrows the SAME ai.Cache instance the resolve engine
// reads from to its generation surface. It deliberately type-asserts rather
// than constructing a cache of its own: the generation counter lives on
// RedisCache and is exposed through a separate small interface (ai.Generation),
// so nothing structurally forces the admin bump path and the resolve path onto
// the same Redis client and DB index. A second RedisCache — especially one on
// a different DB index — would make every admin bump invisible to the
// resolver, silently, with the mutation still reporting success to the
// operator. The identity this preserves is pinned end-to-end by
// TestAdminMutationBumpsTheSameCacheInstanceWiredIntoDeps.
//
// The two degradation paths are NOT the same event and are deliberately
// logged differently:
//
//   - cache == nil — the resolve engine is disabled (no GEMINI_API_KEY) or
//     Redis was unreachable at startup, so buildResolveHandler returned no
//     cache at all. There is nothing to invalidate and nothing is wrong; INFO.
//   - cache is non-nil but does NOT implement ai.Generation — a real cache is
//     serving reads that this path cannot invalidate. That is the silent-drift
//     fault this whole function exists to prevent, and it would otherwise only
//     surface as users being served stale macros for up to the resolve cache's
//     24h TTL; WARN.
//
// Either way the admin surface still mounts, backed by ai.NoCache{}, whose
// BumpGeneration is a silent no-op — an unbumpable cache must not take the
// food editor offline.
func resolveGeneration(cache ai.Cache) ai.Generation {
	if cache == nil {
		slog.Info("admin mutations: no resolve cache configured; nothing to invalidate")
		return ai.NoCache{}
	}
	if g, ok := cache.(ai.Generation); ok {
		return g
	}
	slog.Warn("admin mutations: resolve cache exposes no generation counter; food edits will NOT invalidate cached resolutions",
		"cache_type", fmt.Sprintf("%T", cache))
	return ai.NoCache{}
}
