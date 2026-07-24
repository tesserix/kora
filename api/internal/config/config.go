// Package config loads service configuration from environment variables.
package config

import (
	"fmt"
	"os"
)

type Config struct {
	Port              string
	Env               string
	DatabaseURL       string
	RedisURL          string
	FirebaseProjectID string
	GeminiAPIKey      string
	OpenAIAPIKey      string
}

func Load() (Config, error) {
	cfg := Config{
		Port:              getenv("PORT", "8080"),
		Env:               getenv("ENV", "development"),
		DatabaseURL:       os.Getenv("DATABASE_URL"),
		RedisURL:          getenv("REDIS_URL", "redis://localhost:6379/0"),
		FirebaseProjectID: os.Getenv("FIREBASE_PROJECT_ID"),
		GeminiAPIKey:      os.Getenv("GEMINI_API_KEY"),
		OpenAIAPIKey:      os.Getenv("OPENAI_API_KEY"),
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
