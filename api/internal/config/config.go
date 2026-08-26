// Package config loads service configuration from environment variables.
package config

import (
	"encoding/base64"
	"fmt"
	"os"
	"strings"
	"time"
)

type Config struct {
	Port              string
	MetricsPort       string
	Env               string
	DatabaseURL       string
	RedisURL          string
	FirebaseProjectID string
	GeminiAPIKey      string
	// VertexProject, when set, switches the resolve engine from the Gemini API
	// (personal API key, free-tier quotas) to Vertex AI authenticated by the
	// workload's own service account. See providers.NewVertexProvider.
	VertexProject    string
	VertexLocation   string
	OpenAIAPIKey     string
	OpenAIBaseURL    string
	OpenAIModel      string
	OpenAIJSONObject bool
	AIGatewayEnabled bool
	AIGatewayBaseURL string
	AIGatewayAPIKey  string
	AIGatewayModel   string
	AIAgentTimeout   time.Duration
	// AIRegistryBaseURL points at the Agentic Registry. When set, Kora
	// resolves its agents, skills and tools from the catalog at request time
	// instead of routing a bare model capability. Unset leaves the agent path
	// off and every caller falls back to the direct provider.
	AIRegistryBaseURL string
	// AIRegistryAPIKey is Kora's registry deploy key, a credential of its own.
	// The registry matches sha256(bearer) against its `kora=` entry, so the
	// gateway key authenticates as nobody -- one credential does NOT cover
	// both hops, and assuming it did 401'd every lookup in production.
	AIRegistryAPIKey string
	// AIRegistryTTL is how long a resolved agent stays fresh. 0 uses the
	// package default.
	AIRegistryTTL     time.Duration
	SchedulerInterval time.Duration
	// FoodRefreshEvery is the cadence of the OpenFoodFacts delta refresh
	// (internal/nutrition/refresh). 0 disables it. The hourly due-check is
	// fixed; this is how often work actually happens.
	FoodRefreshEvery time.Duration
	PushEnabled      bool
	PushInterval     time.Duration
	PushFreshness    time.Duration
	ExpoAccessToken  string
	// FoodIndexRefreshInterval is how often the food-index completeness gauges
	// are re-read from the database. The value only changes when the embed job
	// runs, so this is deliberately slow. 0 disables the refresher.
	FoodIndexRefreshInterval time.Duration
	// BFFHMACKey is the shared secret the tesserix-home admin portal signs its
	// requests to /v1/admin/* with. Nil when KORA_BFF_HMAC_KEY is unset, which
	// leaves the admin routes unmounted — a valid deployment (dev, CI, any
	// environment with no portal). A key that is SET but unusable is a hard
	// error instead: silently disabling admin would surface as an unexplained
	// 404 rather than a startup failure.
	//
	// The env var is base64 (matching HomeChef's BFF_INTERNAL_HMAC_KEY); the
	// MAC is computed over the DECODED bytes. Using the encoded form on either
	// side produces signatures that never verify.
	BFFHMACKey []byte
	// PlatformAdminSecret is the shared secret the Tesserix platform console's
	// federation client signs its requests to /v1/admin/* with. Empty leaves
	// the contract endpoints unmounted, the same choice BFFHMACKey makes.
	//
	// It is a SEPARATE key from BFFHMACKey and must stay one. Two callers sign
	// two incompatible canonical strings (see package platformauth); sharing a
	// key between them would mean rotating one caller's credential silently
	// revokes the other's, and would let either caller's compromise reach the
	// other's routes.
	//
	// Unlike BFFHMACKey this is NOT base64 — the federation client's Sign
	// takes the secret as a raw string and MACs those bytes, so decoding here
	// would produce signatures that never verify.
	PlatformAdminSecret string
	// Sign in with Apple credentials, used to exchange authorization codes and
	// to revoke refresh tokens on account deletion. When ApplePrivateKeyPEM is
	// empty the Apple endpoints are not mounted at all, so an unconfigured
	// environment answers 404 rather than 500.
	AppleTeamID        string
	AppleKeyID         string
	AppleBundleID      string
	ApplePrivateKeyPEM string
	// Cashfree credentials for paid AI top-ups. Empty leaves the purchase
	// routes unmounted, exactly like Apple above: an environment with no
	// gateway must answer 404 rather than offer a checkout that cannot
	// complete. A PARTIALLY configured gateway is a startup error.
	CashfreeAppID     string
	CashfreeSecretKey string
	CashfreeSandbox   bool
	// CashfreeReturnURL is the deep link the hosted checkout sends the user
	// back to. The result carried on that URL is never trusted; it only closes
	// the browser and prompts the app to ask the gateway what happened.
	//
	// The scheme is the MOBILE APP's (`mobile://`, apps/mobile/app.json), not
	// the product name: a link the app has not registered opens nothing at
	// all, stranding the user in a browser after they have paid.
	CashfreeReturnURL string

	// Stripe credentials for paid AI top-ups (kora#478). Selected over
	// Cashfree when configured; see router.go for the precedence and why it is
	// stated rather than inferred.
	//
	// There is deliberately NO sandbox flag here. Stripe's test and live
	// environments share one API host and are chosen by the KEY itself, so a
	// separate switch could only ever disagree with the credential beside it —
	// which is the state CASHFREE_SANDBOX=true under ENV=production is in
	// today on the live Deployment.
	StripeSecretKey     string
	StripeWebhookSecret string
	// StripeReturnURL is the deep link Stripe sends the user back to. Defaults
	// to the same target as Cashfree's: it is the app's return screen, not a
	// property of the gateway.
	StripeReturnURL string
	// Object storage for user-supplied assets (kora#449). Empty AssetsBucket
	// selects assets.Noop -- an environment with no bucket behaves as if every
	// user has no picture, rather than failing uploads, so nobody working on
	// anything else needs GCS credentials.
	AssetsBucket        string
	AssetsPublicBaseURL string
	AssetsLocalDir      string
}

func Load() (Config, error) {
	cfg := Config{
		Port:                     getenv("PORT", "8080"),
		MetricsPort:              getenv("METRICS_PORT", "9090"),
		Env:                      getenv("ENV", "development"),
		DatabaseURL:              os.Getenv("DATABASE_URL"),
		RedisURL:                 getenv("REDIS_URL", "redis://localhost:6379/0"),
		FirebaseProjectID:        os.Getenv("FIREBASE_PROJECT_ID"),
		GeminiAPIKey:             os.Getenv("GEMINI_API_KEY"),
		VertexProject:            os.Getenv("VERTEX_PROJECT"),
		VertexLocation:           getenv("VERTEX_LOCATION", "global"),
		OpenAIAPIKey:             os.Getenv("OPENAI_API_KEY"),
		OpenAIBaseURL:            os.Getenv("OPENAI_BASE_URL"),
		OpenAIModel:              os.Getenv("OPENAI_MODEL"),
		OpenAIJSONObject:         os.Getenv("OPENAI_JSON_OBJECT") == "true",
		AIGatewayEnabled:         os.Getenv("AI_GATEWAY_ENABLED") == "true",
		AIGatewayBaseURL:         os.Getenv("AI_GATEWAY_BASE_URL"),
		AIGatewayAPIKey:          os.Getenv("AI_GATEWAY_API_KEY"),
		AIGatewayModel:           getenv("AI_GATEWAY_MODEL", "kora-auto"),
		AIAgentTimeout:           getdur("AI_AGENT_TIMEOUT", 60*time.Second),
		AIRegistryBaseURL:        os.Getenv("AI_REGISTRY_BASE_URL"),
		AIRegistryAPIKey:         os.Getenv("AI_REGISTRY_API_KEY"),
		AIRegistryTTL:            getdur("AI_REGISTRY_TTL", 0),
		SchedulerInterval:        getdur("SCHEDULER_INTERVAL", 5*time.Minute),
		FoodRefreshEvery:         getdur("FOOD_REFRESH_EVERY", 7*24*time.Hour),
		PushEnabled:              os.Getenv("PUSH_ENABLED") == "true",
		PushInterval:             getdur("PUSH_INTERVAL", 30*time.Second),
		PushFreshness:            getdur("PUSH_FRESHNESS", 15*time.Minute),
		ExpoAccessToken:          os.Getenv("EXPO_ACCESS_TOKEN"),
		FoodIndexRefreshInterval: getdur("FOOD_INDEX_REFRESH_INTERVAL", 60*time.Second),
		AppleTeamID:              os.Getenv("APPLE_TEAM_ID"),
		AppleKeyID:               os.Getenv("APPLE_KEY_ID"),
		AppleBundleID:            getenv("APPLE_BUNDLE_ID", "com.tesserix.kora"),
		ApplePrivateKeyPEM:       os.Getenv("APPLE_PRIVATE_KEY"),
		CashfreeAppID:            os.Getenv("CASHFREE_APP_ID"),
		CashfreeSecretKey:        os.Getenv("CASHFREE_SECRET_KEY"),
		CashfreeSandbox:          os.Getenv("CASHFREE_SANDBOX") == "true",
		CashfreeReturnURL:        getenv("CASHFREE_RETURN_URL", "mobile://billing/return"),
		StripeSecretKey:          os.Getenv("STRIPE_SECRET_KEY"),
		StripeWebhookSecret:      os.Getenv("STRIPE_WEBHOOK_SECRET"),
		StripeReturnURL:          getenv("STRIPE_RETURN_URL", "mobile://billing/return"),
		AssetsBucket:             os.Getenv("ASSETS_BUCKET"),
		AssetsPublicBaseURL:      os.Getenv("ASSETS_PUBLIC_BASE_URL"),
		AssetsLocalDir:           os.Getenv("ASSETS_LOCAL_DIR"),
	}
	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("config: DATABASE_URL is required")
	}
	// Compared AFTER defaults are applied, so that moving the API to 9090 and
	// leaving METRICS_PORT unset is caught too. main() runs the API and the
	// metrics endpoint as two servers; sharing a port makes them race to bind,
	// and the API's goroutine exits the process when it loses — letting an
	// observability misconfiguration take down the product. Fail loudly here
	// instead.
	if cfg.MetricsPort == cfg.Port {
		return Config{}, fmt.Errorf("config: METRICS_PORT (%s) must differ from PORT (%s)", cfg.MetricsPort, cfg.Port)
	}
	if cfg.AIGatewayEnabled {
		if cfg.AIGatewayBaseURL == "" {
			return Config{}, fmt.Errorf("config: AI_GATEWAY_BASE_URL is required when AI_GATEWAY_ENABLED is true")
		}
		if cfg.AIGatewayAPIKey == "" {
			return Config{}, fmt.Errorf("config: AI_GATEWAY_API_KEY is required when AI_GATEWAY_ENABLED is true")
		}
	}
	if cfg.AIRegistryBaseURL != "" {
		// Same philosophy as the gateway above: a registry URL with no usable
		// key would leave the agent path mounted but failing every request,
		// which reads as a broken agent rather than a missing credential.
		// Deliberately no fallback to AIGatewayAPIKey -- it is not a valid
		// deploy key, so falling back would turn this loud error into a
		// permanent 401 hidden behind keyword routing.
		if cfg.AIRegistryAPIKey == "" {
			return Config{}, fmt.Errorf("config: AI_REGISTRY_API_KEY is required when AI_REGISTRY_BASE_URL is set")
		}
	}
	if cfg.Env == "production" {
		if !cfg.AIGatewayEnabled {
			return Config{}, fmt.Errorf("config: AI_GATEWAY_ENABLED must be true in production")
		}
		if cfg.AIRegistryBaseURL == "" {
			return Config{}, fmt.Errorf("config: AI_REGISTRY_BASE_URL is required in production")
		}
	}
	if raw := os.Getenv("KORA_BFF_HMAC_KEY"); raw != "" {
		key, err := base64.StdEncoding.DecodeString(raw)
		if err != nil {
			return Config{}, fmt.Errorf("config: KORA_BFF_HMAC_KEY must be valid base64: %w", err)
		}
		if len(key) < 16 {
			return Config{}, fmt.Errorf("config: KORA_BFF_HMAC_KEY must decode to at least 16 bytes, got %d", len(key))
		}
		cfg.BFFHMACKey = key
	}
	// A secret that is SET but too short is a hard error rather than a
	// silently-disabled surface, for the same reason BFFHMACKey's is: the
	// symptom of the alternative is an unexplained 404 in an environment
	// someone believed they had configured.
	if raw := strings.TrimSpace(os.Getenv("KORA_PLATFORM_ADMIN_SECRET")); raw != "" {
		if len(raw) < 16 {
			return Config{}, fmt.Errorf(
				"config: KORA_PLATFORM_ADMIN_SECRET must be at least 16 characters, got %d", len(raw))
		}
		cfg.PlatformAdminSecret = raw
	}
	// Same philosophy as BFFHMACKey above: a partially configured Apple
	// integration is worse than a disabled one. With the .p8 key set but
	// AppleTeamID or AppleKeyID empty, appleid.Client signs a client_secret
	// with an empty iss/kid, the route still mounts, and every exchange fails
	// with invalid_client — permanently, silently, and indistinguishable from
	// success to the app. Fail at startup instead.
	if cfg.ApplePrivateKeyPEM != "" {
		if cfg.AppleTeamID == "" {
			return Config{}, fmt.Errorf("config: APPLE_TEAM_ID is required when APPLE_PRIVATE_KEY is set")
		}
		if cfg.AppleKeyID == "" {
			return Config{}, fmt.Errorf("config: APPLE_KEY_ID is required when APPLE_PRIVATE_KEY is set")
		}
	}
	// One Cashfree credential without the other cannot sign a webhook or
	// authenticate an order, so it would mount a checkout that takes money and
	// then fails to grant anything. Refuse to start instead.
	if (cfg.CashfreeAppID == "") != (cfg.CashfreeSecretKey == "") {
		return Config{}, fmt.Errorf("config: CASHFREE_APP_ID and CASHFREE_SECRET_KEY must be set together")
	}
	return cfg, nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getdur(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return fallback
}
