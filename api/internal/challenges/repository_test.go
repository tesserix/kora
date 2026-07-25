package challenges

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

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

func seedUser(t *testing.T, db *gorm.DB, name string, targetKcal float64) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec("INSERT INTO users (id, firebase_uid, email, display_name, target_kcal) VALUES (?, ?, ?, ?, ?)",
		id, "ch-"+id.String(), "ch-"+id.String()+"@test.dev", name, targetKcal).Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM challenge_participants WHERE user_id = ?", id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

func seedGroup(t *testing.T, db *gorm.DB, owner uuid.UUID) uuid.UUID {
	t.Helper()
	gid := uuid.New()
	require.NoError(t, db.Exec("INSERT INTO groups (id, name, owner_id, invite_code) VALUES (?, ?, ?, ?)",
		gid, "Squad", owner, "CH"+gid.String()[:6]).Error)
	require.NoError(t, db.Exec("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'owner')", gid, owner).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM groups WHERE id = ?", gid) })
	return gid
}

func TestCreateAutoJoinsCreatorAndSetsJoinedAt(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "Owner", 2000)
	gid := seedGroup(t, db, owner)

	start := time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 0, 7)
	ch, err := repo.Create(context.Background(), gid, owner, "July streak", MetricLogged, start, end)
	require.NoError(t, err)
	require.NotEqual(t, uuid.Nil, ch.ID)
	t.Cleanup(func() { db.Exec("DELETE FROM challenges WHERE id = ?", ch.ID) })

	// creator auto-joined with a real joined_at (not the Go zero time)
	var p ChallengeParticipant
	require.NoError(t, db.Where("challenge_id = ? AND user_id = ?", ch.ID, owner).First(&p).Error)
	require.False(t, p.JoinedAt.IsZero(), "joined_at should be populated, not the Go zero time")

	isP, err := repo.IsParticipant(context.Background(), ch.ID, owner)
	require.NoError(t, err)
	require.True(t, isP)
}

func TestListForGroupCountsParticipantsAndViewerJoined(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "Owner", 2000)
	other := seedUser(t, db, "Other", 1800)
	gid := seedGroup(t, db, owner)
	start := time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC)
	ch, err := repo.Create(context.Background(), gid, owner, "July streak", MetricOnTarget, start, start.AddDate(0, 0, 14))
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM challenges WHERE id = ?", ch.ID) })
	require.NoError(t, repo.AddParticipant(context.Background(), ch.ID, other))
	// idempotent
	require.NoError(t, repo.AddParticipant(context.Background(), ch.ID, other))

	// viewer = owner -> joined true, count 2
	summaries, err := repo.ListForGroup(context.Background(), gid, owner)
	require.NoError(t, err)
	require.Len(t, summaries, 1)
	require.Equal(t, "July streak", summaries[0].Title)
	require.Equal(t, MetricOnTarget, summaries[0].Metric)
	require.Equal(t, 2, summaries[0].ParticipantCount)
	require.True(t, summaries[0].Joined)

	// scoring rows include target_kcal for every participant
	rows, err := repo.ListParticipantsForScoring(context.Background(), ch.ID)
	require.NoError(t, err)
	require.Len(t, rows, 2)

	// leave removes participation
	require.NoError(t, repo.RemoveParticipant(context.Background(), ch.ID, other))
	isP, err := repo.IsParticipant(context.Background(), ch.ID, other)
	require.NoError(t, err)
	require.False(t, isP)
}

func TestDeleteCascadesParticipants(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "Owner", 2000)
	gid := seedGroup(t, db, owner)
	start := time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC)
	ch, err := repo.Create(context.Background(), gid, owner, "Gone soon", MetricLogged, start, start.AddDate(0, 0, 7))
	require.NoError(t, err)

	require.NoError(t, repo.Delete(context.Background(), ch.ID))
	got, err := repo.FindByID(context.Background(), ch.ID)
	require.NoError(t, err)
	require.Nil(t, got)
	var count int64
	require.NoError(t, db.Model(&ChallengeParticipant{}).Where("challenge_id = ?", ch.ID).Count(&count).Error)
	require.Equal(t, int64(0), count)
}
