package feedback

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// seedUserNamed inserts a user row with an explicit display_name, so tests
// can control both the "has a name" and "empty string name" cases. Unlike
// seedUser (repository_test.go), which leaves display_name NULL, this lets
// TestListToleratesEmptyDisplayName reproduce the pre-seeding-fix state of
// an empty string rather than a NULL.
func seedUserNamed(t *testing.T, db *gorm.DB, email, displayName string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, firebase_uid, email, display_name) VALUES (?, ?, ?, ?)",
		id, "feedback-"+id.String(), email, displayName).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })
	return id
}

// seedFeedback inserts a feedback row with an explicit created_at, so
// ordering and pagination tests do not depend on real-clock timing.
func seedFeedback(t *testing.T, db *gorm.DB, userID uuid.UUID, kind Kind, status Status, subject string, createdAt time.Time) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		`INSERT INTO feedback (id, user_id, kind, subject, description, status, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, userID, string(kind), subject, "desc: "+subject, string(status), createdAt).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM feedback WHERE id = ?", id) })
	return id
}

func TestListReturnsNewestFirst(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)

	older := time.Now().Add(-time.Hour)
	newer := time.Now()
	seedFeedback(t, db, userID, KindBug, StatusOpen, "older", older)
	newID := seedFeedback(t, db, userID, KindBug, StatusOpen, "newer", newer)

	res, err := repo.List(context.Background(), ListParams{})
	require.NoError(t, err)
	require.NotEmpty(t, res.Items)
	require.Equal(t, newID, res.Items[0].ID, "the newest row must be first")
}

func TestListFiltersByStatus(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)

	openID := seedFeedback(t, db, userID, KindBug, StatusOpen, "open one", time.Now())
	seedFeedback(t, db, userID, KindBug, StatusResolved, "resolved one", time.Now())

	open := StatusOpen
	filtered, err := repo.List(context.Background(), ListParams{Status: &open})
	require.NoError(t, err)
	require.Len(t, filtered.Items, 1)
	require.Equal(t, openID, filtered.Items[0].ID)

	unfiltered, err := repo.List(context.Background(), ListParams{})
	require.NoError(t, err)
	require.Len(t, unfiltered.Items, 2, "unfiltered call must return both rows")
}

func TestListFiltersByKind(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)

	bugID := seedFeedback(t, db, userID, KindBug, StatusOpen, "a bug", time.Now())
	seedFeedback(t, db, userID, KindFeature, StatusOpen, "a feature", time.Now())

	bug := KindBug
	filtered, err := repo.List(context.Background(), ListParams{Kind: &bug})
	require.NoError(t, err)
	require.Len(t, filtered.Items, 1)
	require.Equal(t, bugID, filtered.Items[0].ID)

	unfiltered, err := repo.List(context.Background(), ListParams{})
	require.NoError(t, err)
	require.Len(t, unfiltered.Items, 2, "unfiltered call must return both rows")
}

func TestListTotalIsUnpaginatedCount(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)

	seedFeedback(t, db, userID, KindBug, StatusOpen, "one", time.Now())
	seedFeedback(t, db, userID, KindBug, StatusOpen, "two", time.Now())
	seedFeedback(t, db, userID, KindBug, StatusOpen, "three", time.Now())

	res, err := repo.List(context.Background(), ListParams{Limit: 1})
	require.NoError(t, err)
	require.Len(t, res.Items, 1, "the page must be limited to 1 row")
	require.EqualValues(t, 3, res.Total, "Total must count all matching rows, not just the page")
}

func TestListJoinsSubmitterIdentity(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	id := uuid.New()
	userID := seedUserNamed(t, db, "named-"+id.String()+"@test.dev", "Ada Lovelace")
	feedbackID := seedFeedback(t, db, userID, KindBug, StatusOpen, "identity check", time.Now())

	res, err := repo.List(context.Background(), ListParams{})
	require.NoError(t, err)

	var got *Item
	for i := range res.Items {
		if res.Items[i].ID == feedbackID {
			got = &res.Items[i]
		}
	}
	require.NotNil(t, got, "seeded row must be present in the results")
	require.Equal(t, "named-"+id.String()+"@test.dev", got.Email)
	require.Equal(t, "Ada Lovelace", got.DisplayName)
}

func TestListToleratesEmptyDisplayName(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	id := uuid.New()
	userID := seedUserNamed(t, db, "blank-"+id.String()+"@test.dev", "")
	feedbackID := seedFeedback(t, db, userID, KindBug, StatusOpen, "blank name check", time.Now())

	res, err := repo.List(context.Background(), ListParams{})
	require.NoError(t, err)

	var got *Item
	for i := range res.Items {
		if res.Items[i].ID == feedbackID {
			got = &res.Items[i]
		}
	}
	require.NotNil(t, got, "seeded row must be present in the results")
	require.Equal(t, "blank-"+id.String()+"@test.dev", got.Email)
	require.Equal(t, "", got.DisplayName)
}

func TestUpdateStatusPersistsAndReturnsRow(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)
	feedbackID := seedFeedback(t, db, userID, KindBug, StatusOpen, "to be resolved", time.Now())

	updated, err := repo.UpdateStatus(context.Background(), feedbackID, StatusResolved)
	require.NoError(t, err)
	require.Equal(t, StatusResolved, updated.Status)

	var reread Feedback
	require.NoError(t, db.First(&reread, "id = ?", feedbackID).Error)
	require.Equal(t, StatusResolved, reread.Status, "the status change must persist")
}

func TestUpdateStatusLeavesUserAuthoredFieldsIntact(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	userID := seedUser(t, db)
	feedbackID := seedFeedback(t, db, userID, KindBug, StatusOpen, "do not touch my words", time.Now())

	updated, err := repo.UpdateStatus(context.Background(), feedbackID, StatusInProgress)
	require.NoError(t, err)
	require.Equal(t, StatusInProgress, updated.Status, "status must actually change")

	require.Equal(t, "do not touch my words", updated.Subject)
	require.Equal(t, "desc: do not touch my words", updated.Description)
	require.Equal(t, KindBug, updated.Kind)
}

func TestUpdateStatusUnknownIDReturnsErrNotFound(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)

	_, err := repo.UpdateStatus(context.Background(), uuid.New(), StatusResolved)
	require.Error(t, err)
	require.True(t, errors.Is(err, ErrNotFound))
}

// TestClampLimitBounds is the load-bearing pin for the limit clamp: it tests
// clampLimit directly, with no database, so an over-max request seeding an
// empty (or ambient) table can never make this pass vacuously the way
// TestAdminList_OversizedLimitClampsNotErrors does. It specifically catches
// clampLimit's over-max branch returning DefaultLimit instead of MaxLimit —
// the distinction this handler's callers depend on: the portal computes
// offset = page * the limit IT ASKED FOR, so silently falling back to a
// smaller page would make the next offset skip rows that Total truthfully
// says exist. Mirrors admin/repository_test.go's TestClampLimitBounds.
func TestClampLimitBounds(t *testing.T) {
	require.Equal(t, DefaultLimit, clampLimit(0), "unset (zero) must fall back to DefaultLimit")
	require.Equal(t, DefaultLimit, clampLimit(-5), "negative must fall back to DefaultLimit, same as unset")
	require.Equal(t, 10, clampLimit(10), "an in-range limit must be honoured exactly")
	require.Equal(t, MaxLimit, clampLimit(MaxLimit), "exactly MaxLimit must pass through unclamped")
	require.Equal(t, MaxLimit, clampLimit(MaxLimit+1), "one over MaxLimit must clamp to MaxLimit, not fall back to DefaultLimit")
	require.Equal(t, MaxLimit, clampLimit(MaxLimit+800), "far over MaxLimit must still clamp to MaxLimit")
}
