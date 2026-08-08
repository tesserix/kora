package user

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// --- fakes -----------------------------------------------------------------

// fakeIdentityDeleter stands in for auth.IdentityDeleter so the deletion tests
// never touch Firebase. It records the uid it was handed, which is the only
// way to prove Delete read the FirebaseUID off the row BEFORE deleting it.
type fakeIdentityDeleter struct {
	uid   string
	calls int
	err   error
}

func (f *fakeIdentityDeleter) DeleteIdentity(_ context.Context, firebaseUID string) error {
	f.calls++
	f.uid = firebaseUID
	return f.err
}

// fakeCacheEvicter stands in for ai.Cache. internal/user CANNOT import
// internal/ai -- ai imports internal/nutrition, which imports internal/user --
// which is exactly why Service depends on the consumer-declared CacheEvicter
// interface rather than ai.Cache. ai.Cache and ai.NoCache both satisfy it
// structurally at the wiring site.
type fakeCacheEvicter struct {
	userID uuid.UUID
	calls  int
	err    error
}

func (f *fakeCacheEvicter) DeleteByUser(_ context.Context, userID uuid.UUID) error {
	f.calls++
	f.userID = userID
	return f.err
}

// fakeAppleRevoker stands in for the appleid client. The method name matches
// appleid.Client.RevokeRefreshToken exactly so the real client satisfies the
// consumer-declared AppleRevoker interface without an adapter.
type fakeAppleRevoker struct {
	token string
	calls int
	err   error
}

func (f *fakeAppleRevoker) RevokeRefreshToken(_ context.Context, refreshToken string) error {
	f.calls++
	f.token = refreshToken
	return f.err
}

// testAuditRecorder writes the same kora_admin_events row that
// admin.RecordEvent writes, using raw SQL.
//
// It cannot call admin.RecordEvent: this file is in package user, and
// internal/user cannot import internal/admin (admin -> ai -> nutrition ->
// user). The action/target_type literals below MUST stay in step with
// admin.ActionUserDeleted / admin.TargetTypeUser; the wiring task passes the
// real closure, and its test is what pins those constants end-to-end.
func testAuditRecorder(tx *gorm.DB, actorID, actorEmail string, targetID uuid.UUID) error {
	return tx.Exec(`
		INSERT INTO kora_admin_events (actor_id, actor_email, action, target_type, target_id)
		VALUES (?, ?, 'user.deleted', 'user', ?)`, actorID, actorEmail, targetID).Error
}

// newTestService wires a Service whose every external dependency succeeds, so
// a failing assertion points at the deletion logic and nothing else.
func newTestService(t *testing.T, db *gorm.DB) Service {
	t.Helper()
	return NewService(db, &fakeCacheEvicter{}, &fakeIdentityDeleter{}, &fakeAppleRevoker{}, testAuditRecorder)
}

// newTestServiceWithFailingFirebase wires a Service whose Firebase identity
// delete always fails, which is the one third-party failure that must be
// REPORTED in the result rather than failing the deletion.
func newTestServiceWithFailingFirebase(t *testing.T, db *gorm.DB) Service {
	t.Helper()
	return NewService(db, &fakeCacheEvicter{},
		&fakeIdentityDeleter{err: errors.New("firebase is down")}, &fakeAppleRevoker{},
		testAuditRecorder)
}

// --- seed helpers ----------------------------------------------------------
//
// All of these use raw SQL rather than importing the owning packages:
// internal/nutrition, internal/social and friends already import (or may
// import) internal/user, and these tests live in package user, so importing
// back would create a cycle. Same constraint that forced seedGroup's raw
// INSERT in ownership_test.go.

// seedFoodLog inserts one food log for userID. food_logs.user_id ->
// users(id) ON DELETE CASCADE removes it when the user goes, so cleanup rides
// on seedUser's.
func seedFoodLog(t *testing.T, db *gorm.DB, userID uuid.UUID) {
	t.Helper()
	require.NoError(t, db.Exec(`
		INSERT INTO food_logs (user_id, logged_at, meal_slot, source, description,
			quantity_grams, kcal, protein_g, carbs_g, fat_g, fiber_g, provenance)
		VALUES (?, now(), 'lunch', 'manual', 'test log', 100, 200, 10, 20, 5, 2, 'test')`,
		userID).Error)
}

// seedWeightEntry inserts one weight entry for userID; cascades with the user.
func seedWeightEntry(t *testing.T, db *gorm.DB, userID uuid.UUID) {
	t.Helper()
	require.NoError(t, db.Exec(
		`INSERT INTO weight_entries (user_id, logged_at, weight_kg) VALUES (?, now(), 80)`,
		userID).Error)
}

// seedFriendship inserts a friendship with the victim as REQUESTER and the
// survivor as ADDRESSEE. friendships references users twice, so a test that
// only ever seeds the deleted user on one side never exercises the other FK.
func seedFriendship(t *testing.T, db *gorm.DB, requesterID, addresseeID uuid.UUID) {
	t.Helper()
	require.NoError(t, db.Exec(
		`INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, 'accepted')`,
		requesterID, addresseeID).Error)
}

// seedNotification inserts a notification OWNED by userID and CAUSED by
// actorID. Same double-reference reason as seedFriendship: the brief's cascade
// test seeds the survivor as the owner and the victim as the actor, so
// deleting the victim must remove the row via notifications.actor_id.
func seedNotification(t *testing.T, db *gorm.DB, userID, actorID uuid.UUID) {
	t.Helper()
	require.NoError(t, db.Exec(
		`INSERT INTO notifications (user_id, type, actor_id) VALUES (?, 'friend_request', ?)`,
		userID, actorID).Error)
}

// seedAIUsageEvent inserts one usage event for userID and returns its id.
//
// ai_usage_events is the one table that must SURVIVE the deletion (migration
// 000025 made user_id nullable with ON DELETE SET NULL), so it is NOT removed
// by seedUser's cascade and needs its own cleanup.
func seedAIUsageEvent(t *testing.T, db *gorm.DB, userID uuid.UUID) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(`
		INSERT INTO ai_usage_events (id, user_id, provider, model, call_type)
		VALUES (?, ?, 'test', 'test-model', 'resolve')`, id, userID).Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM ai_usage_events WHERE id = ?`, id) })
	return id
}

// cleanupAdminEvents removes audit rows for targetID. kora_admin_events
// deliberately OUTLIVES the user it describes, so nothing else deletes them.
func cleanupAdminEvents(t *testing.T, db *gorm.DB, targetID uuid.UUID) {
	t.Helper()
	t.Cleanup(func() { db.Exec(`DELETE FROM kora_admin_events WHERE target_id = ?`, targetID) })
}

// --- tests -----------------------------------------------------------------

func TestDeleteRemovesVictimAndLeavesSurvivorIntact(t *testing.T) {
	db := testDB(t)
	svc := newTestService(t, db)
	victim, survivor := seedUser(t, db), seedUser(t, db)

	seedFoodLog(t, db, victim.ID)
	seedFoodLog(t, db, survivor.ID)
	seedWeightEntry(t, db, victim.ID)
	seedWeightEntry(t, db, survivor.ID)
	// friendships and notifications reference users TWICE. Seed the survivor
	// as the OTHER party, which a naive test never exercises.
	seedFriendship(t, db, victim.ID, survivor.ID)   // requester=victim, addressee=survivor
	seedNotification(t, db, survivor.ID, victim.ID) // user=survivor, actor=victim

	res, err := svc.Delete(context.Background(), victim.ID, DeleteActor{IsAdmin: false})
	require.NoError(t, err)
	_ = res

	// Victim is gone, everywhere.
	for _, table := range []string{"food_logs", "weight_entries", "water_entries",
		"device_tokens", "pins", "saved_meals", "food_aliases", "coach_turns",
		"group_members", "challenge_participants", "feedback"} {
		var n int64
		require.NoError(t, db.Raw(
			`SELECT count(*) FROM `+table+` WHERE user_id = ?`, victim.ID).Scan(&n).Error)
		assert.Zero(t, n, "%s must be empty for the deleted user", table)
	}
	var users int64
	require.NoError(t, db.Raw(`SELECT count(*) FROM users WHERE id = ?`, victim.ID).Scan(&users).Error)
	assert.Zero(t, users)

	// The doubly-referencing tables go via the OTHER column.
	var friendships, notifications int64
	require.NoError(t, db.Raw(
		`SELECT count(*) FROM friendships WHERE requester_id = ? OR addressee_id = ?`,
		victim.ID, victim.ID).Scan(&friendships).Error)
	assert.Zero(t, friendships, "friendships on either side of the deleted user must be gone")
	require.NoError(t, db.Raw(
		`SELECT count(*) FROM notifications WHERE user_id = ? OR actor_id = ?`,
		victim.ID, victim.ID).Scan(&notifications).Error)
	assert.Zero(t, notifications, "notifications naming the deleted user as actor must be gone")

	// SURVIVOR IS UNTOUCHED — this is the assertion that catches a missing WHERE.
	for _, table := range []string{"food_logs", "weight_entries"} {
		var n int64
		require.NoError(t, db.Raw(
			`SELECT count(*) FROM `+table+` WHERE user_id = ?`, survivor.ID).Scan(&n).Error)
		assert.NotZero(t, n, "%s for the survivor must NOT be deleted", table)
	}
	var survivorRow int64
	require.NoError(t, db.Raw(`SELECT count(*) FROM users WHERE id = ?`, survivor.ID).Scan(&survivorRow).Error)
	assert.Equal(t, int64(1), survivorRow, "the survivor's account must still exist")
}

func TestDeleteRetainsAIUsageEventsAnonymised(t *testing.T) {
	db := testDB(t)
	svc := newTestService(t, db)
	victim := seedUser(t, db)
	eventID := seedAIUsageEvent(t, db, victim.ID)

	_, err := svc.Delete(context.Background(), victim.ID, DeleteActor{})
	require.NoError(t, err)

	// Scoped to the seeded row's id: a global count would pass on leftovers
	// from any other test in the shared database.
	var total, orphaned int64
	require.NoError(t, db.Raw(
		`SELECT count(*) FROM ai_usage_events WHERE id = ?`, eventID).Scan(&total).Error)
	require.NoError(t, db.Raw(
		`SELECT count(*) FROM ai_usage_events WHERE id = ? AND user_id IS NULL`,
		eventID).Scan(&orphaned).Error)
	assert.NotZero(t, total, "ai_usage_events are RETAINED, not cascaded")
	assert.NotZero(t, orphaned, "and anonymised to NULL")
}

func TestDeleteWritesAuditRowForAdminOnly(t *testing.T) {
	db := testDB(t)
	svc := newTestService(t, db)

	byAdmin := seedUser(t, db)
	cleanupAdminEvents(t, db, byAdmin.ID)
	_, err := svc.Delete(context.Background(), byAdmin.ID,
		DeleteActor{IsAdmin: true, ID: "admin-1", Email: "a@b.com"})
	require.NoError(t, err)
	var n int64
	require.NoError(t, db.Raw(
		`SELECT count(*) FROM kora_admin_events WHERE target_id = ?`, byAdmin.ID).Scan(&n).Error)
	assert.Equal(t, int64(1), n, "admin deletion is audited AND the row outlives the user")

	bySelf := seedUser(t, db)
	cleanupAdminEvents(t, db, bySelf.ID)
	_, err = svc.Delete(context.Background(), bySelf.ID, DeleteActor{IsAdmin: false})
	require.NoError(t, err)
	require.NoError(t, db.Raw(
		`SELECT count(*) FROM kora_admin_events WHERE target_id = ?`, bySelf.ID).Scan(&n).Error)
	assert.Zero(t, n, "self-deletion is not an admin action")
}

func TestDeleteReportsFirebaseFailureWithoutFailing(t *testing.T) {
	db := testDB(t)
	svc := newTestServiceWithFailingFirebase(t, db)
	victim := seedUser(t, db)
	cleanupAdminEvents(t, db, victim.ID)

	res, err := svc.Delete(context.Background(), victim.ID, DeleteActor{IsAdmin: true, ID: "a", Email: "a@b.com"})
	require.NoError(t, err, "a Firebase failure must NOT fail the deletion")
	assert.False(t, res.FirebaseIdentityRemoved, "but it must be reported, not swallowed")

	var n int64
	require.NoError(t, db.Raw(`SELECT count(*) FROM users WHERE id = ?`, victim.ID).Scan(&n).Error)
	assert.Zero(t, n, "the row is still gone")
}

func TestDeleteUnknownUserIsNotFound(t *testing.T) {
	db := testDB(t)
	svc := newTestService(t, db)
	_, err := svc.Delete(context.Background(), uuid.New(), DeleteActor{})
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestDeleteRevokesAppleTokenBeforeTheRowIsGone(t *testing.T) {
	db := testDB(t)
	victim := seedUser(t, db)
	require.NoError(t, db.Exec(
		`UPDATE users SET apple_refresh_token = ? WHERE id = ?`, "rt-abc", victim.ID).Error)

	revoker := &fakeAppleRevoker{}
	ids := &fakeIdentityDeleter{}
	svc := NewService(db, &fakeCacheEvicter{}, ids, revoker, testAuditRecorder)

	res, err := svc.Delete(context.Background(), victim.ID, DeleteActor{})
	require.NoError(t, err)

	assert.Equal(t, 1, revoker.calls, "the token lives on the users row, so revoke runs before the DELETE")
	assert.Equal(t, "rt-abc", revoker.token)
	assert.True(t, res.AppleTokenRevoked)
	assert.True(t, res.FirebaseIdentityRemoved)
	assert.Equal(t, victim.FirebaseUID, ids.uid, "the uid must be read off the row before it is deleted")
}

func TestDeleteReportsAppleRevokeFailureWithoutFailing(t *testing.T) {
	db := testDB(t)
	victim := seedUser(t, db)
	require.NoError(t, db.Exec(
		`UPDATE users SET apple_refresh_token = ? WHERE id = ?`, "rt-bad", victim.ID).Error)

	svc := NewService(db, &fakeCacheEvicter{}, &fakeIdentityDeleter{},
		&fakeAppleRevoker{err: errors.New("apple is down")}, testAuditRecorder)

	res, err := svc.Delete(context.Background(), victim.ID, DeleteActor{})
	require.NoError(t, err, "Apple requires deletion completes in-app; an outage must not block it")
	assert.False(t, res.AppleTokenRevoked, "but the failure is reported, not swallowed")

	var n int64
	require.NoError(t, db.Raw(`SELECT count(*) FROM users WHERE id = ?`, victim.ID).Scan(&n).Error)
	assert.Zero(t, n)
}

// TestDeleteToleratesNilAppleRevoker pins the deployment reality that Apple
// may not be configured at all: router.go nil-checks deps.AppleExchanger for
// exactly this reason, so Delete must skip revocation rather than nil-panic.
func TestDeleteToleratesNilAppleRevoker(t *testing.T) {
	db := testDB(t)
	victim := seedUser(t, db)
	require.NoError(t, db.Exec(
		`UPDATE users SET apple_refresh_token = ? WHERE id = ?`, "rt-orphan", victim.ID).Error)

	svc := NewService(db, &fakeCacheEvicter{}, &fakeIdentityDeleter{}, nil, testAuditRecorder)

	res, err := svc.Delete(context.Background(), victim.ID, DeleteActor{})
	require.NoError(t, err)
	assert.False(t, res.AppleTokenRevoked, "no revoker configured means nothing was revoked")

	var n int64
	require.NoError(t, db.Raw(`SELECT count(*) FROM users WHERE id = ?`, victim.ID).Scan(&n).Error)
	assert.Zero(t, n, "an unconfigured Apple client must not block deletion")
}

func TestDeleteTransfersGroupOwnershipBeforeTheCascade(t *testing.T) {
	db := testDB(t)
	svc := newTestService(t, db)
	owner, heir := seedUser(t, db), seedUser(t, db)
	g := seedGroup(t, db, owner.ID)
	seedMember(t, db, g.ID, heir.ID, time.Now().Add(-time.Hour))

	res, err := svc.Delete(context.Background(), owner.ID, DeleteActor{})
	require.NoError(t, err)
	require.Len(t, res.Transfers, 1, "the transfer must be reported to the caller")
	assert.Equal(t, heir.ID, res.Transfers[0].NewOwnerID)

	var got uuid.UUID
	require.NoError(t, db.Raw(`SELECT owner_id FROM groups WHERE id = ?`, g.ID).Row().Scan(&got))
	assert.Equal(t, heir.ID, got, "the group survived the cascade because ownership moved first")
}
