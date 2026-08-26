package platformadmin

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

	"github.com/tesserix/kora/api/internal/admin"
	"github.com/tesserix/kora/api/internal/feedback"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	require.NoError(t, err)
	return db
}

// tx opens a transaction and registers its rollback immediately, so it runs
// on Goexit too (a require failure). Every assertion below is made against
// THIS transaction, so the shared test database's ambient rows can neither
// satisfy nor defeat one.
func tx(t *testing.T, db *gorm.DB) *gorm.DB {
	t.Helper()
	tx := db.Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	return tx
}

func repoOn(tx *gorm.DB) Repository { return Repository{db: tx} }

// seedUser inserts a user directly. firebase_uid is UNIQUE NOT NULL and has
// no default, so it must be unique per row rather than left out.
func seedUser(t *testing.T, tx *gorm.DB, email, name, handle string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, tx.Exec(
		`INSERT INTO users (id, firebase_uid, email, display_name, handle, handle_canonical, created_at)
		 VALUES (?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), now())`,
		id, "fb_"+id.String(), email, name, handle, handle).Error)
	return id
}

func seedFood(t *testing.T, tx *gorm.DB, name, brand string, deleted bool) uuid.UUID {
	t.Helper()
	id := uuid.New()
	var deletedAt any
	if deleted {
		deletedAt = time.Now()
	}
	require.NoError(t, tx.Exec(
		`INSERT INTO food_items
		   (id, name, brand, provenance, kcal_per_100g, protein_per_100g,
		    carbs_per_100g, fat_per_100g, deleted_at)
		 VALUES (?, ?, ?, 'curated', 100, 1, 1, 1, ?)`,
		id, name, brand, deletedAt).Error)
	return id
}

func seedFeedback(t *testing.T, tx *gorm.DB, kind feedback.Kind, status feedback.Status, subject string, createdAt time.Time) uuid.UUID {
	t.Helper()
	userID := seedUser(t, tx, "fb-"+uuid.NewString()+"@kora.test", "Tester", "")
	id := uuid.New()
	require.NoError(t, tx.Exec(
		`INSERT INTO feedback (id, user_id, kind, subject, description, status, created_at)
		 VALUES (?, ?, ?, ?, 'body', ?, ?)`,
		id, userID, kind, subject, status, createdAt).Error)
	return id
}

// seedAuditEvent writes one row, with actor_id derived from the caller's
// actorEmail rather than a shared literal.
//
// The shared test database carries ambient kora_admin_events rows from other
// suites and from earlier runs, so every assertion below scopes to an actor
// unique to its own test. A fixed literal here passes today and fails the
// week somebody else seeds the same one — which is exactly how two suites in
// this repo were misdiagnosed as "pre-existing failures".
func seedAuditEvent(t *testing.T, tx *gorm.DB, action, actorEmail, targetType string, createdAt time.Time) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, tx.Exec(
		`INSERT INTO kora_admin_events
		   (id, actor_id, actor_email, action, target_type, target_id, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, "op_"+actorEmail, actorEmail, action, targetType, uuid.New(), createdAt).Error)
	return id
}

// uniqueActor returns an actor email no other test or ambient row can share.
func uniqueActor(prefix string) string { return prefix + "-" + uuid.NewString() + "@kora.test" }

// ---------- audit-logs ----------

func TestListAuditFiltersAndPages(t *testing.T) {
	tx := tx(t, testDB(t))
	repo := repoOn(tx)
	now := time.Now().UTC()

	wantedActor, otherActor := uniqueActor("wanted"), uniqueActor("other")
	wanted := seedAuditEvent(t, tx, admin.ActionFoodDeleted, wantedActor, admin.TargetTypeFood, now.Add(-time.Hour))
	// Same actor, different action; and same action, different actor. Either
	// filter alone would let one of these through.
	seedAuditEvent(t, tx, admin.ActionFoodCreated, wantedActor, admin.TargetTypeFood, now.Add(-time.Hour))
	seedAuditEvent(t, tx, admin.ActionFoodDeleted, otherActor, admin.TargetTypeFood, now.Add(-time.Hour))

	got, err := repo.ListAudit(context.Background(), AuditFilter{
		Query:  Query{Limit: 10, Page: 1},
		Action: admin.ActionFoodDeleted,
		Actor:  wantedActor,
	})
	require.NoError(t, err)

	require.Len(t, got.Entries, 1)
	assert.Equal(t, wanted, got.Entries[0].ID)
	assert.Equal(t, int64(1), got.Total, "total is the filtered count, not the table count")
}

// TestListAuditActorMatchesEitherAttributionColumn — an operator with an
// email should not have to know whether the row recorded them by id.
func TestListAuditActorMatchesEitherAttributionColumn(t *testing.T) {
	tx := tx(t, testDB(t))
	repo := repoOn(tx)
	actor := uniqueActor("both")
	seedAuditEvent(t, tx, admin.ActionFoodCreated, actor, admin.TargetTypeFood, time.Now())

	byEmail, err := repo.ListAudit(context.Background(), AuditFilter{
		Query: Query{Limit: 10, Page: 1}, Actor: actor})
	require.NoError(t, err)
	assert.Len(t, byEmail.Entries, 1)

	byID, err := repo.ListAudit(context.Background(), AuditFilter{
		Query: Query{Limit: 10, Page: 1}, Actor: "op_" + actor})
	require.NoError(t, err)
	assert.Len(t, byID.Entries, 1)
}

// TestListAuditHonoursTheTimeWindow — the fan-out's since_hours must actually
// bound the query, not merely be parsed.
func TestListAuditHonoursTheTimeWindow(t *testing.T) {
	tx := tx(t, testDB(t))
	repo := repoOn(tx)
	now := time.Now().UTC()

	// Scoped to an actor unique to this test. The shared test database
	// carries ambient rows from other suites, and an unscoped assertion here
	// passes or fails on whatever else has run today.
	actor := uniqueActor("window")
	recent := seedAuditEvent(t, tx, admin.ActionFoodCreated, actor, admin.TargetTypeFood, now.Add(-time.Hour))
	seedAuditEvent(t, tx, admin.ActionFoodCreated, actor, admin.TargetTypeFood, now.Add(-72*time.Hour))

	got, err := repo.ListAudit(context.Background(), AuditFilter{
		Query: Query{Limit: 10, Page: 1, From: now.Add(-24 * time.Hour)}, Actor: actor})
	require.NoError(t, err)

	require.Len(t, got.Entries, 1)
	assert.Equal(t, recent, got.Entries[0].ID)
	assert.Equal(t, int64(1), got.Total)
}

func TestListAuditIsNewestFirst(t *testing.T) {
	tx := tx(t, testDB(t))
	repo := repoOn(tx)
	now := time.Now().UTC()

	actor := uniqueActor("order")
	seedAuditEvent(t, tx, admin.ActionFoodCreated, actor, admin.TargetTypeFood, now.Add(-2*time.Hour))
	newest := seedAuditEvent(t, tx, admin.ActionFoodCreated, actor, admin.TargetTypeFood, now.Add(-time.Minute))

	got, err := repo.ListAudit(context.Background(), AuditFilter{
		Query: Query{Limit: 10, Page: 1}, Actor: actor})
	require.NoError(t, err)
	require.NotEmpty(t, got.Entries)
	assert.Equal(t, newest, got.Entries[0].ID)
}

func TestListAuditPagesWithoutChangingTheTotal(t *testing.T) {
	tx := tx(t, testDB(t))
	repo := repoOn(tx)
	now := time.Now().UTC()

	actor := uniqueActor("page")
	for range 3 {
		seedAuditEvent(t, tx, admin.ActionFoodCreated, actor, admin.TargetTypeFood, now)
	}

	first, err := repo.ListAudit(context.Background(), AuditFilter{
		Query: Query{Limit: 2, Page: 1}, Actor: actor})
	require.NoError(t, err)
	second, err := repo.ListAudit(context.Background(), AuditFilter{
		Query: Query{Limit: 2, Page: 2}, Actor: actor})
	require.NoError(t, err)

	assert.Len(t, first.Entries, 2)
	assert.Len(t, second.Entries, 1)
	assert.Equal(t, int64(3), first.Total)
	assert.Equal(t, int64(3), second.Total, "total is the unpaged count on every page")
}

// ---------- inbox ----------

func TestListInboxReturnsOnlyOpenWork(t *testing.T) {
	tx := tx(t, testDB(t))
	repo := repoOn(tx)
	now := time.Now().UTC()

	open := seedFeedback(t, tx, feedback.KindBug, feedback.StatusOpen, "open one", now)
	inProgress := seedFeedback(t, tx, feedback.KindBug, feedback.StatusInProgress, "in progress", now)
	seedFeedback(t, tx, feedback.KindBug, feedback.StatusResolved, "resolved", now)
	seedFeedback(t, tx, feedback.KindFeature, feedback.StatusClosed, "closed", now)

	got, err := repo.ListInbox(context.Background(), 500, 0)
	require.NoError(t, err)

	ids := make([]uuid.UUID, 0, len(got.Items))
	for _, f := range got.Items {
		ids = append(ids, f.ID)
	}
	// Subset assertions, not equality: the shared test database carries
	// ambient feedback rows this transaction did not write.
	assert.Contains(t, ids, open)
	assert.Contains(t, ids, inProgress)
	for _, f := range got.Items {
		assert.Contains(t, openFeedbackStatuses, f.Status,
			"a terminal status reached the inbox")
	}
}

// TestListInboxIsOldestFirst — an inbox exists to surface what has been
// waiting longest; newest-first hides it behind a page boundary.
func TestListInboxIsOldestFirst(t *testing.T) {
	tx := tx(t, testDB(t))
	repo := repoOn(tx)
	now := time.Now().UTC()

	// Dated before any ambient row could plausibly be, so "first" is a claim
	// about the ORDER BY rather than about what else is in the table.
	oldest := seedFeedback(t, tx, feedback.KindBug, feedback.StatusOpen, "oldest", now.Add(-100*365*24*time.Hour))
	seedFeedback(t, tx, feedback.KindBug, feedback.StatusOpen, "newest", now)

	got, err := repo.ListInbox(context.Background(), 500, 0)
	require.NoError(t, err)
	require.NotEmpty(t, got.Items)
	assert.Equal(t, oldest, got.Items[0].ID)
}

// ---------- entities ----------

func TestSearchEntitiesFindsAUserByEveryHumanField(t *testing.T) {
	tx := tx(t, testDB(t))
	repo := repoOn(tx)

	id := seedUser(t, tx, "zephyrine@kora.test", "Zephyrine Quux", "zephquux")

	for name, q := range map[string]string{
		"display name": "zephyrine q",
		"email":        "zephyrine@kora",
		"handle":       "zephquux",
		"mixed case":   "ZEPHYRINE",
	} {
		t.Run(name, func(t *testing.T) {
			got, err := repo.SearchEntities(context.Background(), TypeUsers, q, 10, 0)
			require.NoError(t, err)
			require.Len(t, got.Items, 1)
			assert.Equal(t, id.String(), got.Items[0].ID)
			assert.Equal(t, TypeUsers, got.Items[0].Type)
		})
	}
}

func TestSearchEntitiesFindsAFoodByNameOrBrand(t *testing.T) {
	tx := tx(t, testDB(t))
	repo := repoOn(tx)

	id := seedFood(t, tx, "Quuxberry Yoghurt", "Zephbrand", false)

	for _, q := range []string{"quuxberry", "zephbrand"} {
		got, err := repo.SearchEntities(context.Background(), TypeFoods, q, 10, 0)
		require.NoError(t, err)
		require.Len(t, got.Items, 1, "q=%s", q)
		assert.Equal(t, id.String(), got.Items[0].ID)
	}
}

// TestSearchEntitiesExcludesRetiredFoods — a retired food is not findable in
// the app either; surfacing it invites an operator to act on something users
// cannot see.
func TestSearchEntitiesExcludesRetiredFoods(t *testing.T) {
	tx := tx(t, testDB(t))
	repo := repoOn(tx)

	live := seedFood(t, tx, "Quuxberry Live", "Zephbrand", false)
	seedFood(t, tx, "Quuxberry Retired", "Zephbrand", true)

	got, err := repo.SearchEntities(context.Background(), TypeFoods, "quuxberry", 10, 0)
	require.NoError(t, err)

	require.Len(t, got.Items, 1)
	assert.Equal(t, live.String(), got.Items[0].ID)
	assert.Equal(t, int64(1), got.Total, "the total must exclude them too, not just the page")
}

func TestSearchEntitiesReturnsAnEmptyPageNotAnError(t *testing.T) {
	tx := tx(t, testDB(t))
	repo := repoOn(tx)

	got, err := repo.SearchEntities(context.Background(), TypeUsers, "no-such-person-anywhere", 10, 0)
	require.NoError(t, err)
	assert.Empty(t, got.Items)
	assert.Equal(t, int64(0), got.Total)
}

func TestSearchEntitiesRejectsAnUnknownType(t *testing.T) {
	tx := tx(t, testDB(t))
	_, err := repoOn(tx).SearchEntities(context.Background(), "orders", "x", 10, 0)
	assert.ErrorIs(t, err, ErrUnknownEntityType)
}
