package resolveoutcome

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"gorm.io/gorm"
)

// Repository reads and writes resolution outcomes.
type Repository struct{ db *gorm.DB }

// NewRepository builds the repository.
func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

// Record writes one outcome and NEVER returns an error.
//
// This runs on the resolve path — the most latency-sensitive surface in the
// product (#79) — and a measurement must not be able to break the thing it
// measures. The posture is copied exactly from ai.Resolver.record, which
// discards billing.Meter.Record's error for the same reason: the row is worth
// having and never worth failing a user's meal log over.
//
// Synchronous rather than fire-and-forget, also copying that precedent. A
// goroutine here would need its own context (the request's is cancelled the
// moment the response is written, so the insert would race the response and
// usually lose) and would drop rows silently on shutdown. One small insert
// alongside the several queries a resolve already makes is the cheaper trade.
//
// A rejected value is dropped with a log rather than written: the CHECK
// constraints would reject it anyway, and an invalid row surfacing as a
// constraint violation inside a resolve is exactly the failure this function
// exists to prevent.
func (r Repository) Record(ctx context.Context, o Outcome) {
	if !o.Kind.Valid() || !o.Mode.Valid() {
		slog.WarnContext(ctx, "resolveoutcome: refusing to record an unrecognised outcome",
			"kind", string(o.Kind), "mode", string(o.Mode))
		return
	}
	if o.Status == "" {
		o.Status = StatusOpen
	}
	if err := r.db.WithContext(ctx).Create(&o).Error; err != nil {
		// Logged, never returned. An operator who notices the backlog has
		// stopped growing needs this line to tell whether that is good news.
		slog.WarnContext(ctx, "resolveoutcome: record failed", "err", err, "kind", string(o.Kind))
	}
}

// TriageParams bounds a read of the human-waiting queue.
type TriageParams struct {
	Limit  int
	Offset int
}

// ListTriage returns the outcomes waiting on a human, oldest first, with the
// unpaged total.
//
// Oldest first for the reason the feedback inbox is: a queue exists to surface
// what has been waiting longest, and newest-first hides exactly that item
// behind a page boundary.
//
// Scoped by Kind.NeedsHuman rather than by a literal list, so the queue and
// the health backlog below can never disagree about what counts.
func (r Repository) ListTriage(ctx context.Context, p TriageParams) ([]Outcome, int64, error) {
	db := r.db.WithContext(ctx).
		Model(&Outcome{}).
		Where("kind IN ?", needsHumanKinds()).
		Where("status IN ?", OpenStatuses)

	var total int64
	if err := db.Count(&total).Error; err != nil {
		return nil, 0, fmt.Errorf("resolveoutcome: count triage: %w", err)
	}

	var rows []Outcome
	if err := db.Order("created_at ASC").Limit(p.Limit).Offset(p.Offset).
		Find(&rows).Error; err != nil {
		return nil, 0, fmt.Errorf("resolveoutcome: list triage: %w", err)
	}
	return rows, total, nil
}

// BacklogDepth is how many outcomes are waiting on a human right now.
//
// The health endpoint's probe (#434). Separate from ListTriage so the probe
// does not pay for a page of rows it will not render.
func (r Repository) BacklogDepth(ctx context.Context) (int64, error) {
	var n int64
	if err := r.db.WithContext(ctx).
		Model(&Outcome{}).
		Where("kind IN ?", needsHumanKinds()).
		Where("status IN ?", OpenStatuses).
		Count(&n).Error; err != nil {
		return 0, fmt.Errorf("resolveoutcome: backlog depth: %w", err)
	}
	return n, nil
}

// Rates is the answer to "does the resolver work", over a window.
type Rates struct {
	Attempts int64
	// ByKind carries every kind that occurred. A kind absent from this map
	// occurred zero times; callers rendering a fixed set must supply the
	// zeroes themselves rather than omitting the row.
	ByKind map[Kind]int64
	// NeedsHuman is the count of attempts that left work for a person.
	NeedsHuman int64
	// FirstTry is attempts that resolved with confidence WITHOUT a prior
	// correction — auto/confirm tier, excluding alias short-circuits and cache
	// hits.
	//
	// Excluding aliases is the point: an alias hit is a phrase the resolver
	// got wrong once already and a human fixed. Counting it as a first-try
	// success would make the correction loop improve the metric that is
	// supposed to be measuring whether corrections are still needed.
	FirstTry int64
}

// FirstTryRate is FirstTry as a percentage of attempts that could have been
// first-try successes — that is, excluding cache hits and alias hits, neither
// of which exercised the resolver at all.
//
// Returns ok=false when the denominator is zero. A rate over no attempts is
// not 0%, and rendering it as one is how an empty window comes to look like a
// total failure.
func (r Rates) FirstTryRate() (float64, bool) {
	denom := r.Attempts - r.ByKind[KindCache] - r.ByKind[KindAlias]
	if denom <= 0 {
		return 0, false
	}
	return 100 * float64(r.FirstTry) / float64(denom), true
}

// Since reads the outcome counts from a lower bound with no upper bound.
//
// This is the package's existing public entry point, kept stable rather than
// widened to take an upper bound: #507's Between is added ALONGSIDE it, not
// in place of it, so any future caller that only ever wants "everything
// since X" is not forced to pass a zero upper bound to get that.
func (r Repository) Since(ctx context.Context, from time.Time) (Rates, error) {
	return r.Between(ctx, from, time.Time{})
}

// Between reads the outcome counts for a bounded window: from is the lower
// bound, to the upper. A zero to means no upper bound, matching Since's
// existing behaviour — Since is now expressed in terms of this method rather
// than duplicating the query, so the two can never disagree about what a
// window counts.
func (r Repository) Between(ctx context.Context, from, to time.Time) (Rates, error) {
	type row struct {
		Kind  Kind
		Count int64
	}
	db := r.db.WithContext(ctx).
		Model(&Outcome{}).
		Select("kind, count(*) AS count").
		Where("created_at >= ?", from)
	if !to.IsZero() {
		db = db.Where("created_at <= ?", to)
	}

	var rows []row
	if err := db.Group("kind").Scan(&rows).Error; err != nil {
		return Rates{}, fmt.Errorf("resolveoutcome: rates: %w", err)
	}

	out := Rates{ByKind: make(map[Kind]int64, len(rows))}
	for _, r := range rows {
		out.ByKind[r.Kind] = r.Count
		out.Attempts += r.Count
		if r.Kind.NeedsHuman() {
			out.NeedsHuman += r.Count
		}
		if r.Kind == KindResolved {
			out.FirstTry += r.Count
		}
	}
	return out, nil
}

// needsHumanKinds is the closed set NeedsHuman admits, as SQL values. Derived
// by asking Kind.NeedsHuman rather than by restating the list, so a kind added
// to that predicate reaches the queries without a second edit.
func needsHumanKinds() []Kind {
	out := make([]Kind, 0, 2)
	for _, k := range AllKinds {
		if k.NeedsHuman() {
			out = append(out, k)
		}
	}
	return out
}
