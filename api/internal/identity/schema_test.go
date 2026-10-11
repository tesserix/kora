package identity

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/user"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

func seedUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		`INSERT INTO users (id, firebase_uid, email, display_name) VALUES (?, ?, ?, ?)`,
		id, "identity-"+id.String(), id.String()+"@example.test", "Test Person").Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM users WHERE id = ?`, id) })
	return id
}

// The unique index is PARTIAL. Without the WHERE clause, the second user to
// have no handle at all collides with the first on NULL, which would break
// every existing account the moment this migration lands.
//
// This test seeds with raw SQL, which leaves handle_canonical as a true SQL
// NULL -- it only covers the NULL path. The real signup path never writes
// NULL; see TestSchema_TwoRealSignupsCoexist below for the path that
// actually broke production.
func TestSchema_TwoUsersMayBothHaveNoHandle(t *testing.T) {
	db := testDB(t)
	seedUser(t, db)
	seedUser(t, db)
}

// Two REAL signups must coexist. Every other schema test here seeds with raw
// SQL, which leaves a true NULL -- but UpsertByFirebaseUID goes through GORM
// Create, which writes the empty string for untouched string fields (see the
// AppleRefreshToken comment in user/model.go). The empty string IS NOT NULL, so
// an index predicate that only excludes NULL rejects the second signup and
// takes down account creation.
//
// Spelled out in words rather than as a doubled-quote SQL literal on purpose:
// gofmt reformats doc comments, and it rewrites a doubled ASCII quote into a
// typographic close-quote -- which would turn the one detail this comment
// exists to convey into a smart quote.
func TestSchema_TwoRealSignupsCoexist(t *testing.T) {
	db := testDB(t)
	repo := user.NewRepository(db)
	ctx := context.Background()

	a, err := repo.UpsertByFirebaseUID(ctx, "sig-"+uuid.NewString(), "a@example.test")
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec(`DELETE FROM users WHERE id = ?`, a.ID) })

	b, err := repo.UpsertByFirebaseUID(ctx, "sig-"+uuid.NewString(), "b@example.test")
	require.NoError(t, err, "the second signup is the one that breaks")
	t.Cleanup(func() { db.Exec(`DELETE FROM users WHERE id = ?`, b.ID) })
}

func TestSchema_CanonicalHandleIsUnique(t *testing.T) {
	db := testDB(t)
	a, b := seedUser(t, db), seedUser(t, db)
	require.NoError(t, db.Exec(
		`UPDATE users SET handle = 'ada', handle_canonical = 'ada' WHERE id = ?`, a).Error)
	err := db.Exec(
		`UPDATE users SET handle = 'ada', handle_canonical = 'ada' WHERE id = ?`, b).Error
	require.Error(t, err, "a second user must not be able to take the same canonical handle")
}

// Two DIFFERENT display handles that fold to the same canonical form must
// still collide. This is the property the whole confusable decision rests on.
func TestSchema_ConfusableHandlesCollideOnCanonical(t *testing.T) {
	db := testDB(t)
	a, b := seedUser(t, db), seedUser(t, db)
	require.NoError(t, db.Exec(
		`UPDATE users SET handle = 'ada_l', handle_canonical = 'ada_1' WHERE id = ?`, a).Error)
	err := db.Exec(
		`UPDATE users SET handle = 'ada_1', handle_canonical = 'ada_1' WHERE id = ?`, b).Error
	require.Error(t, err)
}

func TestSchema_RetiredHandlesTableExists(t *testing.T) {
	db := testDB(t)
	h := "retired_" + uuid.NewString()[:8]
	require.NoError(t, db.Exec(
		`INSERT INTO retired_handles (handle_canonical) VALUES (?)`, h).Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = ?`, h) })

	// Row().Scan(), not gorm's Scan(): gorm's Scan panics on a nil *any
	// destination (schema.Parse calls reflect.Value.Type on the zero Value of
	// an untyped nil interface) on the pinned gorm v1.31.2. Row().Scan() goes
	// through database/sql directly, which handles *interface{} correctly.
	var retiredAt any
	require.NoError(t, db.Raw(
		`SELECT retired_at FROM retired_handles WHERE handle_canonical = ?`, h).Row().Scan(&retiredAt))
	require.NotNil(t, retiredAt, "retired_at must default to now(), not NULL")
}

// Retirement must OUTLIVE the account. If the row vanished with the user, a
// deleted account would hand its handle to whoever claims it next — which is
// exactly the impersonation retirement exists to prevent, with a body-metrics
// payoff. So retired_handles carries no foreign key to users.
func TestSchema_RetirementSurvivesAccountDeletion(t *testing.T) {
	db := testDB(t)
	id := seedUser(t, db)
	h := "gone_" + uuid.NewString()[:8]
	require.NoError(t, db.Exec(
		`UPDATE users SET handle = ?, handle_canonical = ? WHERE id = ?`, h, h, id).Error)
	require.NoError(t, db.Exec(
		`INSERT INTO retired_handles (handle_canonical) VALUES (?)`, h).Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = ?`, h) })

	require.NoError(t, db.Exec(`DELETE FROM users WHERE id = ?`, id).Error)

	var n int64
	require.NoError(t, db.Raw(
		`SELECT count(*) FROM retired_handles WHERE handle_canonical = ?`, h).Scan(&n).Error)
	require.EqualValues(t, 1, n)
}
