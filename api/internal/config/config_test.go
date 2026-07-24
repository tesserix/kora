package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadConfig(t *testing.T) {
	tests := []struct {
		name             string
		port             string
		env              string
		databaseURL      string
		redisURL         string
		firebaseProject  string
		geminiAPIKey     string
		openAIAPIKey     string
		openAIBaseURL    string
		openAIModel      string
		openAIJSONObject string
		expectErr        bool
		expectConfig     Config
	}{
		{
			name:            "DATABASE_URL unset returns error",
			port:            "",
			env:             "",
			databaseURL:     "",
			redisURL:        "",
			firebaseProject: "",
			expectErr:       true,
			expectConfig:    Config{},
		},
		{
			name:        "DATABASE_URL set with defaults for others",
			databaseURL: "postgres://user:pass@localhost/testdb",
			expectErr:   false,
			expectConfig: Config{
				Port:              "8080",
				Env:               "development",
				DatabaseURL:       "postgres://user:pass@localhost/testdb",
				RedisURL:          "redis://localhost:6379/0",
				FirebaseProjectID: "",
				GeminiAPIKey:      "",
				OpenAIAPIKey:      "",
			},
		},
		{
			name:             "All environment variables set",
			port:             "9090",
			env:              "production",
			databaseURL:      "postgres://prod:secret@host/proddb",
			redisURL:         "redis://prod-redis:6379/1",
			firebaseProject:  "my-firebase-project",
			geminiAPIKey:     "gemini-test-key",
			openAIAPIKey:     "openai-test-key",
			openAIBaseURL:    "https://integrate.api.nvidia.com/v1",
			openAIModel:      "meta/llama-3.3-70b-instruct",
			openAIJSONObject: "true",
			expectErr:        false,
			expectConfig: Config{
				Port:              "9090",
				Env:               "production",
				DatabaseURL:       "postgres://prod:secret@host/proddb",
				RedisURL:          "redis://prod-redis:6379/1",
				FirebaseProjectID: "my-firebase-project",
				GeminiAPIKey:      "gemini-test-key",
				OpenAIAPIKey:      "openai-test-key",
				OpenAIBaseURL:     "https://integrate.api.nvidia.com/v1",
				OpenAIModel:       "meta/llama-3.3-70b-instruct",
				OpenAIJSONObject:  true,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Set environment variables using t.Setenv (auto-restored after test)
			if tt.port != "" {
				t.Setenv("PORT", tt.port)
			}
			if tt.env != "" {
				t.Setenv("ENV", tt.env)
			}
			if tt.databaseURL != "" {
				t.Setenv("DATABASE_URL", tt.databaseURL)
			}
			if tt.redisURL != "" {
				t.Setenv("REDIS_URL", tt.redisURL)
			}
			if tt.firebaseProject != "" {
				t.Setenv("FIREBASE_PROJECT_ID", tt.firebaseProject)
			}
			if tt.geminiAPIKey != "" {
				t.Setenv("GEMINI_API_KEY", tt.geminiAPIKey)
			}
			if tt.openAIAPIKey != "" {
				t.Setenv("OPENAI_API_KEY", tt.openAIAPIKey)
			}
			if tt.openAIBaseURL != "" {
				t.Setenv("OPENAI_BASE_URL", tt.openAIBaseURL)
			}
			if tt.openAIModel != "" {
				t.Setenv("OPENAI_MODEL", tt.openAIModel)
			}
			if tt.openAIJSONObject != "" {
				t.Setenv("OPENAI_JSON_OBJECT", tt.openAIJSONObject)
			}

			// Call Load()
			cfg, err := Load()

			// Assert error behavior
			if tt.expectErr {
				require.Error(t, err, "expected an error but got nil")
			} else {
				require.NoError(t, err, "expected no error but got: %v", err)
			}

			// Assert config fields match expected
			if !tt.expectErr {
				assert.Equal(t, tt.expectConfig.Port, cfg.Port, "Port mismatch")
				assert.Equal(t, tt.expectConfig.Env, cfg.Env, "Env mismatch")
				assert.Equal(t, tt.expectConfig.DatabaseURL, cfg.DatabaseURL, "DatabaseURL mismatch")
				assert.Equal(t, tt.expectConfig.RedisURL, cfg.RedisURL, "RedisURL mismatch")
				assert.Equal(t, tt.expectConfig.FirebaseProjectID, cfg.FirebaseProjectID, "FirebaseProjectID mismatch")
				assert.Equal(t, tt.expectConfig.GeminiAPIKey, cfg.GeminiAPIKey, "GeminiAPIKey mismatch")
				assert.Equal(t, tt.expectConfig.OpenAIAPIKey, cfg.OpenAIAPIKey, "OpenAIAPIKey mismatch")
				assert.Equal(t, tt.expectConfig.OpenAIBaseURL, cfg.OpenAIBaseURL, "OpenAIBaseURL mismatch")
				assert.Equal(t, tt.expectConfig.OpenAIModel, cfg.OpenAIModel, "OpenAIModel mismatch")
				assert.Equal(t, tt.expectConfig.OpenAIJSONObject, cfg.OpenAIJSONObject, "OpenAIJSONObject mismatch")
			} else {
				// On error, config should be zero-value
				assert.Equal(t, Config{}, cfg, "expected zero-value Config on error")
			}
		})
	}
}
