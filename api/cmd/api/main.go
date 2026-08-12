package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	// Embeds the IANA timezone database in the binary. Without this, the
	// production image (alpine:3.19, which installs only ca-certificates)
	// has no zoneinfo, so every time.LoadLocation for a named zone fails
	// and silently falls back to UTC -- which would make every user's day
	// boundary UTC regardless of their stored timezone, and would leave
	// this package's target_date derivation inert in production.
	_ "time/tzdata"

	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/ai/providers"
	"github.com/tesserix/kora/api/internal/appleid"
	"github.com/tesserix/kora/api/internal/auth"
	"github.com/tesserix/kora/api/internal/billing"
	"github.com/tesserix/kora/api/internal/challenges"
	"github.com/tesserix/kora/api/internal/config"
	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/devices"
	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/groups"
	"github.com/tesserix/kora/api/internal/metrics"
	"github.com/tesserix/kora/api/internal/notifications"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/push"
	"github.com/tesserix/kora/api/internal/resolve"
	"github.com/tesserix/kora/api/internal/scheduler"
	"github.com/tesserix/kora/api/internal/server"
	"github.com/tesserix/kora/api/internal/user"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("startup failed", "err", err)
		os.Exit(1)
	}

	if err := database.Migrate(cfg.DatabaseURL); err != nil {
		logger.Error("migration failed", "err", err)
		os.Exit(1)
	}
	db, err := database.Connect(cfg.DatabaseURL)
	if err != nil {
		logger.Error("db connect failed", "err", err)
		os.Exit(1)
	}

	verifier, err := auth.NewFirebaseVerifier(context.Background(), cfg.FirebaseProjectID)
	if err != nil {
		logger.Error("firebase init failed", "err", err)
		os.Exit(1)
	}

	// The same Firebase client, narrowed to its identity-DELETE surface.
	// auth keeps Verify and DeleteIdentity as two interfaces (verification
	// needs only Google's public keys; deletion needs Admin privileges), so
	// the concrete verifier has to be asserted back to the second one.
	//
	// Fatal rather than degraded: DELETE /v1/me is Apple-mandated, and a
	// deployment that silently leaves live Firebase identities behind after
	// every account deletion must not start.
	identityDeleter, ok := verifier.(auth.IdentityDeleter)
	if !ok {
		logger.Error("firebase verifier cannot delete identities; account deletion would orphan them")
		os.Exit(1)
	}

	resolveHandler, aiProvider, resolveCache := buildResolveHandler(context.Background(), cfg, db, logger)

	schedCtx, schedCancel := context.WithCancel(context.Background())
	if cfg.SchedulerInterval > 0 {
		loc, lerr := time.LoadLocation(user.DefaultTimezone)
		if lerr != nil {
			loc = time.UTC
		}
		challengesRepo := challenges.NewRepository(db)
		challengesSvc := challenges.NewService(challengesRepo, groups.NewRepository(db), foodlog.NewRepository(db))
		notifSvc := notifications.NewService(notifications.NewRepository(db), groups.NewRepository(db))
		sched := scheduler.New(challengesRepo, challengesSvc, notifSvc, loc, cfg.SchedulerInterval, logger)
		go sched.Run(schedCtx)
		logger.Info("scheduler started", "interval", cfg.SchedulerInterval.String(), "loc", loc.String())
	}

	pushCtx, pushCancel := context.WithCancel(context.Background())
	if cfg.PushEnabled {
		disp := push.New(
			notifications.NewRepository(db),
			devices.NewRepository(db),
			push.NewExpoSender(cfg.ExpoAccessToken),
			cfg.PushFreshness,
			cfg.PushInterval,
			logger,
		)
		go disp.Run(pushCtx)
		logger.Info("push dispatcher started", "interval", cfg.PushInterval.String(), "freshness", cfg.PushFreshness.String())
	}

	fiCtx, fiCancel := context.WithCancel(context.Background())
	if cfg.FoodIndexRefreshInterval > 0 {
		// logger is guaranteed non-nil here: it is constructed unconditionally
		// at the top of main() (slog.New(...)) and never reset to nil on any
		// path that reaches this point. FoodIndexRefresher.refreshLogging
		// dereferences it on every query failure with no nil-check of its own,
		// so this invariant must hold for the whole lifetime of the refresher.
		refresher := metrics.NewFoodIndexRefresher(db, metrics.Default(), cfg.FoodIndexRefreshInterval, logger)
		go refresher.Run(fiCtx)
		logger.Info("food index gauge refresher started", "interval", cfg.FoodIndexRefreshInterval.String())
	}

	if len(cfg.BFFHMACKey) > 0 {
		logger.Info("admin surface enabled", "routes", "/v1/admin/*")
	} else {
		logger.Info("admin surface disabled (no KORA_BFF_HMAC_KEY)")
	}

	// One appleid.Client serves two narrow interfaces: AppleExchanger for
	// POST /v1/me/apple-authorization and AppleRevoker for account deletion.
	// Both stay nil when Apple is unconfigured — the exchange endpoint is
	// then not mounted at all, and user.Service.Delete skips revocation
	// rather than failing.
	var appleExchanger user.AppleExchanger
	var appleRevoker user.AppleRevoker
	if cfg.ApplePrivateKeyPEM != "" {
		key, err := appleid.ParsePrivateKey([]byte(cfg.ApplePrivateKeyPEM))
		if err != nil {
			logger.Error("apple: parse private key failed", "err", err)
			os.Exit(1)
		}
		appleClient := appleid.NewClient(appleid.Config{
			TeamID:     cfg.AppleTeamID,
			KeyID:      cfg.AppleKeyID,
			BundleID:   cfg.AppleBundleID,
			PrivateKey: key,
		}, nil)
		appleExchanger = appleClient
		appleRevoker = appleClient
		logger.Info("apple authorization exchange enabled")
	} else {
		logger.Info("apple authorization exchange disabled (no APPLE_PRIVATE_KEY)")
	}

	srv := &http.Server{
		Addr: ":" + cfg.Port,
		Handler: server.NewRouter(server.Deps{
			DB:              db,
			Verifier:        verifier,
			Resolver:        resolveHandler,
			Provider:        aiProvider,
			ResolveCache:    resolveCache,
			BFFHMACKey:      cfg.BFFHMACKey,
			AppleExchanger:  appleExchanger,
			IdentityDeleter: identityDeleter,
			AppleRevoker:    appleRevoker,
		}),
		// Nothing bounded a request server-side: a client that hung up left the
		// handler running against whatever budgets the AI Router happened to
		// allow, and a slow-loris connection could hold a socket open with no
		// deadline at all.
		//
		// ReadHeaderTimeout is the slow-loris guard and is deliberately tight —
		// headers are small on every route, including the 8 MiB photo uploads,
		// whose BODY read is not covered by it.
		//
		// WriteTimeout is a backstop, not a policy: it has to clear the
		// slowest legitimate handler, which is voice resolve (a 30s transcribe
		// followed by the full text-resolve pipeline), so it cannot be tuned to
		// any one endpoint. Per-call-type latency budgets in internal/ai are
		// where request latency is actually governed; this only guarantees no
		// request can be held open indefinitely.
		ReadHeaderTimeout: 15 * time.Second,
		WriteTimeout:      150 * time.Second,
	}

	go func() {
		logger.Info("api listening", "port", cfg.Port, "env", cfg.Env)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	// Metrics listen on their own port, which is NOT routed through the Istio
	// gateway — the catch-all VirtualService rule sends / to the API's main
	// port only, so /metrics is unreachable from outside the cluster and needs
	// no auth of its own.
	metricsSrv := &http.Server{Addr: ":" + cfg.MetricsPort, Handler: metrics.Handler()}
	go func() {
		logger.Info("metrics listening", "port", cfg.MetricsPort)
		// Deliberately does NOT os.Exit on failure, unlike the API server
		// above: losing observability must never take down the product.
		if err := metricsSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("metrics server error", "err", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	schedCancel()
	pushCancel()
	fiCancel()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := metricsSrv.Shutdown(ctx); err != nil {
		logger.Error("metrics shutdown error", "err", err)
	}
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("shutdown error", "err", err)
	}
	logger.Info("api stopped")
}

// providerEmbedder adapts an ai.Provider's three-value Embed to the narrower
// two-value shape nutrition.Embedder needs (nutrition cannot import ai — see
// the interface's own comment; ai imports nutrition, so the reverse would be a
// cycle).
type providerEmbedder struct{ p ai.Provider }

func (e providerEmbedder) Embed(ctx context.Context, text string) ([]float32, error) {
	vec, _, err := e.p.Embed(ctx, text)
	return vec, err
}

// ingestEmbedder builds the embedder wired into the nutrition repository for
// ingest-time (barcode-scan) embeds.
//
// EMBEDDINGS DELIBERATELY STAY ON GEMINI. There is no fallback for them, and
// this must NOT be handed the configured provider, which is an *ai.Router in
// production. The parameter type is concrete precisely so that mistake cannot
// compile.
//
// Three reasons, in order of severity:
//
//  1. There is nothing to fall back TO. providers.OpenAIProvider.Embed
//     (internal/ai/providers/openai.go:225) never calls OpenAI at all — it
//     returns "openai: embed: not supported" unconditionally, because two
//     models' vectors are not comparable by cosine similarity just for sharing
//     a length, and mixing vector spaces would poison the nutrition index.
//  2. So a Router-backed embedder MASKS THE REAL ERROR. withFallback
//     (internal/ai/router.go:118) returns the fallback's error, so the failure
//     logged by nutrition's embedAsync would always read "openai: embed: not
//     supported" — swallowing the actual Gemini error, including the 429 that
//     the rest of this review wave exists to surface.
//  3. Router.Embed bounds the primary leg to textBudget (1500ms,
//     internal/ai/router.go:20), where embedAsync deliberately gives the call
//     a 15s context of its own. Any ingest embed slower than 1.5s would be
//     discarded.
//
// Pinned by TestIngestEmbedderStaysOnGemini.
func ingestEmbedder(gemini providers.GeminiProvider) providerEmbedder {
	return providerEmbedder{p: gemini}
}

// buildResolveHandler composes the AI resolution engine from config. It
// returns a nil handler (resolve endpoints stay unmounted), a nil provider,
// and a nil cache when no Gemini key is set — the rest of the API runs
// unchanged. The OpenAI-compatible fallback is optional: with no OpenAI key,
// Gemini serves alone (no Router). The returned provider is also threaded
// into server.Deps.Provider so the coach's Q&A endpoint can generate text
// without building a second client.
//
// THE `cache` VARIABLE BELOW IS DELIBERATELY SINGLE, AND MUST STAY THAT WAY.
// It is passed to ai.NewResolver (the reader) and returned for
// server.Deps.ResolveCache, which now feeds TWO writers:
//
//   - foodlog.Service, which evicts one stale cached Resolution after a
//     correction teaches or retracts an alias; and
//   - the admin food mutation path, which bumps the cache's invalidation
//     GENERATION after an edit or a retirement (see
//     server.resolveGeneration, which narrows this exact instance rather
//     than building its own).
//
// Both are invisible to the resolver unless they act on the instance it
// reads from. Constructing a second RedisCache here — especially on a
// different Redis DB index — would type-check everywhere and silently break
// both: corrections and retirements would keep reporting success while users
// were served the stale food for up to the cache's 24h TTL. The identity is
// pinned by server.TestAdminMutationBumpsTheSameCacheInstanceWiredIntoDeps.
func buildResolveHandler(ctx context.Context, cfg config.Config, db *gorm.DB, logger *slog.Logger) (*resolve.Handler, ai.Provider, ai.Cache) {
	if cfg.GeminiAPIKey == "" {
		logger.Info("resolve engine disabled (no GEMINI_API_KEY)")
		return nil, nil, nil
	}
	gemini, err := providers.NewGeminiProvider(ctx, cfg.GeminiAPIKey)
	if err != nil {
		logger.Error("gemini provider init failed — resolve engine disabled", "err", err)
		return nil, nil, nil
	}

	var provider ai.Provider = gemini
	if cfg.OpenAIAPIKey != "" {
		fallback := providers.NewOpenAIProvider(cfg.OpenAIAPIKey, cfg.OpenAIBaseURL, cfg.OpenAIModel, cfg.OpenAIJSONObject)
		provider = &ai.Router{Primary: gemini, Fallback: fallback}
		logger.Info("resolve engine: gemini primary + openai-compatible fallback", "model", cfg.OpenAIModel, "base_url", cfg.OpenAIBaseURL)
	} else {
		logger.Info("resolve engine: gemini only (no fallback key)")
	}

	var cache ai.Cache = ai.NoCache{}
	if opt, err := redis.ParseURL(cfg.RedisURL); err == nil {
		client := redis.NewClient(opt)
		if pingErr := client.Ping(ctx).Err(); pingErr == nil {
			cache = ai.NewRedisCache(client, 24*time.Hour)
			logger.Info("resolve engine: redis cache enabled")
		} else {
			_ = client.Close() // don't leak the pool for an unreachable cache
			logger.Info("resolve engine: redis unreachable, cache disabled", "err", pingErr)
		}
	}

	// gemini, NOT provider: embeddings have no fallback — see ingestEmbedder.
	foods := nutrition.NewRepository(db).WithEmbedder(ingestEmbedder(gemini))
	meter := billing.NewMeter(db)
	// WithPortionSource lets a personal-alias short-circuit in
	// ai.Resolver.ResolveText inherit the portion from the user's last log of
	// the same phrase (see foodlog.Repository.LastPortionForPhrase), instead
	// of always falling back to the food's serving size.
	resolver := ai.NewResolver(provider, foods, cache, meter).WithPortionSource(foodlog.NewRepository(db))
	off := nutrition.NewHTTPOFFClient()

	h := resolve.NewHandler(resolver, func(c context.Context, code string) (*nutrition.FoodItem, bool, error) {
		return foods.ResolveBarcode(c, off, code)
	})
	return &h, provider, cache
}
