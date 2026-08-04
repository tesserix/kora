package ai

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// #81: ai_usage_events recorded a call ONLY when it succeeded, so a failed
// provider call left no trace and COGS was a one-directional undercount. Worse,
// a never-working path and a never-attempted path were indistinguishable in the
// data — which is exactly how three stacked photo bugs stayed invisible.

func TestResolve_RecordsUsageWhenTheProviderFails(t *testing.T) {
	meter := &stubMeter{withinBudget: true}
	provider := &stubProvider{
		name:       "primary-stub",
		guessErr:   errors.New("provider exploded"),
		guessUsage: Usage{Provider: "primary-stub", Model: "m", CallType: "identify_photo", TokensIn: 100},
	}
	r := NewResolver(provider, nutrition.Repository{}, NoCache{}, meter)

	_, err := r.ResolvePhoto(context.Background(), uuid.New(), []byte("jpeg"), "image/jpeg")

	require.Error(t, err, "the caller must still see the failure")
	// The call was made and billed upstream whether or not it answered.
	require.Len(t, meter.records, 1, "a failed provider call must still be metered")
	assert.Equal(t, 100, meter.records[0].TokensIn)
	assert.Equal(t, OutcomeError, meter.records[0].Outcome)
}

func TestResolveVoice_RecordsUsageWhenTranscribeFails(t *testing.T) {
	meter := &stubMeter{withinBudget: true}
	provider := &stubProvider{
		name:            "primary-stub",
		transcriptErr:   errors.New("transcribe exploded"),
		transcriptUsage: Usage{Provider: "primary-stub", Model: "m", CallType: "transcribe", TokensIn: 50},
	}
	r := NewResolver(provider, nutrition.Repository{}, NoCache{}, meter)

	_, err := r.ResolveVoice(context.Background(), uuid.New(), []byte("audio"), "audio/mp4")

	require.Error(t, err)
	require.Len(t, meter.records, 1, "a failed transcription must still be metered")
	assert.Equal(t, OutcomeError, meter.records[0].Outcome)
}

// The undercount that bites even on SUCCESSFUL resolves: when the primary is
// abandoned and the fallback serves, two provider calls were made and only one
// was ever recorded. Asserted at the Router, which is what abandons the leg.
// (The photo path deliberately has no fallback since #87, so this uses text.)
func TestRouter_DepositsAbandonedPrimaryLeg(t *testing.T) {
	primary := &stubProvider{
		name:       "primary-stub",
		guessErr:   errors.New("primary exploded"),
		guessUsage: Usage{Provider: "primary-stub", Model: "p", CallType: "identify_text", TokensIn: 10},
	}
	fallback := &stubProvider{
		name:       "fallback-stub",
		guesses:    []Guess{{Food: "apple", Confidence: 0.95}},
		guessUsage: Usage{Provider: "fallback-stub", Model: "f", CallType: "identify_text", TokensIn: 20},
	}
	router := &Router{Primary: primary, Fallback: fallback}

	ctx, sink := withUsageSink(context.Background())
	_, usage, err := router.IdentifyText(ctx, "apple")

	require.NoError(t, err)
	assert.Equal(t, "fallback-stub", usage.Provider, "the fallback served, so its usage is returned")
	assert.Equal(t, OutcomeOK, usage.Outcome)

	deposited := sink.drain()
	require.Len(t, deposited, 1, "the abandoned primary leg was billed too and must be surfaced")
	assert.Equal(t, "primary-stub", deposited[0].Provider)
	assert.Equal(t, 10, deposited[0].TokensIn)
	assert.Equal(t, OutcomeError, deposited[0].Outcome)
}

// A primary that misses its latency budget is the case photoBudget and #79 both
// turn on, and nothing could answer "how often does the fast path miss?" before.
func TestRouter_BudgetMissIsDepositedAsTimeout(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", block: true}
	fallback := &stubProvider{
		name:       "fallback-stub",
		guesses:    []Guess{{Food: "apple"}},
		guessUsage: Usage{Provider: "fallback-stub", CallType: "identify_text"},
	}
	router := &Router{Primary: primary, Fallback: fallback, TextBudget: 20 * time.Millisecond}

	ctx, sink := withUsageSink(context.Background())
	_, _, err := router.IdentifyText(ctx, "apple")
	require.NoError(t, err)

	deposited := sink.drain()
	require.Len(t, deposited, 1)
	assert.Equal(t, OutcomeTimeout, deposited[0].Outcome,
		"a budget miss must be distinguishable from an outright error")
}

// A provider that deposits an abandoned leg, standing in for the Router, so the
// Resolver's drain-and-record can be asserted without a food index.
type depositingProvider struct {
	*stubProvider
	deposit Usage
}

func (p *depositingProvider) IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]Guess, Usage, error) {
	addUsage(ctx, p.deposit)
	return nil, Usage{Provider: "returned-stub", CallType: "identify_photo", TokensIn: 5}, errors.New("boom")
}

// The Resolver must meter EVERY leg, not just the one whose result it returns.
func TestResolve_RecordsDepositedLegsAsWellAsTheReturnedOne(t *testing.T) {
	meter := &stubMeter{withinBudget: true}
	provider := &depositingProvider{
		stubProvider: &stubProvider{name: "primary-stub"},
		deposit:      Usage{Provider: "abandoned-stub", CallType: "identify_photo", TokensIn: 11, Outcome: OutcomeTimeout},
	}
	r := NewResolver(provider, nutrition.Repository{}, NoCache{}, meter)

	_, err := r.ResolvePhoto(context.Background(), uuid.New(), []byte("jpeg"), "image/jpeg")
	require.Error(t, err)

	byProvider := map[string]Usage{}
	for _, u := range meter.records {
		byProvider[u.Provider] = u
	}
	require.Contains(t, byProvider, "abandoned-stub", "a deposited leg must be metered")
	require.Contains(t, byProvider, "returned-stub", "the returned leg must be metered even though it failed")
	assert.Equal(t, OutcomeTimeout, byProvider["abandoned-stub"].Outcome)
	assert.Equal(t, OutcomeError, byProvider["returned-stub"].Outcome)
}
