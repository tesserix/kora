// Package config loads service configuration from environment variables.
package config

import (
	"fmt"
	"os"
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
	OpenAIAPIKey      string
	OpenAIBaseURL     string
	OpenAIModel       string
	OpenAIJSONObject  bool
	SchedulerInterval time.Duration
	PushEnabled       bool
	PushInterval      time.Duration
	PushFreshness     time.Duration
	ExpoAccessToken   string
}

func Load() (Config, error) {
	cfg := Config{
		Port:              getenv("PORT", "8080"),
		MetricsPort:       getenv("METRICS_PORT", "9090"),
		Env:               getenv("ENV", "development"),
		DatabaseURL:       os.Getenv("DATABASE_URL"),
		RedisURL:          getenv("REDIS_URL", "redis://localhost:6379/0"),
		FirebaseProjectID: os.Getenv("FIREBASE_PROJECT_ID"),
		GeminiAPIKey:      os.Getenv("GEMINI_API_KEY"),
		OpenAIAPIKey:      os.Getenv("OPENAI_API_KEY"),
		OpenAIBaseURL:     os.Getenv("OPENAI_BASE_URL"),
		OpenAIModel:       os.Getenv("OPENAI_MODEL"),
		OpenAIJSONObject:  os.Getenv("OPENAI_JSON_OBJECT") == "true",
		SchedulerInterval: getdur("SCHEDULER_INTERVAL", 5*time.Minute),
		PushEnabled:       os.Getenv("PUSH_ENABLED") == "true",
		PushInterval:      getdur("PUSH_INTERVAL", 30*time.Second),
		PushFreshness:     getdur("PUSH_FRESHNESS", 15*time.Minute),
		ExpoAccessToken:   os.Getenv("EXPO_ACCESS_TOKEN"),
	}
	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("config: DATABASE_URL is required")
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
