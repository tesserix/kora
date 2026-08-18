package ai

import "context"

// A per-request sink for provider calls that were made but whose Usage is not
// the one returned to the caller — specifically the primary leg that
// withFallback abandons when it fails or misses its budget.
//
// Why a context sink rather than a wider return type: Router must keep
// satisfying Provider, whose methods return exactly one Usage, and Router has
// no userID to meter with. The Resolver has both the userID and the meter, so
// the metering consumer opens a sink for the request, the router deposits
// abandoned legs into it, and the consumer drains and records them on BOTH the
// success and error paths. One mechanism closes both drops described in #81.
// UsageCollector gathers provider calls a Router made but could not return in
// its single Usage result. Provider consumers that own a meter install one for
// each routed call and drain it before recording the returned leg.
type UsageCollector struct {
	usages []Usage
}

type usageSinkKey struct{}

// WithUsageCollector installs a fresh per-call collector in ctx.
func WithUsageCollector(ctx context.Context) (context.Context, *UsageCollector) {
	s := &UsageCollector{}
	return context.WithValue(ctx, usageSinkKey{}, s), s
}

func withUsageSink(ctx context.Context) (context.Context, *UsageCollector) {
	return WithUsageCollector(ctx)
}

// addUsage deposits a provider call that happened but is not being returned.
// It is a no-op when no sink is installed, so providers and the router stay
// usable outside a Resolver (tests, cmd/ tools) without special-casing.
func addUsage(ctx context.Context, u Usage) {
	s, ok := ctx.Value(usageSinkKey{}).(*UsageCollector)
	if !ok || s == nil {
		return
	}
	s.usages = append(s.usages, u)
}

// Drain returns the collected usages and empties the collector.
func (s *UsageCollector) Drain() []Usage {
	if s == nil {
		return nil
	}
	out := s.usages
	s.usages = nil
	return out
}

func (s *UsageCollector) drain() []Usage {
	return s.Drain()
}
