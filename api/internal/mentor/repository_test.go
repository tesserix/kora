package mentor

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func mentorTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL required")
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	require.NoError(t, err)
	return db
}

func seedMentorUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(`
		INSERT INTO users (id, firebase_uid, email, display_name)
		VALUES (?, ?, ?, 'Mentor Test')`, id, "mentor-"+id.String(), id.String()+"@test.dev").Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })
	return id
}

func TestRepositoryUpsertsProfileAndHealthDaysWithinOwner(t *testing.T) {
	db := mentorTestDB(t)
	repo := NewRepository(db)
	owner := seedMentorUser(t, db)
	other := seedMentorUser(t, db)
	ctx := context.Background()

	profile := Profile{
		UserID:                owner,
		Motivation:            "Have energy for my family",
		DietaryPreferences:    "Vegetarian weekdays",
		Allergies:             "Peanuts",
		CoachingStyle:         CoachingStyleSupportive,
		ReminderIntensity:     ReminderIntensityBalanced,
		QuietStartMinute:      22 * 60,
		QuietEndMinute:        7 * 60,
		HealthStepsEnabled:    true,
		HealthSleepEnabled:    true,
		HealthWorkoutsEnabled: false,
	}
	require.NoError(t, repo.UpsertProfile(ctx, profile))

	got, found, err := repo.ProfileForUser(ctx, owner)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, profile.Motivation, got.Motivation)

	_, found, err = repo.ProfileForUser(ctx, other)
	require.NoError(t, err)
	require.False(t, found, "another user must never inherit the owner's mentor profile")

	day := time.Date(2026, 8, 22, 0, 0, 0, 0, time.UTC)
	steps := 4200
	first := HealthDay{
		UserID: owner, LocalDate: day, Timezone: "Australia/Melbourne",
		Steps: &steps, Source: HealthSourceHealthKit,
		ObservedAt: time.Date(2026, 8, 22, 10, 0, 0, 0, time.UTC),
	}
	require.NoError(t, repo.UpsertHealthDays(ctx, owner, []HealthDay{first}))

	updatedSteps := 7100
	first.Steps = &updatedSteps
	first.ObservedAt = first.ObservedAt.Add(time.Hour)
	require.NoError(t, repo.UpsertHealthDays(ctx, owner, []HealthDay{first}))

	days, err := repo.HealthDaysSince(ctx, owner, day.AddDate(0, 0, -1), 31)
	require.NoError(t, err)
	require.Len(t, days, 1, "retrying a local day must update, not duplicate")
	require.Equal(t, updatedSteps, *days[0].Steps)

	otherDays, err := repo.HealthDaysSince(ctx, other, day.AddDate(0, 0, -1), 31)
	require.NoError(t, err)
	require.Empty(t, otherDays)
}

func TestRepositoryCommitmentAndCheckInNeverCrossOwners(t *testing.T) {
	db := mentorTestDB(t)
	repo := NewRepository(db)
	owner := seedMentorUser(t, db)
	other := seedMentorUser(t, db)
	ctx := context.Background()
	id := uuid.New()

	commitment := Commitment{
		ID: id, UserID: owner, Title: "Walk after work", Kind: CommitmentKindWalking,
		Cadence: CadenceFixed, WeekdaysMask: 62, StartMinute: 18*60 + 30,
		Timezone: "Australia/Melbourne", StartsOn: time.Date(2026, 8, 22, 0, 0, 0, 0, time.UTC),
		Status: CommitmentStatusActive, Source: CommitmentSourceUser,
	}
	got, err := repo.PutCommitment(ctx, commitment)
	require.NoError(t, err)
	require.Equal(t, "Walk after work", got.Title)

	_, err = repo.CommitmentForUser(ctx, other, id)
	require.ErrorIs(t, err, ErrNotFound)

	hijack := commitment
	hijack.UserID = other
	hijack.Title = "Changed by someone else"
	_, err = repo.PutCommitment(ctx, hijack)
	require.ErrorIs(t, err, ErrNotFound)

	stillOwned, err := repo.CommitmentForUser(ctx, owner, id)
	require.NoError(t, err)
	require.Equal(t, "Walk after work", stillOwned.Title)

	scheduled := time.Date(2026, 8, 24, 8, 30, 0, 0, time.UTC)
	_, err = repo.PutCheckIn(ctx, other, id, CheckIn{
		ScheduledFor: scheduled,
		LocalDate:    time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC),
		Action:       CheckInActionDone,
	})
	require.ErrorIs(t, err, ErrNotFound)

	snoozedUntil := scheduled.Add(30 * time.Minute)
	checkIn, err := repo.PutCheckIn(ctx, owner, id, CheckIn{
		ScheduledFor: scheduled,
		LocalDate:    time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC),
		Action:       CheckInActionSnoozed,
		SnoozedUntil: &snoozedUntil,
	})
	require.NoError(t, err)
	require.Equal(t, CheckInActionSnoozed, checkIn.Action)

	checkIn, err = repo.PutCheckIn(ctx, owner, id, CheckIn{
		ScheduledFor: scheduled,
		LocalDate:    time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC),
		Action:       CheckInActionDone,
	})
	require.NoError(t, err)
	require.Equal(t, CheckInActionDone, checkIn.Action)

	var count int64
	require.NoError(t, db.Model(&CheckIn{}).
		Where("commitment_id = ? AND scheduled_for = ?", id, scheduled).
		Count(&count).Error)
	require.EqualValues(t, 1, count, "a retried occurrence must remain one check-in")
}

func TestRepositoryArchivedCommitmentsStayOutOfActiveGrounding(t *testing.T) {
	db := mentorTestDB(t)
	repo := NewRepository(db)
	owner := seedMentorUser(t, db)
	ctx := context.Background()
	base := Commitment{
		UserID: owner, Kind: CommitmentKindHydration, Cadence: CadenceInterval,
		WeekdaysMask: 127, StartMinute: 8 * 60, IntervalMinutes: intPtr(120),
		EndMinute: intPtr(20 * 60), Timezone: "Australia/Melbourne",
		StartsOn: time.Date(2026, 8, 22, 0, 0, 0, 0, time.UTC),
		Source:   CommitmentSourceUser,
	}
	active := base
	active.ID, active.Title, active.Status = uuid.New(), "Water through the day", CommitmentStatusActive
	archived := base
	archived.ID, archived.Title, archived.Status = uuid.New(), "Old plan", CommitmentStatusArchived
	_, err := repo.PutCommitment(ctx, active)
	require.NoError(t, err)
	_, err = repo.PutCommitment(ctx, archived)
	require.NoError(t, err)

	items, err := repo.ActiveCommitments(ctx, owner, time.Date(2026, 8, 23, 0, 0, 0, 0, time.UTC), 20)
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, active.ID, items[0].ID)

	_, err = repo.CommitmentForUser(ctx, uuid.New(), active.ID)
	require.True(t, errors.Is(err, ErrNotFound))
}

func intPtr(v int) *int { return &v }
