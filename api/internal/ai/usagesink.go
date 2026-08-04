package ai

import "context"

// A per-request sink for provider calls that were made but whose Usage is not
// the one returned to the caller — specifically the primary leg that
// withFallback abandons when it fails or misses its budget.
//
// Why a context sink rather than a wider return type: Router must keep
// satisfying Provider, whose methods return exactly one Usage, and Router has
// no userID to meter with. The Resolver has both the userID and the meter, so
// it opens a sink for the request, the router deposits abandoned legs into it,
// and the Resolver drains and records them on BOTH the success and error
// paths. One mechanism closes both drops described in #81.
type usageSink struct {
	usages []Usage
}

type usageSinkKey struct{}

// withUsageSink returns a context carrying a fresh sink, plus the sink itself.
func withUsageSink(ctx context.Context) (context.Context, *usageSink) {
	s := &usageSink{}
	return context.WithValue(ctx, usageSinkKey{}, s), s
}

// addUsage deposits a provider call that happened but is not being returned.
// It is a no-op when no sink is installed, so providers and the router stay
// usable outside a Resolver (tests, cmd/ tools) without special-casing.
func addUsage(ctx context.Context, u Usage) {
	s, ok := ctx.Value(usageSinkKey{}).(*usageSink)
	if !ok || s == nil {
		return
	}
	s.usages = append(s.usages, u)
}

// drain returns the deposited usages and empties the sink.
func (s *usageSink) drain() []Usage {
	if s == nil {
		return nil
	}
	out := s.usages
	s.usages = nil
	return out
}
