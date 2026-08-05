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

	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/ai/providers"
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

	srv := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: server.NewRouter(server.Deps{DB: db, Verifier: verifier, Resolver: resolveHandler, Provider: aiProvider, ResolveCache: resolveCache, BFFHMACKey: cfg.BFFHMACKey}),
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

// buildResolveHandler composes the AI resolution engine from config. It
// returns a nil handler (resolve endpoints stay unmounted), a nil provider,
// and a nil cache when no Gemini key is set — the rest of the API runs
// unchanged. The OpenAI-compatible fallback is optional: with no OpenAI key,
// Gemini serves alone (no Router). The returned provider is also threaded
// into server.Deps.Provider so the coach's Q&A endpoint can generate text
// without building a second client. The returned cache is threaded into
// server.Deps.ResolveCache so foodlog.Service can evict a stale cached
// Resolution after a correction teaches or retracts an alias — it is the
// SAME cache instance the resolver reads from, so an eviction here is
// actually visible to the next resolve.
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

	foods := nutrition.NewRepository(db)
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
