package resolveoutcome

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/tesserix/kora/api/internal/ai"
)

func TestSinkStoresTheResolutionIDTraceAndRankedCandidates(t *testing.T) {
	db := tx(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)
	resolutionID := uuid.New()
	ctx, span := sdktrace.NewTracerProvider().Tracer("test").Start(
		ai.WithResolutionID(context.Background(), resolutionID), "capture.text")
	defer span.End()
	first, second := uuid.New(), uuid.New()

	NewSink(repo).Record(ctx, ai.ResolveOutcome{
		UserID: userID, Kind: "resolved", Tier: "auto", Mode: "text",
		CandidateIDs: []uuid.UUID{first, second},
	})

	got, err := repo.Get(context.Background(), userID, resolutionID)
	require.NoError(t, err)
	require.NotNil(t, got.TraceID)
	assert.Equal(t, span.SpanContext().TraceID().String(), *got.TraceID)
	assert.Equal(t, []uuid.UUID{first, second}, got.Candidates())
}

func TestSinkWithoutATraceStoresNoTraceID(t *testing.T) {
	db := tx(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)
	resolutionID := uuid.New()

	NewSink(repo).Record(ai.WithResolutionID(context.Background(), resolutionID),
		ai.ResolveOutcome{UserID: userID, Kind: "no_match", Mode: "text"})

	got, err := repo.Get(context.Background(), userID, resolutionID)
	require.NoError(t, err)
	assert.Nil(t, got.TraceID)
	assert.Empty(t, got.Candidates())
}

func TestGetIsScopedToTheOwner(t *testing.T) {
	db := tx(t)
	repo := NewRepository(db)
	owner, other := seedUser(t, db), seedUser(t, db)
	resolutionID := uuid.New()
	NewSink(repo).Record(ai.WithResolutionID(context.Background(), resolutionID),
		ai.ResolveOutcome{UserID: owner, Kind: "resolved", Mode: "text"})

	_, err := repo.Get(context.Background(), other, resolutionID)
	assert.ErrorIs(t, err, ErrNotFound)
}
