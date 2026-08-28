package resolveoutcome

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// tx opens a transaction and registers its rollback immediately, so it runs on
// Goexit too (a require failure). Every assertion is made against THIS
// transaction, so the shared test database's ambient rows can neither satisfy
// nor defeat one.
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
	require.NoError(t, db.Exec(
		`INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)`,
		id, "fro-"+id.String(), "fro-"+id.String()+"@kora.test").Error)
	return id
}

func phrase(s string) *string { return &s }

func record(t *testing.T, r Repository, userID uuid.UUID, kind Kind, at time.Time) {
	t.Helper()
	o := Outcome{UserID: userID, Kind: kind, Mode: ModeText, Phrase: phrase(string(kind))}
	if !at.IsZero() {
		o.CreatedAt = at
	}
	r.Record(context.Background(), o)
}

func TestRecordWritesTheRow(t *testing.T) {
	db := tx(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)
	foodID := uuid.New()
	require.NoError(t, db.Exec(
		`INSERT INTO food_items (id, name, provenance, kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g)
		 VALUES (?, 'Toast', 'curated', 250, 8, 45, 3)`, foodID).Error)

	score := 0.42
	repo.Record(context.Background(), Outcome{
		UserID: userID, Kind: KindBelowFloor, Tier: "follow_up", Mode: ModeText,
		Phrase: phrase("mcspicy"), TopFoodItemID: &foodID, TopScore: &score,
		CandidateCount: 3,
	})

	var got Outcome
	require.NoError(t, db.Where("user_id = ?", userID).First(&got).Error)
	assert.Equal(t, KindBelowFloor, got.Kind)
	assert.Equal(t, "follow_up", got.Tier)
	assert.Equal(t, ModeText, got.Mode)
	require.NotNil(t, got.Phrase)
	assert.Equal(t, "mcspicy", *got.Phrase)
	require.NotNil(t, got.TopScore)
	assert.InDelta(t, 0.42, *got.TopScore, 1e-9)
	assert.Equal(t, 3, got.CandidateCount)
	assert.Equal(t, StatusOpen, got.Status, "a new row defaults to open, ready for triage")
}

// TestRecordRejectsAnUnrecognisedValue — the CHECK would reject it anyway, and
// a constraint violation surfacing INSIDE a resolve is the failure Record
// exists to prevent. It must be dropped here, quietly and without erroring.
func TestRecordRejectsAnUnrecognisedValue(t *testing.T) {
	db := tx(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)

	assert.NotPanics(t, func() {
		repo.Record(context.Background(), Outcome{UserID: userID, Kind: "invented", Mode: ModeText})
		repo.Record(context.Background(), Outcome{UserID: userID, Kind: KindNoMatch, Mode: "telepathy"})
	})

	var n int64
	require.NoError(t, db.Model(&Outcome{}).Where("user_id = ?", userID).Count(&n).Error)
	assert.Equal(t, int64(0), n)
}

// TestRecordNeverFailsAResolve — the whole contract of this function. A broken
// table must not be able to break food logging.
func TestRecordNeverFailsAResolve(t *testing.T) {
	db := tx(t)
	userID := seedUser(t, db)
	// Poison the transaction so every subsequent statement errors.
	require.Error(t, db.Exec(`SELECT * FROM a_table_that_does_not_exist`).Error)

	assert.NotPanics(t, func() {
		NewRepository(db).Record(context.Background(),
			Outcome{UserID: userID, Kind: KindNoMatch, Mode: ModeText})
	})
}

// TestTriageCarriesOnlyWorkAHumanCanDo — a weak match is a soft signal and a
// decomposition is a known-imprecise answer. Putting either in the queue would
// bury the two that are actionable.
func TestTriageCarriesOnlyWorkAHumanCanDo(t *testing.T) {
	db := tx(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)

	for _, k := range AllKinds {
		record(t, repo, userID, k, time.Time{})
	}

	rows, total, err := repo.ListTriage(context.Background(), TriageParams{Limit: 100})
	require.NoError(t, err)

	kinds := make([]Kind, 0, len(rows))
	for _, r := range rows {
		kinds = append(kinds, r.Kind)
		assert.True(t, r.Kind.NeedsHuman(), "%s reached the queue", r.Kind)
	}
	assert.ElementsMatch(t, []Kind{KindBelowFloor, KindNoMatch}, kinds)
	assert.Equal(t, int64(2), total)
}

// TestTriageIsOldestFirst — a queue exists to surface what has been waiting
// longest; newest-first hides exactly that item behind a page boundary.
func TestTriageIsOldestFirst(t *testing.T) {
	db := tx(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)

	now := time.Now().UTC()
	record(t, repo, userID, KindNoMatch, now)
	record(t, repo, userID, KindBelowFloor, now.Add(-72*time.Hour))

	rows, _, err := repo.ListTriage(context.Background(), TriageParams{Limit: 100})
	require.NoError(t, err)
	require.Len(t, rows, 2)
	assert.Equal(t, KindBelowFloor, rows[0].Kind, "the older item comes first")
}

// TestTriageExcludesResolvedItems — a triaged item must leave the queue, or
// the backlog only ever grows and the depth stops meaning anything.
func TestTriageExcludesResolvedItems(t *testing.T) {
	db := tx(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)

	record(t, repo, userID, KindNoMatch, time.Time{})
	record(t, repo, userID, KindNoMatch, time.Time{})

	// By id, NOT `.Limit(1).Update(...)`: Postgres UPDATE takes no LIMIT, so
	// GORM drops it and the update hits BOTH rows — which made this test
	// report 0 remaining and look like the filter was broken.
	var first Outcome
	require.NoError(t, db.Where("user_id = ?", userID).First(&first).Error)
	require.NoError(t, db.Model(&Outcome{}).
		Where("id = ?", first.ID).
		Update("status", StatusResolved).Error)

	_, total, err := repo.ListTriage(context.Background(), TriageParams{Limit: 100})
	require.NoError(t, err)
	assert.Equal(t, int64(1), total)
}

// TestBacklogDepthAgreesWithTheQueue — the health probe and the inbox must
// never disagree about what is waiting, or one of them is lying to an
// operator about whether anyone is keeping up.
func TestBacklogDepthAgreesWithTheQueue(t *testing.T) {
	db := tx(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)

	for _, k := range AllKinds {
		record(t, repo, userID, k, time.Time{})
	}

	_, total, err := repo.ListTriage(context.Background(), TriageParams{Limit: 100})
	require.NoError(t, err)
	depth, err := repo.BacklogDepth(context.Background())
	require.NoError(t, err)

	assert.Equal(t, total, depth)
}

func TestSinceCountsEveryKind(t *testing.T) {
	db := tx(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)

	record(t, repo, userID, KindResolved, time.Time{})
	record(t, repo, userID, KindResolved, time.Time{})
	record(t, repo, userID, KindNoMatch, time.Time{})
	record(t, repo, userID, KindAlias, time.Time{})
	record(t, repo, userID, KindCache, time.Time{})

	got, err := repo.Since(context.Background(), time.Now().Add(-time.Hour))
	require.NoError(t, err)

	assert.Equal(t, int64(5), got.Attempts)
	assert.Equal(t, int64(2), got.ByKind[KindResolved])
	assert.Equal(t, int64(1), got.NeedsHuman)
	assert.Equal(t, int64(2), got.FirstTry, "only the resolved rows are first-try successes")
	assert.Equal(t, int64(1), got.ByKind[KindAlias], "an alias hit is counted, but never as first-try")
}

// TestSinceHonoursTheWindow — a rate over "all time" is not the rate anyone
// asked for, and a window that is parsed but not applied looks identical.
func TestSinceHonoursTheWindow(t *testing.T) {
	db := tx(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)

	record(t, repo, userID, KindResolved, time.Now().UTC())
	record(t, repo, userID, KindResolved, time.Now().UTC().Add(-72*time.Hour))

	got, err := repo.Since(context.Background(), time.Now().Add(-24*time.Hour))
	require.NoError(t, err)
	assert.Equal(t, int64(1), got.Attempts)
}

// TestBetweenBoundsBothEnds — #507's whole reason to exist: Since only ever
// bounded the bottom of the window, and a caller asking about a specific
// past window (not "since X, forever") needs the top bounded too.
func TestBetweenBoundsBothEnds(t *testing.T) {
	db := tx(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)
	now := time.Now().UTC()

	record(t, repo, userID, KindResolved, now.Add(-3*time.Hour)) // before the window
	record(t, repo, userID, KindResolved, now.Add(-time.Hour))   // inside
	record(t, repo, userID, KindResolved, now)                   // after the window

	got, err := repo.Between(context.Background(), now.Add(-2*time.Hour), now.Add(-30*time.Minute))
	require.NoError(t, err)
	assert.Equal(t, int64(1), got.Attempts, "only the row inside [from, to] counts")
}

// TestBetweenWithZeroToMatchesSince — a zero upper bound must mean "no upper
// bound", so Since (from, unbounded) and Between (from, zero) agree.
func TestBetweenWithZeroToMatchesSince(t *testing.T) {
	db := tx(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)
	now := time.Now().UTC()

	record(t, repo, userID, KindResolved, now)

	from := now.Add(-time.Hour)
	since, err := repo.Since(context.Background(), from)
	require.NoError(t, err)
	between, err := repo.Between(context.Background(), from, time.Time{})
	require.NoError(t, err)

	assert.Equal(t, since.Attempts, between.Attempts)
}

// TestFirstTryRateExcludesCacheAndAlias is the arithmetic that matters for
// kora#328's "≥90% correct on first try".
//
// An alias hit is a phrase the resolver got wrong ONCE ALREADY and a human
// fixed. Counting it as a first-try success would let the correction loop
// improve the very metric that measures whether corrections are still needed.
// A cache hit did not exercise the resolver at all.
func TestFirstTryRateExcludesCacheAndAlias(t *testing.T) {
	r := Rates{
		Attempts: 10,
		ByKind: map[Kind]int64{
			KindResolved: 6, KindNoMatch: 2, KindCache: 1, KindAlias: 1,
		},
		FirstTry: 6,
	}

	rate, ok := r.FirstTryRate()
	require.True(t, ok)
	// 6 of 8 — NOT 6 of 10.
	assert.InDelta(t, 75.0, rate, 1e-9)
}

// TestFirstTryRateOverNoAttempts — a rate over nothing is not 0%. Rendering it
// as one is how an empty window comes to look like a total failure.
func TestFirstTryRateOverNoAttempts(t *testing.T) {
	_, ok := Rates{ByKind: map[Kind]int64{}}.FirstTryRate()
	assert.False(t, ok)

	_, ok = Rates{Attempts: 2, ByKind: map[Kind]int64{KindCache: 2}}.FirstTryRate()
	assert.False(t, ok, "all attempts excluded leaves no denominator")
}

// TestNeedsHumanIsTheOnlyDefinition — the queue, the depth and the rate all
// read this predicate. A second list somewhere would drift.
func TestNeedsHumanIsTheOnlyDefinition(t *testing.T) {
	assert.True(t, KindBelowFloor.NeedsHuman())
	assert.True(t, KindNoMatch.NeedsHuman())
	for _, k := range AllKinds {
		if k == KindBelowFloor || k == KindNoMatch {
			continue
		}
		assert.False(t, k.NeedsHuman(), "%s must not be triage work", k)
	}
}

// TestAllKindsIsComplete — Valid() is derived from AllKinds, so a kind added
// to the type and forgotten there would pass validation nowhere and be
// silently unwritable.
func TestAllKindsIsComplete(t *testing.T) {
	for _, k := range AllKinds {
		assert.True(t, k.Valid(), "%s is in AllKinds but fails Valid", k)
	}
	assert.False(t, Kind("invented").Valid())
	assert.Len(t, AllKinds, 10)
}
