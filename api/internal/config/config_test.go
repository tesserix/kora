package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadConfig(t *testing.T) {
	tests := []struct {
		name            string
		port            string
		env             string
		databaseURL     string
		redisURL        string
		firebaseProject string
		expectErr       bool
		expectConfig    Config
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
			},
		},
		{
			name:            "All environment variables set",
			port:            "9090",
			env:             "production",
			databaseURL:     "postgres://prod:secret@host/proddb",
			redisURL:        "redis://prod-redis:6379/1",
			firebaseProject: "my-firebase-project",
			expectErr:       false,
			expectConfig: Config{
				Port:              "9090",
				Env:               "production",
				DatabaseURL:       "postgres://prod:secret@host/proddb",
				RedisURL:          "redis://prod-redis:6379/1",
				FirebaseProjectID: "my-firebase-project",
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
			} else {
				// On error, config should be zero-value
				assert.Equal(t, Config{}, cfg, "expected zero-value Config on error")
			}
		})
	}
}
