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
	"github.com/tesserix/kora/api/internal/config"
	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/resolve"
	"github.com/tesserix/kora/api/internal/server"
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

	resolveHandler := buildResolveHandler(context.Background(), cfg, db, logger)

	srv := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: server.NewRouter(server.Deps{DB: db, Verifier: verifier, Resolver: resolveHandler}),
	}

	go func() {
		logger.Info("api listening", "port", cfg.Port, "env", cfg.Env)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("shutdown error", "err", err)
	}
	logger.Info("api stopped")
}

// buildResolveHandler composes the AI resolution engine from config. It
// returns nil (resolve endpoints stay unmounted) when no Gemini key is set —
// the rest of the API runs unchanged. The OpenAI-compatible fallback is
// optional: with no OpenAI key, Gemini serves alone (no Router).
func buildResolveHandler(ctx context.Context, cfg config.Config, db *gorm.DB, logger *slog.Logger) *resolve.Handler {
	if cfg.GeminiAPIKey == "" {
		logger.Info("resolve engine disabled (no GEMINI_API_KEY)")
		return nil
	}
	gemini, err := providers.NewGeminiProvider(ctx, cfg.GeminiAPIKey)
	if err != nil {
		logger.Error("gemini provider init failed — resolve engine disabled", "err", err)
		return nil
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
			logger.Info("resolve engine: redis unreachable, cache disabled", "err", pingErr)
		}
	}

	foods := nutrition.NewRepository(db)
	meter := billing.NewMeter(db)
	resolver := ai.NewResolver(provider, foods, cache, meter)
	off := nutrition.NewHTTPOFFClient()

	h := resolve.NewHandler(resolver, func(c context.Context, code string) (*nutrition.FoodItem, bool, error) {
		return foods.ResolveBarcode(c, off, code)
	})
	return &h
}
