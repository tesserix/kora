# Kora Phase 0 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Working skeleton — an Expo app that signs in with Firebase Auth and calls a deployed Go API which verifies the token and returns the user's profile, styled with the ported Iris design tokens.

**Architecture:** Modular Go monolith (`api/`) with Gin + GORM + golang-migrate, Firebase Admin SDK for JWT verification behind a mockable `TokenVerifier` interface. Expo (React Native, Expo Router, TypeScript) app (`apps/mobile/`) with a theme module generated from the design-system OKLCH tokens. Local dev via docker-compose; CI builds → GAR; dev deploy manifests in `tesserix-k8s` (postiz pattern).

**Tech Stack:** Go 1.26, Gin, GORM, golang-migrate, firebase.google.com/go/v4, testify · Expo SDK (latest), Expo Router, TypeScript strict, Firebase JS SDK (email/password for Phase 0), jest-expo, @testing-library/react-native · Postgres 15, Redis 7.

## Global Constraints

- Go 1.26; Gin HTTP framework; GORM + `gorm.io/driver/postgres`; golang-migrate for migrations.
- JSON error envelope everywhere: `{"error": "<code>", "message": "<human readable>"}`.
- Single-line conventional commit messages (`feat:`, `fix:`, `chore:`, …), no signatures, no multi-line body.
- All secrets via env vars — never hardcoded, never committed. `.env` files gitignored.
- Handler → service → repository layering; no `panic` outside `main.go` startup.
- Immutability preferred: functions return new values rather than mutating arguments.
- Mobile: TypeScript `strict: true`; no `any` in committed code.
- The Iris theme is locked: primary hue 285 OKLCH. Do not invent colors — port from `design-system/tokens/`.
- AI keys and Firebase Admin credentials live server-side only.

## Manual Prerequisites (user does these once, before Task 5)

1. Create a **separate** Firebase project `kora-app` (do not reuse Tesserix GCP project).
2. Enable **Email/Password** provider in Firebase Console → Authentication → Sign-in method. (Google/Apple sign-in land in Phase 1.)
3. From Project settings → General → Your apps, register a **Web app** and note the Firebase web config (apiKey, authDomain, projectId, appId).
4. From Project settings → Service accounts, note the project ID for the API's `FIREBASE_PROJECT_ID` env var. (On GKE/local, Application Default Credentials or a mounted service-account key authorize the Admin SDK.)

---

### Task 1: Repo layout + local infrastructure

**Files:**
- Create: `.gitignore`, `infra/docker-compose.yml`, `api/.env.example`

**Interfaces:**
- Produces: Postgres on `localhost:5432` (db `kora`, user `kora`, password `kora_dev`), Redis on `localhost:6379`. `DATABASE_URL` / `REDIS_URL` env names used by all later API tasks.

- [ ] **Step 1: Write `.gitignore`**

```gitignore
# env & secrets
.env
.env.*
!.env.example
*-service-account*.json
google-services.json
GoogleService-Info.plist

# Go
api/bin/
api/coverage.out

# Node / Expo
node_modules/
.expo/
dist/
*.tsbuildinfo

# OS / editor
.DS_Store
```

- [ ] **Step 2: Write `infra/docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: kora
      POSTGRES_USER: kora
      POSTGRES_PASSWORD: kora_dev
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U kora"]
      interval: 5s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  pgdata:
```

- [ ] **Step 3: Write `api/.env.example`**

```env
PORT=8080
ENV=development
DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable
REDIS_URL=redis://localhost:6379/0
FIREBASE_PROJECT_ID=kora-app
```

- [ ] **Step 4: Verify infra boots**

Run: `docker compose -f infra/docker-compose.yml up -d && docker compose -f infra/docker-compose.yml ps`
Expected: both services `running`, postgres healthy.

- [ ] **Step 5: Commit**

```bash
git add .gitignore infra/docker-compose.yml api/.env.example
git commit -m "chore: repo layout, docker-compose, env example"
```

---

### Task 2: Go API skeleton — config, error envelope, health, logging

**Files:**
- Create: `api/go.mod`, `api/cmd/api/main.go`, `api/internal/config/config.go`, `api/internal/httpx/respond.go`, `api/internal/httpx/respond_test.go`, `api/internal/server/router.go`, `api/internal/server/router_test.go`

**Interfaces:**
- Produces:
  - `config.Load() (Config, error)` — `Config{Port, Env, DatabaseURL, RedisURL, FirebaseProjectID string}`; errors if `DATABASE_URL` missing.
  - `httpx.Error(c *gin.Context, status int, code, message string)` — writes the JSON error envelope.
  - `httpx.OK(c *gin.Context, data any)` — writes `{"data": ...}`.
  - `server.NewRouter(deps server.Deps) *gin.Engine` — `Deps{DB *gorm.DB, Verifier auth.TokenVerifier}` (fields added by later tasks; start with empty struct and grow it).
  - Routes: `GET /health` → `{"status":"ok"}`, `GET /ready` (checks DB in Task 3).

- [ ] **Step 1: Init module**

Run: `cd api && go mod init github.com/tesserix/kora/api && go get github.com/gin-gonic/gin@latest github.com/stretchr/testify@latest`
Expected: `go.mod` created.

- [ ] **Step 2: Write failing router test** — `api/internal/server/router_test.go`

```go
package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestHealthEndpoint(t *testing.T) {
	r := NewRouter(Deps{})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/health", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.JSONEq(t, `{"status":"ok"}`, w.Body.String())
}

func TestUnknownRouteReturnsEnvelope(t *testing.T) {
	r := NewRouter(Deps{})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/nope", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
	assert.JSONEq(t, `{"error":"not_found","message":"route not found"}`, w.Body.String())
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd api && go test ./internal/server/ -v`
Expected: FAIL — `NewRouter` undefined.

- [ ] **Step 4: Implement**

`api/internal/httpx/respond.go`:

```go
// Package httpx defines the JSON response envelope shared by all handlers.
package httpx

import "github.com/gin-gonic/gin"

type errorBody struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func Error(c *gin.Context, status int, code, message string) {
	c.AbortWithStatusJSON(status, errorBody{Error: code, Message: message})
}

func OK(c *gin.Context, data any) {
	c.JSON(200, gin.H{"data": data})
}
```

`api/internal/server/router.go`:

```go
package server

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/httpx"
)

// Deps carries the wired dependencies for the router. Fields are added as
// packages come online (DB in Task 3, Verifier in Task 4).
type Deps struct {
	DB *gorm.DB
}

func NewRouter(deps Deps) *gin.Engine {
	r := gin.New()
	r.Use(gin.Recovery())

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	r.NoRoute(func(c *gin.Context) {
		httpx.Error(c, http.StatusNotFound, "not_found", "route not found")
	})

	return r
}
```

`api/internal/config/config.go`:

```go
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
}

func Load() (Config, error) {
	cfg := Config{
		Port:              getenv("PORT", "8080"),
		Env:               getenv("ENV", "development"),
		DatabaseURL:       os.Getenv("DATABASE_URL"),
		RedisURL:          getenv("REDIS_URL", "redis://localhost:6379/0"),
		FirebaseProjectID: os.Getenv("FIREBASE_PROJECT_ID"),
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
```

`api/cmd/api/main.go`:

```go
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

	"github.com/tesserix/kora/api/internal/config"
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

	srv := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: server.NewRouter(server.Deps{}),
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
```

Run: `cd api && go mod tidy`

- [ ] **Step 5: Run tests to verify pass**

Run: `cd api && go test ./... -v`
Expected: PASS (2 tests).

- [ ] **Step 6: Add `httpx` envelope test** — `api/internal/httpx/respond_test.go`

```go
package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestErrorWritesEnvelope(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	Error(c, http.StatusBadRequest, "invalid_input", "name is required")

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.JSONEq(t, `{"error":"invalid_input","message":"name is required"}`, w.Body.String())
}
```

Run: `cd api && go test ./... -v` → PASS.

- [ ] **Step 7: Commit**

```bash
git add api/
git commit -m "feat: go api skeleton with health endpoint, config, error envelope"
```

---

### Task 3: Database — GORM connection, migrations, users table, /ready

**Files:**
- Create: `api/internal/database/database.go`, `api/internal/database/migrations/000001_create_users.up.sql`, `api/internal/database/migrations/000001_create_users.down.sql`, `api/internal/server/ready_test.go`
- Modify: `api/internal/server/router.go`, `api/cmd/api/main.go`

**Interfaces:**
- Consumes: `config.Config.DatabaseURL`.
- Produces:
  - `database.Connect(url string) (*gorm.DB, error)` — retry loop, 10 attempts, exponential backoff capped at 5s.
  - `database.Migrate(url string) error` — runs golang-migrate against `api/migrations` (embedded via `embed.FS`).
  - `users` table: `id UUID PK`, `firebase_uid TEXT UNIQUE NOT NULL`, `email TEXT`, `display_name TEXT`, `created_at/updated_at TIMESTAMPTZ`.
  - `GET /ready` → 200 `{"status":"ready"}` when DB pings, 503 envelope otherwise.

- [ ] **Step 1: Add deps**

Run: `cd api && go get gorm.io/gorm gorm.io/driver/postgres github.com/golang-migrate/migrate/v4 github.com/golang-migrate/migrate/v4/database/postgres github.com/golang-migrate/migrate/v4/source/iofs`

- [ ] **Step 2: Write migration files**

`api/internal/database/migrations/000001_create_users.up.sql` (must live under `internal/database/` — `go:embed` paths are package-relative):

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    firebase_uid TEXT UNIQUE NOT NULL,
    email TEXT,
    display_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`api/internal/database/migrations/000001_create_users.down.sql`:

```sql
DROP TABLE users;
```

- [ ] **Step 3: Implement `api/internal/database/database.go`**

```go
// Package database owns the Postgres connection and schema migrations.
package database

import (
	"embed"
	"errors"
	"fmt"
	"time"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

const (
	maxAttempts   = 10
	maxBackoff    = 5 * time.Second
	maxOpenConns  = 5
	maxIdleConns  = 2
)

func Connect(url string) (*gorm.DB, error) {
	var lastErr error
	backoff := 500 * time.Millisecond
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
		if err == nil {
			sqlDB, derr := db.DB()
			if derr != nil {
				return nil, fmt.Errorf("database: unwrap sql.DB: %w", derr)
			}
			sqlDB.SetMaxOpenConns(maxOpenConns)
			sqlDB.SetMaxIdleConns(maxIdleConns)
			return db, nil
		}
		lastErr = err
		time.Sleep(backoff)
		if backoff < maxBackoff {
			backoff *= 2
		}
	}
	return nil, fmt.Errorf("database: connect after %d attempts: %w", maxAttempts, lastErr)
}

func Migrate(url string) error {
	src, err := iofs.New(migrationsFS, "migrations")
	if err != nil {
		return fmt.Errorf("database: load migrations: %w", err)
	}
	m, err := migrate.NewWithSourceInstance("iofs", src, url)
	if err != nil {
		return fmt.Errorf("database: init migrate: %w", err)
	}
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("database: migrate up: %w", err)
	}
	return nil
}
```


- [ ] **Step 4: Write failing /ready test** — `api/internal/server/ready_test.go`

```go
package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

// With no DB wired, /ready must report 503 with the error envelope.
func TestReadyWithoutDB(t *testing.T) {
	r := NewRouter(Deps{})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/ready", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
	assert.JSONEq(t, `{"error":"not_ready","message":"database unavailable"}`, w.Body.String())
}
```

Run: `cd api && go test ./internal/server/ -run TestReady -v` → FAIL (404).

- [ ] **Step 5: Add /ready to router** — modify `api/internal/server/router.go`, add inside `NewRouter` after `/health`:

```go
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
```

- [ ] **Step 6: Wire into main** — modify `api/cmd/api/main.go`: after `config.Load()` succeeds, add:

```go
	if err := database.Migrate(cfg.DatabaseURL); err != nil {
		logger.Error("migration failed", "err", err)
		os.Exit(1)
	}
	db, err := database.Connect(cfg.DatabaseURL)
	if err != nil {
		logger.Error("db connect failed", "err", err)
		os.Exit(1)
	}
```

and pass `server.Deps{DB: db}`. Import `github.com/tesserix/kora/api/internal/database`.

- [ ] **Step 7: Run all tests + boot against docker-compose**

Run: `cd api && go test ./... -v` → PASS.
Run: `cd api && DATABASE_URL='postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable' go run ./cmd/api` then `curl -s localhost:8080/ready`
Expected: `{"status":"ready"}`; `\dt` in psql shows `users` + `schema_migrations`.

- [ ] **Step 8: Commit**

```bash
git add api/
git commit -m "feat: postgres connection, migrations, users table, ready endpoint"
```

---

### Task 4: Firebase auth middleware (mockable verifier)

**Files:**
- Create: `api/internal/auth/verifier.go`, `api/internal/auth/middleware.go`, `api/internal/auth/middleware_test.go`
- Modify: `api/internal/server/router.go` (add `Verifier` to `Deps`)

**Interfaces:**
- Produces:
  - `auth.Claims{UID, Email string}`.
  - `auth.TokenVerifier` interface: `Verify(ctx context.Context, idToken string) (Claims, error)`.
  - `auth.NewFirebaseVerifier(ctx context.Context, projectID string) (TokenVerifier, error)` — wraps Firebase Admin SDK.
  - `auth.Middleware(v TokenVerifier) gin.HandlerFunc` — reads `Authorization: Bearer <token>`, on success sets `c.Set("uid", claims.UID)` and `c.Set("email", claims.Email)`; on failure 401 envelope `{"error":"unauthorized","message":"invalid or missing token"}`.
  - `server.Deps` gains `Verifier auth.TokenVerifier`.

- [ ] **Step 1: Add dep**

Run: `cd api && go get firebase.google.com/go/v4@latest`

- [ ] **Step 2: Write failing middleware test** — `api/internal/auth/middleware_test.go`

```go
package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

type fakeVerifier struct {
	claims Claims
	err    error
}

func (f fakeVerifier) Verify(_ context.Context, _ string) (Claims, error) {
	return f.claims, f.err
}

func setup(v TokenVerifier) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/protected", Middleware(v), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"uid": c.GetString("uid")})
	})
	return r
}

func TestMiddlewareAcceptsValidToken(t *testing.T) {
	r := setup(fakeVerifier{claims: Claims{UID: "u123", Email: "a@b.c"}})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer good-token")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.JSONEq(t, `{"uid":"u123"}`, w.Body.String())
}

func TestMiddlewareRejectsMissingHeader(t *testing.T) {
	r := setup(fakeVerifier{})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/protected", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.JSONEq(t, `{"error":"unauthorized","message":"invalid or missing token"}`, w.Body.String())
}

func TestMiddlewareRejectsBadToken(t *testing.T) {
	r := setup(fakeVerifier{err: errors.New("expired")})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer bad-token")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd api && go test ./internal/auth/ -v` → FAIL (undefined types).

- [ ] **Step 4: Implement**

`api/internal/auth/verifier.go`:

```go
// Package auth verifies Firebase ID tokens and exposes identity to handlers.
package auth

import (
	"context"
	"fmt"

	firebase "firebase.google.com/go/v4"
	fbauth "firebase.google.com/go/v4/auth"
)

type Claims struct {
	UID   string
	Email string
}

type TokenVerifier interface {
	Verify(ctx context.Context, idToken string) (Claims, error)
}

type firebaseVerifier struct {
	client *fbauth.Client
}

func NewFirebaseVerifier(ctx context.Context, projectID string) (TokenVerifier, error) {
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: projectID})
	if err != nil {
		return nil, fmt.Errorf("auth: init firebase app: %w", err)
	}
	client, err := app.Auth(ctx)
	if err != nil {
		return nil, fmt.Errorf("auth: init auth client: %w", err)
	}
	return firebaseVerifier{client: client}, nil
}

func (v firebaseVerifier) Verify(ctx context.Context, idToken string) (Claims, error) {
	tok, err := v.client.VerifyIDToken(ctx, idToken)
	if err != nil {
		return Claims{}, fmt.Errorf("auth: verify token: %w", err)
	}
	email, _ := tok.Claims["email"].(string)
	return Claims{UID: tok.UID, Email: email}, nil
}
```

`api/internal/auth/middleware.go`:

```go
package auth

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
)

func Middleware(v TokenVerifier) gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		token, ok := strings.CutPrefix(header, "Bearer ")
		if !ok || token == "" {
			httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
			return
		}
		claims, err := v.Verify(c.Request.Context(), token)
		if err != nil {
			httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
			return
		}
		c.Set("uid", claims.UID)
		c.Set("email", claims.Email)
		c.Next()
	}
}
```

Modify `api/internal/server/router.go` — add to `Deps`:

```go
type Deps struct {
	DB       *gorm.DB
	Verifier auth.TokenVerifier
}
```

(import `github.com/tesserix/kora/api/internal/auth`).

- [ ] **Step 5: Run tests to verify pass**

Run: `cd api && go test ./... -v` → PASS.

- [ ] **Step 6: Commit**

```bash
git add api/
git commit -m "feat: firebase token verification middleware with mockable verifier"
```

---

### Task 5: /v1/me — user upsert on first authenticated call

**Files:**
- Create: `api/internal/user/model.go`, `api/internal/user/repository.go`, `api/internal/user/handler.go`, `api/internal/user/handler_test.go`
- Modify: `api/internal/server/router.go`, `api/cmd/api/main.go`

**Interfaces:**
- Consumes: `auth.Middleware` (context keys `uid`, `email`), `Deps.DB`.
- Produces:
  - `user.User{ID uuid, FirebaseUID, Email, DisplayName string, CreatedAt, UpdatedAt time.Time}` (GORM model, table `users`).
  - `user.Repository` with `UpsertByFirebaseUID(ctx, firebaseUID, email string) (User, error)`.
  - `GET /v1/me` (auth required) → `{"data":{"id":...,"email":...,"display_name":...}}` — creates the row on first call.

- [ ] **Step 1: Write model + repository**

`api/internal/user/model.go`:

```go
// Package user owns the user profile domain.
package user

import (
	"time"

	"github.com/google/uuid"
)

type User struct {
	ID          uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	FirebaseUID string    `gorm:"uniqueIndex" json:"-"`
	Email       string    `json:"email"`
	DisplayName string    `json:"display_name"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}
```

`api/internal/user/repository.go`:

```go
package user

import (
	"context"
	"fmt"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository {
	return Repository{db: db}
}

func (r Repository) UpsertByFirebaseUID(ctx context.Context, firebaseUID, email string) (User, error) {
	u := User{FirebaseUID: firebaseUID, Email: email}
	err := r.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "firebase_uid"}},
			DoUpdates: clause.AssignmentColumns([]string{"email", "updated_at"}),
		}).
		Create(&u).Error
	if err != nil {
		return User{}, fmt.Errorf("user: upsert: %w", err)
	}
	var out User
	if err := r.db.WithContext(ctx).Where("firebase_uid = ?", firebaseUID).First(&out).Error; err != nil {
		return User{}, fmt.Errorf("user: fetch after upsert: %w", err)
	}
	return out, nil
}
```

Run: `cd api && go get github.com/google/uuid && go mod tidy`

- [ ] **Step 2: Write failing handler test** — `api/internal/user/handler_test.go` (uses sqlite-free approach: run against real Postgres from docker-compose; skip if unavailable)

```go
package user

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/auth"
)

type staticVerifier struct{ claims auth.Claims }

func (s staticVerifier) Verify(_ context.Context, _ string) (auth.Claims, error) {
	return s.claims, nil
}

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

func TestMeCreatesUserOnFirstCall(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-me") })

	gin.SetMode(gin.TestMode)
	r := gin.New()
	v := staticVerifier{claims: auth.Claims{UID: "test-uid-me", Email: "me@test.dev"}}
	h := NewHandler(NewRepository(db))
	r.GET("/v1/me", auth.Middleware(v), h.Me)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer anything")
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), `"email":"me@test.dev"`)

	var count int64
	db.Model(&User{}).Where("firebase_uid = ?", "test-uid-me").Count(&count)
	assert.Equal(t, int64(1), count)
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd api && go test ./internal/user/ -v` → FAIL (`NewHandler` undefined).

- [ ] **Step 4: Implement handler** — `api/internal/user/handler.go`

```go
package user

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) Handler {
	return Handler{repo: repo}
}

func (h Handler) Me(c *gin.Context) {
	uid := c.GetString("uid")
	email := c.GetString("email")
	if uid == "" {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	u, err := h.repo.UpsertByFirebaseUID(c.Request.Context(), uid, email)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load profile")
		return
	}
	httpx.OK(c, u)
}
```

- [ ] **Step 5: Wire route** — in `api/internal/server/router.go` `NewRouter`, after `/ready`:

```go
	if deps.DB != nil && deps.Verifier != nil {
		userHandler := user.NewHandler(user.NewRepository(deps.DB))
		v1 := r.Group("/v1", auth.Middleware(deps.Verifier))
		v1.GET("/me", userHandler.Me)
	}
```

In `api/cmd/api/main.go`, construct the real verifier and pass it:

```go
	verifier, err := auth.NewFirebaseVerifier(context.Background(), cfg.FirebaseProjectID)
	if err != nil {
		logger.Error("firebase init failed", "err", err)
		os.Exit(1)
	}
```

→ `server.Deps{DB: db, Verifier: verifier}`.

- [ ] **Step 6: Run all tests**

Run: `cd api && go test ./... -v` (docker-compose up) → PASS.

- [ ] **Step 7: Commit**

```bash
git add api/
git commit -m "feat: /v1/me endpoint with user upsert on first authenticated call"
```

---

### Task 6: Expo app scaffold

**Files:**
- Create: `apps/mobile/` via `create-expo-app`, then `apps/mobile/app/_layout.tsx`, `apps/mobile/app/index.tsx`, `apps/mobile/.env.example`

**Interfaces:**
- Produces: Expo Router app, TS strict, jest-expo test runner wired (`npm test`). Env names `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_FIREBASE_API_KEY`, `EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN`, `EXPO_PUBLIC_FIREBASE_PROJECT_ID`, `EXPO_PUBLIC_FIREBASE_APP_ID`.

- [ ] **Step 1: Scaffold**

Run: `cd apps && npx create-expo-app@latest mobile --template default && cd mobile && npx expo install expo-router`
Expected: project created. Delete example screens: keep a minimal `app/_layout.tsx` + `app/index.tsx`.

`apps/mobile/app/_layout.tsx`:

```tsx
import { Stack } from "expo-router";

export default function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
```

`apps/mobile/app/index.tsx`:

```tsx
import { Text, View } from "react-native";

export default function Index() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text>Kora</Text>
    </View>
  );
}
```

- [ ] **Step 2: Enforce TS strict** — in `apps/mobile/tsconfig.json` ensure:

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "paths": { "@/*": ["./src/*"] }
  }
}
```

- [ ] **Step 3: Wire tests**

Run: `cd apps/mobile && npx expo install jest-expo jest @testing-library/react-native --dev`
Add to `package.json`: `"test": "jest --ci"` and `"jest": { "preset": "jest-expo" }`.

- [ ] **Step 4: Write env example** — `apps/mobile/.env.example`:

```env
EXPO_PUBLIC_API_URL=http://localhost:8080
EXPO_PUBLIC_FIREBASE_API_KEY=
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=kora-app.firebaseapp.com
EXPO_PUBLIC_FIREBASE_PROJECT_ID=kora-app
EXPO_PUBLIC_FIREBASE_APP_ID=
```

- [ ] **Step 5: Verify boot + typecheck**

Run: `cd apps/mobile && npx tsc --noEmit && npx expo start --no-dev --minify` (ctrl-C after bundle succeeds)
Expected: no TS errors, bundler starts.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile
git commit -m "feat: expo app scaffold with expo-router and strict typescript"
```

---

### Task 7: Design-token export → RN theme module

**Files:**
- Create: `design-system/scripts/export-rn-tokens.mjs`, `apps/mobile/src/theme/tokens.ts` (generated), `apps/mobile/src/theme/index.ts`, `apps/mobile/src/theme/__tests__/tokens.test.ts`

**Interfaces:**
- Consumes: OKLCH values from `design-system/tokens/*.css` (Iris locked theme).
- Produces:
  - `tokens.ts` exporting `lightColors`, `darkColors` (hex strings, keys: `background, foreground, card, cardForeground, primary, primaryForeground, secondary, secondaryForeground, muted, mutedForeground, accent, accentForeground, destructive, destructiveForeground, border, input, ring, success, warning, error, info`), `spacing` (`xs:4, sm:8, md:16, lg:24, xl:32, "2xl":48, "3xl":64` + numeric scale), `radius` (`sm:6, md:8, lg:10, xl:16, "2xl":24, "3xl":32, full:9999`), `fontSize` (`xs:12, sm:14, base:16, lg:18, xl:20, "2xl":24, "3xl":30, "4xl":36, "5xl":48`).
  - `theme/index.ts` exporting `useTheme(): { colors, spacing, radius, fontSize, scheme }` — resolves light/dark from `useColorScheme()`.

- [ ] **Step 1: Write export script** — `design-system/scripts/export-rn-tokens.mjs`

The OKLCH → hex conversion uses `culori`. The semantic map is copied **verbatim** from the locked Iris blocks in `tokens/colors.css` (`:root` override for light, `:root.dark` for dark, status colors from the default theme blocks).

```js
// Generates apps/mobile/src/theme/tokens.ts from the locked Iris OKLCH tokens.
// Run: node design-system/scripts/export-rn-tokens.mjs
import { formatHex, oklch } from "culori";
import { writeFileSync } from "node:fs";

const light = {
  background: "oklch(1 0 0)",
  foreground: "oklch(0.2064 0.0377 264.41)",
  card: "oklch(1 0 0)",
  cardForeground: "oklch(0.2064 0.0377 264.41)",
  primary: "oklch(0.55 0.20 285)",
  primaryForeground: "oklch(1 0 0)",
  secondary: "oklch(0.972 0.022 285)",
  secondaryForeground: "oklch(0.33 0.09 285)",
  muted: "oklch(0.975 0.02 285)",
  mutedForeground: "oklch(0.52 0.045 285)",
  accent: "oklch(0.972 0.022 285)",
  accentForeground: "oklch(0.55 0.20 285)",
  destructive: "oklch(0.58 0.2157 27.72)",
  destructiveForeground: "oklch(1 0 0)",
  border: "oklch(0.922 0.022 285)",
  input: "oklch(0.922 0.022 285)",
  ring: "oklch(0.55 0.20 285)",
  success: "oklch(0.63 0.16 150)",
  warning: "oklch(0.75 0.15 74)",
  error: "oklch(0.58 0.2157 27.72)",
  info: "oklch(0.6 0.13 240)",
};

const dark = {
  background: "oklch(0.18 0.03 285)",
  foreground: "oklch(0.97 0.015 285)",
  card: "oklch(0.22 0.035 285)",
  cardForeground: "oklch(0.97 0.015 285)",
  primary: "oklch(0.72 0.17 285)",
  primaryForeground: "oklch(0.18 0.03 285)",
  secondary: "oklch(0.29 0.05 285)",
  secondaryForeground: "oklch(0.97 0.015 285)",
  muted: "oklch(0.29 0.05 285)",
  mutedForeground: "oklch(0.75 0.04 285)",
  accent: "oklch(0.35 0.09 285)",
  accentForeground: "oklch(0.97 0.015 285)",
  destructive: "oklch(0.6606 0.1423 24.41)",
  destructiveForeground: "oklch(0.18 0.03 285)",
  border: "oklch(0.32 0.06 285)",
  input: "oklch(0.32 0.06 285)",
  ring: "oklch(0.72 0.17 285)",
  success: "oklch(0.72 0.17 152)",
  warning: "oklch(0.82 0.16 80)",
  error: "oklch(0.6606 0.1423 24.41)",
  info: "oklch(0.7 0.13 240)",
};

const toHex = (entries) =>
  Object.fromEntries(
    Object.entries(entries).map(([k, v]) => [k, formatHex(oklch(v))])
  );

const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, "2xl": 48, "3xl": 64 };
const radius = { sm: 6, md: 8, lg: 10, xl: 16, "2xl": 24, "3xl": 32, full: 9999 };
const fontSize = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, "2xl": 24, "3xl": 30, "4xl": 36, "5xl": 48 };

const file = `// GENERATED by design-system/scripts/export-rn-tokens.mjs — do not edit by hand.
export const lightColors = ${JSON.stringify(toHex(light), null, 2)} as const;
export const darkColors = ${JSON.stringify(toHex(dark), null, 2)} as const;
export const spacing = ${JSON.stringify(spacing, null, 2)} as const;
export const radius = ${JSON.stringify(radius, null, 2)} as const;
export const fontSize = ${JSON.stringify(fontSize, null, 2)} as const;
`;

writeFileSync(new URL("../../apps/mobile/src/theme/tokens.ts", import.meta.url), file);
console.log("tokens.ts written");
```

Run: `cd design-system && npm init -y >/dev/null 2>&1 || true && npm install culori && node scripts/export-rn-tokens.mjs`
Expected: `apps/mobile/src/theme/tokens.ts` generated, `lightColors.background === "#ffffff"`.

- [ ] **Step 2: Write failing theme test** — `apps/mobile/src/theme/__tests__/tokens.test.ts`

```ts
import { darkColors, lightColors, radius, spacing } from "../tokens";

test("light background is pure white per Iris spec", () => {
  expect(lightColors.background).toBe("#ffffff");
});

test("every light color key has a dark counterpart", () => {
  expect(Object.keys(darkColors).sort()).toEqual(Object.keys(lightColors).sort());
});

test("all colors are hex strings parseable by RN", () => {
  for (const v of [...Object.values(lightColors), ...Object.values(darkColors)]) {
    expect(v).toMatch(/^#[0-9a-f]{6}$/);
  }
});

test("spacing and radius match the design system scale", () => {
  expect(spacing.md).toBe(16);
  expect(radius.lg).toBe(10);
});
```

Run: `cd apps/mobile && npm test` → PASS if generation succeeded (test-first here validates generated output; if it fails, the script has a bug).

- [ ] **Step 3: Write `apps/mobile/src/theme/index.ts`**

```ts
import { useColorScheme } from "react-native";
import { darkColors, fontSize, lightColors, radius, spacing } from "./tokens";

// Widen to string values so both lightColors and darkColors (which have
// distinct literal-hex types under `as const`) are assignable to ThemeColors.
export type ThemeColors = Record<keyof typeof lightColors, string>;

export function useTheme() {
  const scheme = useColorScheme() ?? "light";
  const colors: ThemeColors = scheme === "dark" ? darkColors : lightColors;
  return { colors, spacing, radius, fontSize, scheme } as const;
}
```

- [ ] **Step 4: Typecheck + test**

Run: `cd apps/mobile && npx tsc --noEmit && npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add design-system/scripts design-system/package.json apps/mobile/src/theme
git commit -m "feat: export iris design tokens to react native theme module"
```

---

### Task 8: Core native primitives — Text, Button, Card

**Files:**
- Create: `apps/mobile/src/components/Text.tsx`, `apps/mobile/src/components/Button.tsx`, `apps/mobile/src/components/Card.tsx`, `apps/mobile/src/components/__tests__/primitives.test.tsx`
- Modify: `apps/mobile/app/index.tsx` (use the primitives)

**Interfaces:**
- Consumes: `useTheme()` from Task 7.
- Produces:
  - `<AppText variant="h1"|"h2"|"h3"|"body"|"caption">` — maps to design-system presets (h1: 36/bold/tight, h2: 30/bold, h3: 24/semibold, body: 16/normal, caption: 12).
  - `<Button title onPress variant="primary"|"secondary"|"ghost" disabled?>` — 48px min height, `radius.lg`, accessibilityRole="button".
  - `<Card>` — `card` background, `radius.xl`, `spacing.md` padding.

- [ ] **Step 1: Write failing component tests** — `apps/mobile/src/components/__tests__/primitives.test.tsx`

```tsx
import { fireEvent, render } from "@testing-library/react-native";
import { AppText } from "../Text";
import { Button } from "../Button";
import { Card } from "../Card";
import { Text } from "react-native";

test("AppText renders children with variant", () => {
  const { getByText } = render(<AppText variant="h1">Kora</AppText>);
  expect(getByText("Kora")).toBeTruthy();
});

test("Button fires onPress and exposes accessibility role", () => {
  const onPress = jest.fn();
  const { getByRole } = render(<Button title="Log meal" onPress={onPress} />);
  fireEvent.press(getByRole("button"));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test("Button does not fire when disabled", () => {
  const onPress = jest.fn();
  const { getByRole } = render(<Button title="Log" onPress={onPress} disabled />);
  fireEvent.press(getByRole("button"));
  expect(onPress).not.toHaveBeenCalled();
});

test("Card renders children", () => {
  const { getByText } = render(
    <Card>
      <Text>inside</Text>
    </Card>
  );
  expect(getByText("inside")).toBeTruthy();
});
```

Run: `cd apps/mobile && npm test` → FAIL (components missing).

- [ ] **Step 2: Implement**

`apps/mobile/src/components/Text.tsx`:

```tsx
import { Text, type TextProps } from "react-native";
import { useTheme } from "@/theme";

type Variant = "h1" | "h2" | "h3" | "body" | "caption";

const presets: Record<Variant, { size: number; weight: "400" | "600" | "700"; letterSpacing?: number }> = {
  h1: { size: 36, weight: "700", letterSpacing: -0.9 },
  h2: { size: 30, weight: "700", letterSpacing: -0.75 },
  h3: { size: 24, weight: "600" },
  body: { size: 16, weight: "400" },
  caption: { size: 12, weight: "400" },
};

type Props = TextProps & { variant?: Variant; muted?: boolean };

export function AppText({ variant = "body", muted = false, style, ...rest }: Props) {
  const { colors } = useTheme();
  const p = presets[variant];
  return (
    <Text
      style={[
        {
          fontSize: p.size,
          fontWeight: p.weight,
          letterSpacing: p.letterSpacing,
          color: muted ? colors.mutedForeground : colors.foreground,
        },
        style,
      ]}
      {...rest}
    />
  );
}
```

`apps/mobile/src/components/Button.tsx`:

```tsx
import { Pressable, Text, type PressableProps } from "react-native";
import { useTheme } from "@/theme";

type Variant = "primary" | "secondary" | "ghost";

type Props = Omit<PressableProps, "children"> & {
  title: string;
  variant?: Variant;
};

export function Button({ title, variant = "primary", disabled, ...rest }: Props) {
  const { colors, radius, spacing } = useTheme();
  const bg =
    variant === "primary" ? colors.primary : variant === "secondary" ? colors.secondary : "transparent";
  const fg =
    variant === "primary" ? colors.primaryForeground : variant === "secondary" ? colors.secondaryForeground : colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      style={({ pressed }) => ({
        minHeight: 48,
        borderRadius: radius.lg,
        backgroundColor: bg,
        paddingHorizontal: spacing.lg,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
      {...rest}
    >
      <Text style={{ color: fg, fontSize: 16, fontWeight: "600" }}>{title}</Text>
    </Pressable>
  );
}
```

`apps/mobile/src/components/Card.tsx`:

```tsx
import { View, type ViewProps } from "react-native";
import { useTheme } from "@/theme";

export function Card({ style, ...rest }: ViewProps) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: colors.card,
          borderRadius: radius.xl,
          padding: spacing.md,
          borderWidth: 1,
          borderColor: colors.border,
        },
        style,
      ]}
      {...rest}
    />
  );
}
```

- [ ] **Step 3: Run tests to verify pass**

Run: `cd apps/mobile && npm test && npx tsc --noEmit` → PASS.

- [ ] **Step 4: Use primitives on the index screen** — replace `apps/mobile/app/index.tsx`:

```tsx
import { View } from "react-native";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { useTheme } from "@/theme";

export default function Index() {
  const { colors, spacing } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.background,
        justifyContent: "center",
        padding: spacing.lg,
        gap: spacing.md,
      }}
    >
      <AppText variant="h1">Kora</AppText>
      <AppText muted>Nutrition that feels like conversation.</AppText>
      <Card>
        <AppText variant="h3">Today</AppText>
        <AppText muted>Nothing logged yet.</AppText>
      </Card>
      <Button title="Get started" onPress={() => {}} />
    </View>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/mobile
git commit -m "feat: core native primitives styled with iris tokens"
```

---

### Task 9: Firebase sign-in in the app + authenticated /v1/me call

**Files:**
- Create: `apps/mobile/src/lib/firebase.ts`, `apps/mobile/src/lib/api.ts`, `apps/mobile/src/lib/__tests__/api.test.ts`, `apps/mobile/app/sign-in.tsx`
- Modify: `apps/mobile/app/_layout.tsx`, `apps/mobile/app/index.tsx`

**Interfaces:**
- Consumes: `EXPO_PUBLIC_FIREBASE_*` + `EXPO_PUBLIC_API_URL` env vars; `/v1/me` from Task 5.
- Produces:
  - `firebase.ts`: initialized `auth` export (Firebase JS SDK, RN persistence).
  - `api.ts`: `apiFetch(path: string, init?: RequestInit): Promise<unknown>` — attaches `Authorization: Bearer <idToken>` from the current Firebase user, throws `ApiError{status, code, message}` on non-2xx parsed from the envelope.
  - `/sign-in` screen: email + password fields, sign-in + sign-up, error display.
  - `index.tsx` shows the signed-in user's email from `/v1/me` and a sign-out button.

- [ ] **Step 1: Install deps**

Run: `cd apps/mobile && npx expo install firebase @react-native-async-storage/async-storage`

- [ ] **Step 2: Write `apps/mobile/src/lib/firebase.ts`**

```ts
import { initializeApp } from "firebase/app";
import { getReactNativePersistence, initializeAuth } from "firebase/auth";
import AsyncStorage from "@react-native-async-storage/async-storage";

const app = initializeApp({
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
});

export const auth = initializeAuth(app, {
  persistence: getReactNativePersistence(AsyncStorage),
});
```

- [ ] **Step 3: Write failing api client test** — `apps/mobile/src/lib/__tests__/api.test.ts`

```ts
import { ApiError, apiFetch } from "../api";

jest.mock("../firebase", () => ({
  auth: { currentUser: { getIdToken: jest.fn().mockResolvedValue("test-token") } },
}));

beforeEach(() => {
  global.fetch = jest.fn();
});

test("attaches bearer token from firebase user", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({ data: { email: "a@b.c" } }),
  });

  await apiFetch("/v1/me");

  const [, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(init.headers.Authorization).toBe("Bearer test-token");
});

test("throws ApiError with envelope fields on failure", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: false,
    status: 401,
    json: async () => ({ error: "unauthorized", message: "invalid or missing token" }),
  });

  await expect(apiFetch("/v1/me")).rejects.toThrow(ApiError);
  await expect(apiFetch("/v1/me")).rejects.toMatchObject({
    status: 401,
    code: "unauthorized",
  });
});
```

Run: `cd apps/mobile && npm test` → FAIL (`../api` missing).

- [ ] **Step 4: Implement `apps/mobile/src/lib/api.ts`**

```ts
import { auth } from "./firebase";

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8080";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const user = auth.currentUser;
  const token = user ? await user.getIdToken() : null;

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, body.error ?? "unknown", body.message ?? "request failed");
  }
  const body = (await res.json()) as { data?: unknown };
  return body.data ?? body;
}
```

Run: `cd apps/mobile && npm test` → PASS.

- [ ] **Step 5: Build sign-in screen** — `apps/mobile/app/sign-in.tsx`

```tsx
import { useState } from "react";
import { TextInput, View } from "react-native";
import { router } from "expo-router";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { auth } from "@/lib/firebase";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { useTheme } from "@/theme";

export default function SignIn() {
  const { colors, spacing, radius } = useTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.input,
    borderRadius: radius.lg,
    padding: spacing.md,
    color: colors.foreground,
    minHeight: 48,
  } as const;

  async function submit(mode: "in" | "up") {
    setBusy(true);
    setError(null);
    try {
      if (mode === "in") await signInWithEmailAndPassword(auth, email, password);
      else await createUserWithEmailAndPassword(auth, email, password);
      router.replace("/");
    } catch {
      setError("Sign-in failed. Check your email and password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: "center", padding: spacing.lg, gap: spacing.md }}>
      <AppText variant="h1">Welcome to Kora</AppText>
      <TextInput style={inputStyle} placeholder="Email" placeholderTextColor={colors.mutedForeground} autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
      <TextInput style={inputStyle} placeholder="Password" placeholderTextColor={colors.mutedForeground} secureTextEntry value={password} onChangeText={setPassword} />
      {error ? <AppText style={{ color: colors.destructive }}>{error}</AppText> : null}
      <Button title={busy ? "…" : "Sign in"} onPress={() => submit("in")} disabled={busy} />
      <Button title="Create account" variant="secondary" onPress={() => submit("up")} disabled={busy} />
    </View>
  );
}
```

- [ ] **Step 6: Auth gate + profile display** — replace `apps/mobile/app/index.tsx` body: subscribe to `onAuthStateChanged`; unauthenticated → `router.replace("/sign-in")`; authenticated → `apiFetch("/v1/me")` and render the email, plus a ghost "Sign out" button calling `signOut(auth)`:

```tsx
import { useEffect, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { apiFetch } from "@/lib/api";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { useTheme } from "@/theme";

type Profile = { email: string; display_name: string };

export default function Index() {
  const { colors, spacing } = useTheme();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/sign-in");
        return;
      }
      try {
        setProfile((await apiFetch("/v1/me")) as Profile);
      } catch {
        setError("Could not load your profile.");
      }
    });
    return unsub;
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: "center", padding: spacing.lg, gap: spacing.md }}>
      <AppText variant="h1">Kora</AppText>
      <Card>
        <AppText variant="h3">Profile</AppText>
        <AppText muted>{error ?? profile?.email ?? "Loading…"}</AppText>
      </Card>
      <Button title="Sign out" variant="ghost" onPress={() => signOut(auth)} />
    </View>
  );
}
```

- [ ] **Step 7: End-to-end verify (manual)**

Run API locally (`DATABASE_URL='postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable' FIREBASE_PROJECT_ID=kora-app go run ./cmd/api` — env vars exported, no `.env` autoload exists) + `npx expo start` with `apps/mobile/.env` copied from `.env.example` and Firebase values filled. In the simulator: create account → land on home → profile card shows your email (row exists in Postgres `users`).
Expected: full round trip works.

- [ ] **Step 8: Typecheck, test, commit**

Run: `cd apps/mobile && npx tsc --noEmit && npm test` → PASS.

```bash
git add apps/mobile
git commit -m "feat: firebase email sign-in wired to authenticated /v1/me"
```

---

### Task 10: API Dockerfile + CI workflow

**Files:**
- Create: `api/Dockerfile`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: repo variables `WIF_PROVIDER`, `CI_SERVICE_ACCOUNT` (same convention as other Tesserix repos — set via `set-repo-variables.sh` or manually).
- Produces: image `asia-south1-docker.pkg.dev/tesserix-app/services/kora-api:{sha}` on pushes to `main`.

- [ ] **Step 1: Write `api/Dockerfile`** (multi-stage, matching Tesserix Go service pattern)

```dockerfile
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /bin/api ./cmd/api

FROM alpine:3.19
RUN adduser -D -u 10001 app
USER app
COPY --from=build /bin/api /usr/local/bin/api
EXPOSE 8080
ENTRYPOINT ["api"]
```

Run: `cd api && docker build -t kora-api:local .` → builds successfully.

- [ ] **Step 2: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  id-token: write

jobs:
  api:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15-alpine
        env:
          POSTGRES_DB: kora
          POSTGRES_USER: kora
          POSTGRES_PASSWORD: kora_dev
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U kora" --health-interval 5s
          --health-timeout 3s --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.26"
          cache-dependency-path: api/go.sum
      - name: Vet
        run: cd api && go vet ./...
      - name: Test
        env:
          TEST_DATABASE_URL: postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable
        run: |
          cd api
          go run ./cmd/migrate 2>/dev/null || true
          go test -race -coverprofile=coverage.out ./...

  mobile:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
          cache-dependency-path: apps/mobile/package-lock.json
      - run: cd apps/mobile && npm ci
      - run: cd apps/mobile && npx tsc --noEmit
      - run: cd apps/mobile && npm test

  build-image:
    if: github.ref == 'refs/heads/main'
    needs: [api]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ vars.WIF_PROVIDER }}
          service_account: ${{ vars.CI_SERVICE_ACCOUNT }}
      - uses: google-github-actions/setup-gcloud@v2
      - run: gcloud auth configure-docker asia-south1-docker.pkg.dev --quiet
      - name: Build and push
        run: |
          IMAGE=asia-south1-docker.pkg.dev/tesserix-app/services/kora-api
          docker build -t "$IMAGE:${{ github.sha }}" -t "$IMAGE:latest" api/
          docker push "$IMAGE:${{ github.sha }}"
          docker push "$IMAGE:latest"
```

Note: the API test job needs the `users` migration applied before `go test` (the `internal/user` test hits Postgres). Migrations are embedded and run on app start, not in tests — so add a tiny migrate runner: `api/cmd/migrate/main.go`:

```go
package main

import (
	"log"
	"os"

	"github.com/tesserix/kora/api/internal/database"
)

func main() {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = os.Getenv("DATABASE_URL")
	}
	if url == "" {
		log.Fatal("migrate: DATABASE_URL or TEST_DATABASE_URL required")
	}
	if err := database.Migrate(url); err != nil {
		log.Fatal(err)
	}
}
```

Replace the `go run ./cmd/migrate 2>/dev/null || true` line with `TEST_DATABASE_URL=... go run ./cmd/migrate` (no error suppression).

- [ ] **Step 3: Verify locally**

Run: `cd api && go vet ./... && go test -race ./...` → PASS.

- [ ] **Step 4: Commit + push, watch CI**

```bash
git add api/Dockerfile api/cmd/migrate .github/workflows/ci.yml
git commit -m "ci: api dockerfile, migrate runner, github actions workflow"
git push origin main
gh run watch
```

Expected: all jobs green (build-image requires `WIF_PROVIDER`/`CI_SERVICE_ACCOUNT` repo variables — set them first if missing).

---

### Task 11: Dev deploy to GKE (tesserix-k8s, postiz pattern)

**Files (in the sibling `tesserix-k8s` repo, not this one):**
- Create: `charts/apps/kora-api/Chart.yaml`, `charts/apps/kora-api/values.yaml`, `charts/apps/kora-api/templates/{namespace,deployment,service,externalsecret,virtualservice}.yaml`, `argocd/prod/projects/kora.yaml`, `argocd/prod/apps/kora/kora-api.yaml`
- Modify: `argocd/prod/projects/kustomization.yaml`, `argocd/prod/apps/kora/kustomization.yaml` (create)

**Interfaces:**
- Consumes: image `asia-south1-docker.pkg.dev/tesserix-app/services/kora-api` from Task 10; GCP Secret Manager secrets `kora-db-url` (Cloud SQL connection string) and `kora-firebase-project-id`.
- Produces: `kora-api` reachable at `https://api.kora.tesserix.app` (VirtualService on the existing Istio gateway + Cloudflare tunnel route).

- [ ] **Step 1: Study the postiz chart as the canonical pattern**

Run: `ls ../tesserix-k8s/charts/apps/postiz/templates/ && cat ../tesserix-k8s/charts/apps/postiz/values.yaml`
Copy its structure exactly — namespace, ExternalSecret against the ClusterSecretStore, deployment with resource limits, service, VirtualService bound to the shared Istio gateway, ArgoCD project + app entries. Mirror every convention (labels, sync policy, namespace naming).

- [ ] **Step 2: Create secrets in GCP Secret Manager**

```bash
echo -n 'postgres://kora_user:<password>@127.0.0.1:5432/kora_db?sslmode=disable' | \
  gcloud secrets create kora-db-url --project=tesseracthub-480811 --replication-policy=automatic --data-file=-
echo -n 'kora-app' | \
  gcloud secrets create kora-firebase-project-id --project=tesseracthub-480811 --replication-policy=automatic --data-file=-
```

(Create the `kora_db` database + `kora_user` on the shared Cloud SQL instance first, following the `{service_prefix}_db` / `{service_prefix}_user` convention.)

- [ ] **Step 3: Write chart values** — `charts/apps/kora-api/values.yaml` (adapt to postiz chart schema found in Step 1):

```yaml
name: kora-api
namespace: kora
image:
  repository: asia-south1-docker.pkg.dev/tesserix-app/services/kora-api
  tag: latest
replicas: 1
resources:
  requests: { cpu: 50m, memory: 128Mi }
  limits: { cpu: 500m, memory: 256Mi }
service:
  port: 8080
env:
  ENV: production
  PORT: "8080"
secrets:
  DATABASE_URL: kora-db-url
  FIREBASE_PROJECT_ID: kora-firebase-project-id
virtualservice:
  host: api.kora.tesserix.app
probes:
  liveness: /health
  readiness: /ready
```

Template files mirror postiz's — same ExternalSecret → K8s Secret → env flow, same gateway reference. If the postiz chart uses a Cloud SQL Auth Proxy sidecar for DB-backed services (check `tesserix-infra/k8s/bases/go-service/`), add the sidecar to the deployment the same way.

- [ ] **Step 4: Register with ArgoCD** — add `kora` project + app YAMLs following `argocd/prod/projects/postiz.yaml` and `argocd/prod/apps/ai-apps/postiz.yaml` as line-for-line templates (change names/paths/namespace), and add both to their kustomization lists.

- [ ] **Step 5: Deploy + verify**

```bash
cd ../tesserix-k8s
git add charts/apps/kora-api argocd/
git commit -m "feat: deploy kora-api to gke"
git push
argocd app sync kora-api
kubectl -n kora get pods
curl -s https://api.kora.tesserix.app/health
```

Expected: pod Running, `{"status":"ok"}` from the public URL, `/ready` also 200 (DB reachable through the configured connection).

- [ ] **Step 6: Point the mobile app at dev**

Add to `apps/mobile/.env.example`: comment line `# EXPO_PUBLIC_API_URL=https://api.kora.tesserix.app`. Commit in the kora repo:

```bash
git add apps/mobile/.env.example
git commit -m "docs: note dev api url in mobile env example"
```

---

## Definition of Done (Phase 0)

- [ ] `docker compose up` gives local Postgres + Redis; API boots, migrates, `/health` + `/ready` green.
- [ ] All Go tests pass with `-race`; mobile tests + `tsc --noEmit` pass.
- [ ] On a simulator: create account → sign in → home screen shows profile email fetched from `/v1/me` → sign out returns to sign-in.
- [ ] CI green on main; image pushed to GAR.
- [ ] `curl https://api.kora.tesserix.app/health` returns `{"status":"ok"}` from the GKE dev deploy.
- [ ] App screens use only theme tokens (no hardcoded colors outside `tokens.ts`).
