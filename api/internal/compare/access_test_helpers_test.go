package compare

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/access"
)

// These helpers exist so tests in this package can obtain a REAL
// access.Grant -- through access.Service backed by a real access.Repository
// -- instead of a zero-value access.Grant{}. Under the design's own rule
// (see access.Grant's doc comment) a zero-value Grant carries uuid.Nil as its
// owner, so once ProgressForMembers queries by grant.Owner() (kora#326
// whole-branch review, F3) a test built on Grant{} would silently exercise
// uuid.Nil rather than the real owner and could not catch a regression back
// to querying by the caller-supplied member ID.

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

func seedUser(t *testing.T, db *gorm.DB, name string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		`INSERT INTO users (id, firebase_uid, email, display_name) VALUES (?, ?, ?, ?)`,
		id, "compare-"+id.String(), id.String()+"@example.test", name).Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM users WHERE id = ?`, id) })
	return id
}

// seedGrant creates a circle owned by owner, containing viewer, granting
// category -- then resolves it through the real access.Service so callers get
// a genuine access.Grant rather than a zero-value one.
func seedGrant(t *testing.T, db *gorm.DB, viewer, owner uuid.UUID, category access.Category) access.Grant {
	t.Helper()
	circleID := uuid.New()
	require.NoError(t, db.Exec(
		`INSERT INTO share_circles (id, owner_id, name) VALUES (?, ?, ?)`, circleID, owner, "circle-"+circleID.String()).Error)
	require.NoError(t, db.Exec(
		`INSERT INTO share_circle_members (circle_id, member_user_id) VALUES (?, ?)`, circleID, viewer).Error)
	require.NoError(t, db.Exec(
		`INSERT INTO share_grants (circle_id, category) VALUES (?, ?)`, circleID, string(category)).Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM share_circles WHERE id = ?`, circleID) })

	svc := access.NewService(access.NewRepository(db))
	g, err := svc.Resolve(context.Background(), viewer, owner, category)
	require.NoError(t, err)
	return g
}
