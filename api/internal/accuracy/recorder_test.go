package accuracy

import (
	"context"
	"net/http"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/resolveoutcome"
)

func tx(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	require.NoError(t, err)
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	return tx
}

func seedUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(`INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)`,
		id, "acc-"+id.String(), "acc-"+id.String()+"@kora.test").Error)
	return id
}

func TestRecorderScoresALoggedResolutionOnItsTrace(t *testing.T) {
	db := tx(t)
	outcomes := resolveoutcome.NewRepository(db)
	userID, other := seedUser(t, db), seedUser(t, db)
	resolutionID, top := uuid.New(), uuid.New()
	ctx, span := sdktrace.NewTracerProvider().Tracer("t").Start(ai.WithResolutionID(context.Background(), resolutionID), "capture.text")
	span.End()
	resolveoutcome.NewSink(outcomes).Record(ctx, ai.ResolveOutcome{
		UserID: userID, Kind: "resolved", Tier: "auto", Mode: "text", CandidateIDs: []uuid.UUID{top},
	})
	srv, got := langfuse(t, http.StatusOK)
	client := NewClient(Config{Host: srv.URL, PublicKey: "pk", SecretKey: "sk"})
	rec := NewRecorder(outcomes, client)

	assert.True(t, rec.Owns(context.Background(), userID, resolutionID, 0))
	assert.False(t, rec.Owns(context.Background(), other, resolutionID, 0))
	assert.False(t, rec.Owns(context.Background(), userID, resolutionID, 1), "no item at that index")
	rec.Logged(context.Background(), userID, resolutionID, 0, top, false)
	require.NoError(t, client.Close(context.Background()))

	require.Len(t, got.bodies, 2)
	for _, b := range got.bodies {
		assert.Equal(t, span.SpanContext().TraceID().String(), b["traceId"])
		assert.Equal(t, 1.0, b["value"])
	}
}

func TestRecorderWithoutLangfuseStillLinks(t *testing.T) {
	db := tx(t)
	outcomes := resolveoutcome.NewRepository(db)
	userID := seedUser(t, db)
	resolutionID := uuid.New()
	resolveoutcome.NewSink(outcomes).Record(ai.WithResolutionID(context.Background(), resolutionID),
		ai.ResolveOutcome{UserID: userID, Kind: "resolved", Mode: "text", CandidateIDs: []uuid.UUID{uuid.New()}})
	rec := NewRecorder(outcomes, nil)

	assert.True(t, rec.Owns(context.Background(), userID, resolutionID, 0))
	assert.NotPanics(t, func() { rec.Logged(context.Background(), userID, resolutionID, 0, uuid.New(), false) })
}
