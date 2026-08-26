package main

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/redis/go-redis/v9"

	"github.com/tesserix/kora/api/internal/config"
	"github.com/tesserix/kora/api/internal/platformadmin"
)

// platformHealthProbes builds the dependency checks behind
// GET /v1/admin/health.
//
// Only Redis is built here. Postgres is built inside the router from the
// *gorm.DB it already holds, so main does not have to hand a connection back
// to something that already has one.
//
// # Why a dedicated Redis client
//
// buildResolveHandler pings Redis ONCE at boot and, on failure, closes the
// client and runs cache-less for the life of the process (#105). That is the
// right call for a cache — but it means the resolve path holds no client to
// probe once Redis is unreachable, which is precisely the state the console
// needs to be told about. A probe that can only report "up" is not a probe.
//
// So this client is separate and deliberately NOT pinged at construction:
// go-redis dials lazily, so an unreachable Redis costs nothing until the
// first /admin/health call, and a Redis that recovers is reported as
// recovered without a restart. It is closed by the returned cleanup.
//
// Returns a nil cleanup when REDIS_URL is unparseable, in which case no redis
// probe is wired and the dependency reports `unknown` rather than `ok` — the
// registry entry stays, so a malformed URL surfaces as a missing measurement
// instead of a healthy tile.
func platformHealthProbes(cfg config.Config, logger *slog.Logger) (map[string]platformadmin.Probe, func()) {
	opt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		logger.Warn("platform health: redis probe not wired (REDIS_URL unparseable)", "err", err)
		return nil, func() {}
	}

	client := redis.NewClient(opt)
	probes := map[string]platformadmin.Probe{
		platformadmin.DepRedis: func(ctx context.Context) (map[string]int64, error) {
			if err := client.Ping(ctx).Err(); err != nil {
				return nil, fmt.Errorf("redis ping: %w", err)
			}
			// No metrics: Redis here is a cache that either answers or does
			// not. Reporting a key count would be a number nobody acts on.
			return nil, nil
		},
	}
	return probes, func() { _ = client.Close() }
}
