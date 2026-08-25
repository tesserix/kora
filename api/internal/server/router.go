package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/access"
	"github.com/tesserix/kora/api/internal/admin"
	"github.com/tesserix/kora/api/internal/agents"
	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/assets"
	"github.com/tesserix/kora/api/internal/auth"
	"github.com/tesserix/kora/api/internal/bffauth"
	"github.com/tesserix/kora/api/internal/billing"
	"github.com/tesserix/kora/api/internal/bodyread"
	"github.com/tesserix/kora/api/internal/challenges"
	"github.com/tesserix/kora/api/internal/coach"
	"github.com/tesserix/kora/api/internal/compare"
	"github.com/tesserix/kora/api/internal/dashboard"
	"github.com/tesserix/kora/api/internal/devices"
	"github.com/tesserix/kora/api/internal/fasting"
	"github.com/tesserix/kora/api/internal/feedback"
	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/groups"
	"github.com/tesserix/kora/api/internal/health"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/identity"
	"github.com/tesserix/kora/api/internal/memory"
	"github.com/tesserix/kora/api/internal/mentor"
	"github.com/tesserix/kora/api/internal/notifications"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/onboarding"
	"github.com/tesserix/kora/api/internal/pins"
	"github.com/tesserix/kora/api/internal/ratelimit"
	"github.com/tesserix/kora/api/internal/recipes"
	"github.com/tesserix/kora/api/internal/resolve"
	"github.com/tesserix/kora/api/internal/savedmeals"
	"github.com/tesserix/kora/api/internal/share"
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
	// Agents is the Agentic Registry + Agent Gateway path. When non-nil the
	// coach routes Q&A to whichever published agent declares the guidance
	// skill; when nil it falls back to Provider, which is the pre-registry
	// behaviour. Nil whenever AI_REGISTRY_BASE_URL is unset.
	Agents *agents.Coordinator
	// ResolveCache is the SAME cache instance the resolve engine reads
	// Resolutions from (see cmd/api/main.go's buildResolveHandler). It is
	// wired into foodlog.Service so a post-log correction can evict the
	// stale cached Resolution for the corrected phrase immediately, instead
	// of waiting out the cache's TTL. Nil when the resolve engine is
	// disabled (no GEMINI_API_KEY) or Redis is unreachable — foodlog.Service
	// treats a nil cache as a silent no-op.
	ResolveCache ai.Cache
	// BodyCompositionCache backs bodyread.Reader's cache of validated
	// body-composition readings, keyed by the downscaled screenshot's
	// content hash. NOT the same instance as ResolveCache — ai.Cache is
	// hard-typed to ai.Resolution and cannot carry a bodyread.Result (see
	// bodyread/cache.go) — but it shares the same underlying Redis
	// connection when Redis is reachable (cmd/api/main.go's
	// buildResolveHandler). Nil-safe: bodyread.NewReader is only
	// constructed when Provider is non-nil, and cmd/api/main.go always
	// supplies at least bodyread.NoCache{} rather than a literal nil.
	BodyCompositionCache bodyread.Cache
	// BFFHMACKey is the shared secret the tesserix-home admin portal signs
	// /v1/admin/* requests with. When nil the admin routes are not mounted
	// at all, so an unconfigured environment answers 404 rather than 401 —
	// the difference matters when diagnosing a deployment.
	BFFHMACKey []byte
	// AppleExchanger trades Apple authorization codes for refresh tokens.
	// Nil when the Apple credentials are unset, in which case the endpoint is
	// not mounted at all — an unconfigured environment answers 404 rather
	// than 500, the same choice BFFHMACKey makes above.
	AppleExchanger user.AppleExchanger
	// IdentityDeleter removes the caller's Firebase identity during account
	// deletion. It is the SAME Firebase client the verifier is built from
	// (see cmd/api/main.go), narrowed to its delete surface — verification
	// needs only Google's public keys, deletion needs Admin privileges, so
	// auth keeps them as two interfaces.
	//
	// Nil is tolerated rather than fatal: the identity step runs AFTER the DB
	// delete has committed, so a nil here must degrade to a logged
	// "NEEDS MANUAL CLEANUP" (see unwiredIdentityDeleter), never to a panic
	// that turns a completed deletion into a 500.
	IdentityDeleter user.IdentityDeleter
	// AppleRevoker revokes the user's Apple refresh token before the row that
	// holds it is destroyed. Nil whenever AppleExchanger is nil — Apple is
	// not configured in every environment — and user.Service.Delete skips
	// revocation rather than failing when it is.
	AppleRevoker user.AppleRevoker
	// Cashfree is the payment gateway paid AI top-ups are bought through.
	// Unconfigured leaves every purchase route unmounted — the same choice as
	// AppleExchanger above — so an environment with no gateway advertises no
	// checkout at all rather than one that takes money and grants nothing.
	Cashfree billing.CashfreeConfig
	// Assets is where profile pictures are written (kora#449). Nil in a
	// test-constructed Deps that never set it — defaulted to assets.Noop{}
	// the same way ResolveCache/BodyCompositionCache are, so nothing
	// downstream has to nil-check it.
	Assets assets.Store
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
		// One Service instance backs BOTH DELETE /v1/me and (later) the admin
		// delete endpoint: two implementations of an 18-table cascade is the
		// failure that design exists to prevent. It is built here rather than
		// in main.go because this is the composition root for every other
		// service in the app; main.go builds only external clients.
		userSvc := user.NewService(
			deps.DB,
			deletionCache(deps.ResolveCache, deps.BodyCompositionCache),
			identityDeleter(deps.IdentityDeleter),
			deps.AppleRevoker, // may legitimately be nil; Delete tolerates it
			auditDeletion,
			assetsStore(deps.Assets), // same nil-to-Noop default as identity's avatar wiring
		)
		// avatarURL lets Me/UpdateProfile compose their own avatar_url the same
		// way identity/social/share do (kora#449 task 10) -- WithAvatarURL,
		// not a constructor arg, so every existing NewHandler(repo, svc) call
		// site keeps compiling with "" avatar_url, same default as Noop.
		userHandler := user.NewHandler(userRepo, userSvc).WithAvatarURL(assetsStore(deps.Assets).URL)
		// tracking.NewRepository is a cheap wrapper (holds only *gorm.DB), so
		// constructing it again below at the /weight routes is harmless --
		// both wrap the same deps.DB.
		onboardingHandler := onboarding.NewHandler(userRepo, tracking.NewRepository(deps.DB))
		notificationsSvc := notifications.NewService(notifications.NewRepository(deps.DB), groups.NewRepository(deps.DB))
		notificationsHandler := notifications.NewHandler(notificationsSvc)

		v1 := r.Group("/v1", auth.Middleware(deps.Verifier))
		v1.Use(user.ResolveMiddleware(userRepo))
		billingMeter := billing.NewMeter(deps.DB)
		billingHandler := billing.NewHandler(billingMeter)
		v1.GET("/ai/usage", billingHandler.UsageStatus)
		if deps.Cashfree.Configured() {
			purchases := billing.NewPurchaseHandler(
				billing.NewOrders(deps.DB, billing.NewCashfreeClient(deps.Cashfree)),
				billingMeter,
				deps.Cashfree.SecretKey,
			)
			v1.GET("/ai/packs", purchases.Packs)
			v1.POST("/ai/orders", purchases.CreateOrder)
			v1.GET("/ai/orders", purchases.Orders)
			v1.GET("/ai/orders/:id", purchases.Order)
			// OUTSIDE the v1 group: the caller is Cashfree, which holds no
			// Firebase token. Its own signature is the authentication, checked
			// inside the handler over the raw request body.
			r.POST("/webhooks/cashfree", purchases.Webhook)
		}
		v1.GET("/me", userHandler.Me)
		v1.PATCH("/me", userHandler.UpdateProfile)
		// Mounted unconditionally, unlike the Apple exchange below: Apple
		// requires in-app account deletion, so this route must never be
		// silently absent in any environment.
		v1.DELETE("/me", userHandler.DeleteMe)
		if deps.AppleExchanger != nil {
			appleHandler := user.NewAppleHandler(userRepo, deps.AppleExchanger)
			v1.POST("/me/apple-authorization", appleHandler.Store)
		}
		v1.POST("/onboarding", onboardingHandler.Submit)
		v1.GET("/notifications", notificationsHandler.List)
		v1.GET("/notifications/unread-count", notificationsHandler.UnreadCount)
		v1.POST("/notifications/read", notificationsHandler.MarkAllRead)

		mentorRepo := mentor.NewRepository(deps.DB)
		mentorHandler := mentor.NewHandler(mentor.NewService(mentorRepo))
		v1.GET("/mentor/profile", mentorHandler.GetProfile)
		v1.PUT("/mentor/profile", mentorHandler.PutProfile)
		v1.GET("/mentor/health/days", mentorHandler.ListHealthDays)
		v1.PUT("/mentor/health/days", mentorHandler.PutHealthDays)
		v1.DELETE("/mentor/health/days", mentorHandler.DeleteHealthDays)
		v1.GET("/mentor/commitments", mentorHandler.ListCommitments)
		v1.PUT("/mentor/commitments/:id", mentorHandler.PutCommitment)
		v1.PUT("/mentor/commitments/:id/check-ins", mentorHandler.PutCheckIn)
		v1.PUT("/mentor/proposals/:id/accept", mentorHandler.AcceptProposal)
		v1.GET("/mentor/food-rules", mentorHandler.ListFoodRules)
		v1.PUT("/mentor/food-rules", mentorHandler.PutFoodRules)
		v1.PUT("/mentor/food-rules/:subject/confirm", mentorHandler.ConfirmFoodRule)
		v1.DELETE("/mentor/food-rules/:subject", mentorHandler.DeleteFoodRule)

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

			feedbackAdmin := feedback.NewAdminHandler(feedback.NewRepository(deps.DB))
			adminGroup.GET("/feedback", feedbackAdmin.List)
			adminGroup.PATCH("/feedback/:id", feedbackAdmin.UpdateStatus)

			usersAdmin := user.NewAdminHandler(userRepo, userSvc)
			adminGroup.GET("/users", usersAdmin.List)
			adminGroup.GET("/users/:id", usersAdmin.Get)
			// Irreversible. It shares userSvc with DELETE /v1/me, so both
			// paths run the one 18-table cascade, and auditDeletion below
			// writes the kora_admin_events row inside the same transaction.
			adminGroup.DELETE("/users/:id", usersAdmin.Delete)
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

		// Recipes. Reuses the same ai.Provider instance the coach handler and
		// resolve engine already use — there is no reason recipe parsing
		// would ever need a different one. The parser is nil when that
		// provider is unset (no provider key configured) — Handler.Parse
		// then returns 503 and the manual editor still works, so recipes
		// degrade rather than disappear.
		recipeSvc := recipes.NewService(recipes.NewRepository(deps.DB), foodRepo).
			WithBatchLogger(foodlog.NewService(logRepo, foodRepo))
		var recipeParser *recipes.Parser
		if deps.Provider != nil {
			// Same billing.Meter the coach and the resolve engine use: recipe
			// parsing is gated by the same per-user and global caps, and its
			// calls land in the same ai_usage_events ledger the global cap is
			// computed from. An unmetered AI endpoint would under-protect
			// every other AI feature, not just itself.
			recipeParser = recipes.NewParser(deps.Provider, foodRepo, billing.NewMeter(deps.DB))
		}
		recipeHandler := recipes.NewHandler(recipeSvc, recipeParser)
		v1.GET("/recipes", recipeHandler.List)
		v1.POST("/recipes", recipeHandler.Create)
		v1.POST("/recipes/parse", recipeHandler.Parse)
		v1.GET("/recipes/:id", recipeHandler.Get)
		v1.PUT("/recipes/:id", recipeHandler.Update)
		v1.DELETE("/recipes/:id", recipeHandler.Delete)
		v1.POST("/recipes/:id/log", recipeHandler.Log)

		// Body-composition screenshot reader (kora#314). Reuses the same
		// ai.Provider as recipes/coach/resolve — same reasoning as
		// recipeParser above: nil when Provider is unset, so
		// bodyread.Handler.Read answers 503 and manual entry still works.
		var bodyCompositionHandler bodyread.Handler
		if deps.Provider != nil {
			// deps.BodyCompositionCache may be a nil bodyread.Cache in a
			// test-constructed Deps that never set it — fall back to
			// bodyread.NoCache{} rather than handing Reader a nil interface
			// it would panic dereferencing.
			bodyCache := deps.BodyCompositionCache
			if bodyCache == nil {
				bodyCache = bodyread.NoCache{}
			}
			bodyReader := bodyread.NewReader(deps.Provider, bodyCache, billing.NewMeter(deps.DB))
			bodyCompositionHandler = bodyread.NewHandler(bodyReader)
		} else {
			bodyCompositionHandler = bodyread.NewHandler(nil)
		}
		v1.POST("/body-composition/read", bodyCompositionHandler.Read)

		trackingRepo := tracking.NewRepository(deps.DB)
		trackingHandler := tracking.NewHandler(trackingRepo)
		v1.POST("/water", trackingHandler.Add)
		v1.GET("/water", trackingHandler.DayTotal)
		v1.POST("/weight", trackingHandler.AddWeight)
		v1.GET("/weight", trackingHandler.ListWeight)

		healthHandler := health.NewHandler(health.NewService(trackingRepo))
		v1.POST("/health/sync", healthHandler.Sync)

		// logRepo answers "did the user eat after this fast began?" -- the
		// food-log ending fasting.Repository.Open computes rather than reads
		// from a column (kora#407).
		fastingRepo := fasting.NewRepository(deps.DB, logRepo)
		fastingHandler := fasting.NewHandler(fastingRepo)
		v1.POST("/fasting/start", fastingHandler.Start)
		v1.POST("/fasting/end", fastingHandler.End)
		v1.GET("/fasting/current", fastingHandler.Current)

		socialRepo := social.NewRepository(deps.DB)
		// Held in a variable, not built inline, because the identity handler
		// below also needs it: identity.Service.WithFriendships takes this
		// same instance (kora#453) so GET /v1/users/lookup and
		// POST /v1/friends/requests read one friendship graph, not two.
		socialSvc := social.NewService(socialRepo, userRepo, assetsStore(deps.Assets).URL).
			WithNotifier(notificationsSvc).
			// A handle sent here is resolved through the SAME
			// identity.Repository.FindByCanonical (kora#449 task 13b) as
			// GET /v1/users/lookup -- there is exactly one place that
			// reads by handle_canonical.
			WithHandles(identity.NewRepository(deps.DB))
		socialHandler := social.NewHandler(socialSvc)
		v1.GET("/friends", socialHandler.ListFriends)
		v1.GET("/friends/requests", socialHandler.ListRequests)
		// "Send a request to this handle" is exact-match lookup in disguise:
		// 404-vs-success on this route is the same oracle GET
		// /v1/users/lookup gives, so it gets the identical per-user budget
		// (a SEPARATE Window instance -- ratelimit.PerUser holds one per call
		// site, not a shared one) rather than being left open to the same
		// enumeration the lookup limiter exists to close.
		v1.POST("/friends/requests",
			ratelimit.PerUser(identity.LookupLimit, identity.LookupPeriod),
			socialHandler.SendRequest)
		v1.POST("/friends/requests/:id/accept", socialHandler.Accept)
		v1.POST("/friends/requests/:id/decline", socialHandler.Decline)
		v1.DELETE("/friends/:userId", socialHandler.Unfriend)
		v1.GET("/friends/code", socialHandler.Code)

		shareHandler := share.NewHandler(
			share.NewService(share.NewRepository(deps.DB, assetsStore(deps.Assets).URL), socialRepo))
		v1.GET("/share/circles", shareHandler.List)
		v1.POST("/share/circles", shareHandler.Create)
		// The member-side mirror of GET /share/circles (kora#440). It is what
		// makes POST /:id/leave reachable — without it a member cannot learn
		// the circle id that route requires.
		v1.GET("/share/memberships", shareHandler.Memberships)
		v1.DELETE("/share/circles/:id", shareHandler.Delete)
		v1.POST("/share/circles/:id/members", shareHandler.AddMember)
		v1.DELETE("/share/circles/:id/members/:userId", shareHandler.RemoveMember)
		v1.PUT("/share/circles/:id/categories", shareHandler.SetCategories)
		v1.POST("/share/circles/:id/leave", shareHandler.Leave)

		// Handles (kora#449). Exact match only: there is no listing or prefix
		// route here, and adding one would make the user base enumerable.
		identityHandler := identity.NewHandler(
			identity.NewServiceWithAssets(identity.NewRepository(deps.DB), assetsStore(deps.Assets)).
				// So GET /v1/users/lookup can report the viewer's
				// relationship to the looked-up person instead of always
				// offering a live "Send request" (kora#453).
				WithFriendships(socialSvc))
		v1.GET("/me/handle", identityHandler.GetHandle)
		// SetHandle answers a distinguishable 409 handle_taken (kora#449) --
		// that is only safe because discovery is rate-bounded, same as
		// /users/lookup below. Without this, an attacker walks the handle
		// space here at unlimited rate and spends the lookup budget only on
		// confirmed hits.
		v1.PUT("/me/handle",
			ratelimit.PerUser(identity.LookupLimit, identity.LookupPeriod),
			identityHandler.SetHandle)
		v1.DELETE("/me/handle", identityHandler.ClearHandle)
		v1.PUT("/me/avatar", identityHandler.SetAvatar)
		v1.DELETE("/me/avatar", identityHandler.ClearAvatar)
		// The limiter is on LOOKUP only, and it is not an optimisation: it is
		// the only thing between exact-match lookup and offline enumeration.
		v1.GET("/users/lookup",
			ratelimit.PerUser(identity.LookupLimit, identity.LookupPeriod),
			identityHandler.Lookup)

		accessSvc := access.NewService(access.NewRepository(deps.DB))

		compareHandler := compare.NewHandler(compare.NewService(socialRepo, userRepo, logRepo), accessSvc)
		v1.GET("/friends/progress", compareHandler.Get)

		// Another person's weigh-ins, under an access.CategoryBody grant
		// (kora#438). Registered after the static /friends/* GET routes above
		// it, which gin resolves in preference to the :userId parameter.
		//
		// A route added here that reads another user's rows MUST also be
		// added to crossUserPaths in access/enforcement_test.go — that is
		// what makes forgetting the gateway fail a test that already exists.
		friendBodyHandler := tracking.NewFriendBodyHandler(trackingRepo, accessSvc)
		v1.GET("/friends/:userId/body", friendBodyHandler.Get)

		dashSvc := dashboard.NewService(logRepo, trackingRepo, deps.DB)
		dashboardHandler := dashboard.NewHandler(dashSvc)
		v1.GET("/dashboard", dashboardHandler.Get)

		groupsRepo := groups.NewRepository(deps.DB)
		groupsSvc := groups.NewService(groupsRepo, socialRepo, groups.NewCode).WithNotifier(notificationsSvc)
		groupsHandler := groups.NewHandler(groupsSvc, groupsRepo, compare.NewService(socialRepo, userRepo, logRepo), accessSvc)
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

		coachGrounder := coach.NewGrounder(dashSvc, logRepo, memSvc, trackingRepo).WithMentor(mentorRepo).WithFasting(fastingRepo)
		coachMeter := billing.NewMeter(deps.DB)
		coachThread := coach.NewThreadRepository(deps.DB)
		coachService := coach.NewService(&coachGrounder, deps.Provider, coachMeter, &coachThread).
			WithAgents(deps.Agents).
			WithNutritionReferences(coach.NewNutritionReferenceSource(nutrition.NewRepository(deps.DB), deps.Provider))
		coachHandler := coach.NewHandler(coachService)

		// Registered here rather than beside the other /weight routes because
		// the rate is gated on the Protective policy, and coachGrounder --
		// the single definition of risk -- only exists from this point on.
		// Building a second grounder to move it up would create a second
		// place risk could be computed, which is exactly what #23 forbids.
		v1.GET("/weight/trend", trackingHandler.WithSignals(
			coach.NewSignalsSource(coachGrounder),
		).WeightTrend)
		if deps.Resolver != nil {
			// The capture composer posts here: one endpoint that decides
			// whether a message is food to log or something to talk about,
			// rather than assuming every message is food.
			coachHandler = coachHandler.WithFoodResolver(deps.Resolver.TextEngine())
			v1.POST("/capture/message", coachHandler.Message)
		}
		v1.GET("/coach/nudges", coachHandler.Nudges)
		v1.POST("/coach/ask", coachHandler.Ask)
		v1.GET("/coach/thread", coachHandler.Thread)
		v1.PUT("/coach/plans/:id/accept", coachHandler.AcceptPlan)

		if deps.Agents != nil {
			agentsHandler := agents.NewHandler(deps.Agents)
			v1.GET("/agents", agentsHandler.List)
			v1.GET("/agents/:name", agentsHandler.Get)
			v1.POST("/agents/:name/refresh", agentsHandler.Refresh)
		}

		feedbackHandler := feedback.NewHandler(feedback.NewRepository(deps.DB))
		v1.POST("/feedback", feedbackHandler.Create)
	}

	r.NoRoute(func(c *gin.Context) {
		httpx.Error(c, http.StatusNotFound, "not_found", "route not found")
	})

	return r
}

// auditDeletion is the AuditRecorder user.Service writes its admin audit row
// with. It is a closure rather than a direct admin.RecordEvent call because
// internal/user cannot import internal/admin (admin -> ai -> nutrition ->
// user is an import cycle); this package imports both, so the adaptation
// belongs here.
//
// It writes on the tx it is handed, which is load-bearing: the audit row and
// the DELETE must commit or roll back together. An audit trail that survives
// a rolled-back delete is worse than none.
//
// Wired unconditionally even though SELF-deletion never uses it — only
// actor.IsAdmin deletions do. Leaving it nil would compile and pass every
// DELETE /v1/me test, then fail the admin endpoint with ErrNoAuditRecorder
// the first time an operator used it.
func auditDeletion(tx *gorm.DB, actorID, actorEmail string, targetID uuid.UUID) error {
	return admin.RecordEvent(tx, admin.Actor{ID: actorID, Email: actorEmail},
		admin.ActionUserDeleted, admin.TargetTypeUser, targetID, nil, nil)
}

// deletionCache narrows BOTH the resolve cache and the body-composition
// cache to the single eviction surface account deletion needs. Both store
// AI data keyed by user id — resolve.Resolution and bodyread.Result
// respectively — so a deletion that swept only the resolve cache would
// leave a deleted user's cached body-composition readings (weight, body
// fat, visceral fat, scale BMR — health data) sitting in Redis for up to
// the cache's full TTL after their row is destroyed (kora#314 review
// finding #1). A nil cache (resolve engine disabled, Redis unreachable at
// startup, or no ai.Provider configured) becomes the matching NoCache{}
// rather than being passed through: user.Service.Delete calls DeleteByUser
// unconditionally, and a nil interface there would panic AFTER the row was
// already destroyed.
// assetsStore defaults a nil Store to assets.Noop{}, the same choice
// deletionCache makes above for resolveCache/bodyCache: router code must
// never have to nil-check the store itself.
func assetsStore(a assets.Store) assets.Store {
	if a == nil {
		return assets.Noop{}
	}
	return a
}

func deletionCache(resolveCache ai.Cache, bodyCache bodyread.Cache) user.CacheEvicter {
	if resolveCache == nil {
		resolveCache = ai.NoCache{}
	}
	if bodyCache == nil {
		bodyCache = bodyread.NoCache{}
	}
	return multiCacheEvicter{resolve: resolveCache, body: bodyCache}
}

// multiCacheEvicter fans DeleteByUser out to every per-user AI cache this
// server maintains. Both evictions are attempted even if the first fails —
// a partial sweep (resolve cleared, bodyread not, or vice versa) is
// strictly better than an early return that skips the second cache
// entirely — and both errors are joined so the caller (user.Service.Delete,
// which only logs this and never treats it as fatal — the row is already
// gone by the time this runs) doesn't lose either one.
type multiCacheEvicter struct {
	resolve ai.Cache
	body    bodyread.Cache
}

func (m multiCacheEvicter) DeleteByUser(ctx context.Context, userID uuid.UUID) error {
	resolveErr := m.resolve.DeleteByUser(ctx, userID)
	bodyErr := m.body.DeleteByUser(ctx, userID)
	return errors.Join(resolveErr, bodyErr)
}

// unwiredIdentityDeleter stands in when Deps.IdentityDeleter is nil. It
// deliberately returns an error instead of succeeding silently: Service.Delete
// treats a Firebase failure as non-fatal and logs it as "firebase identity
// survived deletion; NEEDS MANUAL CLEANUP", which is exactly the truth here.
// A no-op that returned nil would report the identity as removed when it was
// never touched.
type unwiredIdentityDeleter struct{}

func (unwiredIdentityDeleter) DeleteIdentity(context.Context, string) error {
	return errors.New("server: no identity deleter wired; firebase identity not removed")
}

func identityDeleter(d user.IdentityDeleter) user.IdentityDeleter {
	if d == nil {
		return unwiredIdentityDeleter{}
	}
	return d
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
