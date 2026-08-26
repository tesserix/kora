// Package platformadmin serves Kora's slice of the Product Admin Integration
// Contract to the Tesserix platform console.
//
// It is deliberately separate from package admin, which serves the
// tesserix-home admin PORTAL. Different auth chain (platformauth, not
// bffauth), different response envelope (§4.1's {data, pagination}, not
// httpx.OK's {data}), different audience. The two share the tables beneath
// them and nothing at the HTTP layer, and consolidating them would mean one
// of the two contracts silently changing shape whenever the other moved.
//
// Contract: tesserix-home/docs/superpowers/specs/
// 2026-08-14-product-admin-integration-contract.md (v2).
//
// This surface is READ-ONLY. That is a decision, not an omission — see #447
// and docs/admin-contract.md. Foods and users are edited through Kora's own
// portal; the console observes. Adding a write here means first answering
// §8.3's questions about capability values, reason codes and idempotency,
// none of which have an answer today.
package platformadmin

import (
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// Paging bounds. DefaultLimit is what a caller that names none gets;
// MaxLimit clamps rather than refuses, because a ceiling on our side is the
// backstop for a fan-out asking every product for too much at once.
const (
	DefaultLimit = 50
	MaxLimit     = 200
)

// Pagination is §4.1's block, verbatim. Page is 1-based.
type Pagination struct {
	Page  int   `json:"page"`
	Limit int   `json:"limit"`
	Total int64 `json:"total"`
}

// page renders §4.1's envelope.
//
// data is typed `any` rather than a slice so callers pass an already-
// allocated concrete slice; every caller in this package allocates with make.
// A nil slice marshals to `null`, which defeats a consumer's `?? []` and
// crashes their page precisely when there is no data — the production crash
// §4.5 exists because of.
func page(c *gin.Context, data any, p Pagination) {
	c.JSON(200, gin.H{"data": data, "pagination": p})
}

// Query is the parsed, bounded form of the parameters every list endpoint on
// this surface accepts.
type Query struct {
	Limit  int
	Page   int
	Search string
	From   time.Time
	To     time.Time
}

// Offset is the SQL offset this page starts at.
func (q Query) Offset() int { return (q.Page - 1) * q.Limit }

// parseQuery never fails. §4.5 and the contract's tone both say a missing or
// unparseable parameter takes the default rather than refusing the request:
// the console fans one query out across every product, and a product that
// 400s on a parameter another product ignores takes the whole estate
// timeline down with it.
//
// since_hours is honoured because federation's audit fan-out sends it on
// every call (see its Query.path). An explicit from/to wins over it, because
// a caller that named both meant the specific one.
func parseQuery(c *gin.Context, now time.Time) Query {
	q := Query{Limit: DefaultLimit, Page: 1, Search: strings.TrimSpace(c.Query("q"))}

	if v := strings.TrimSpace(c.Query("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			q.Limit = min(n, MaxLimit)
		}
	}
	if v := strings.TrimSpace(c.Query("page")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			q.Page = n
		}
	}
	if v := strings.TrimSpace(c.Query("since_hours")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			q.From = now.Add(-time.Duration(n) * time.Hour)
		}
	}
	if t, ok := parseTime(c.Query("from")); ok {
		q.From = t
	}
	if t, ok := parseTime(c.Query("to")); ok {
		q.To = t
	}
	return q
}

func parseTime(v string) (time.Time, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// stamp renders §4.3's timestamp: ISO 8601, UTC, with offset.
func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// nowUTC is the clock for endpoints that parse a Query but do not use its
// time bounds — the inbox pages and filters by nothing time-shaped, so
// threading an injectable clock through it would be ceremony with no test
// that could ever notice. Endpoints whose ANSWER depends on the clock
// (audit-logs' since_hours, health's checked_at) carry their own injectable
// `now` instead.
func nowUTC() time.Time { return time.Now().UTC() }
