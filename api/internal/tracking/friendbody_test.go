package tracking

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/access"
)

// seedGrant creates a circle owned by owner, containing viewer, granting
// category -- then resolves it through the REAL access.Service so callers get
// a genuine access.Grant rather than a zero-value one.
//
// A zero-value access.Grant{} carries uuid.Nil as its owner (the fields are
// unexported and unreachable from here, which is the design). A test built on
// Grant{} would therefore query uuid.Nil rather than the real owner, and
// could not tell "queries by grant.Owner()" apart from "queries by whatever
// UUID the caller passed in" -- which is precisely the regression this file
// exists to prevent. Mirrors compare/access_test_helpers_test.go for the same
// reason.
func seedGrant(t *testing.T, db *gorm.DB, viewer, owner uuid.UUID, category access.Category) access.Grant {
	t.Helper()
	circleID := uuid.New()
	require.NoError(t, db.Exec(
		`INSERT INTO share_circles (id, owner_id, name) VALUES (?, ?, ?)`,
		circleID, owner, "circle-"+circleID.String()).Error)
	require.NoError(t, db.Exec(
		`INSERT INTO share_circle_members (circle_id, member_user_id) VALUES (?, ?)`,
		circleID, viewer).Error)
	require.NoError(t, db.Exec(
		`INSERT INTO share_grants (circle_id, category) VALUES (?, ?)`,
		circleID, string(category)).Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM share_circles WHERE id = ?`, circleID) })

	svc := access.NewService(access.NewRepository(db))
	g, err := svc.Resolve(context.Background(), viewer, owner, category)
	require.NoError(t, err)
	return g
}

// seedWeighIn writes one weigh-in for userID with a body-fat reading, so a
// test can tell whose rows came back. The values are arbitrary test fixtures
// and describe nobody.
func seedWeighIn(t *testing.T, db *gorm.DB, userID uuid.UUID, at time.Time, weightKg, bodyFatPct float64) {
	t.Helper()
	require.NoError(t, db.Exec(
		`INSERT INTO weight_entries (id, user_id, weight_kg, body_fat_pct, logged_at, local_date, source)
		 VALUES (gen_random_uuid(), ?, ?, ?, ?, ?, 'manual')`,
		userID, weightKg, bodyFatPct, at, at.UTC().Format("2006-01-02")).Error)
}

func TestBodySeriesForReturnsTheGrantOwnersEntries(t *testing.T) {
	db := testDB(t)
	viewer := seedUser(t, db)
	owner := seedUser(t, db)
	at := time.Now().Add(-24 * time.Hour)
	seedWeighIn(t, db, owner, at, 70, 20)

	grant := seedGrant(t, db, viewer, owner, access.CategoryBody)

	got, err := NewRepository(db).BodySeriesFor(
		context.Background(), grant, at.Add(-time.Hour), at.Add(time.Hour))
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, 70.0, got[0].WeightKg)
	require.NotNil(t, got[0].BodyFatPct)
	require.Equal(t, 20.0, *got[0].BodyFatPct)
}

// The regression that matters: a query keyed on anything other than
// grant.Owner() -- the viewer's own id, say -- would make the unforgeable
// Grant inert. This was finding F3 in #326's final review on the one
// consumer that used the grant map as a set. Both users have entries here,
// so a wrong key returns rows rather than nothing and the mistake cannot
// hide as an empty result.
func TestBodySeriesForNeverReturnsTheViewersOwnEntries(t *testing.T) {
	db := testDB(t)
	viewer := seedUser(t, db)
	owner := seedUser(t, db)
	at := time.Now().Add(-24 * time.Hour)
	seedWeighIn(t, db, owner, at, 70, 20)
	seedWeighIn(t, db, viewer, at, 91, 31)

	grant := seedGrant(t, db, viewer, owner, access.CategoryBody)

	got, err := NewRepository(db).BodySeriesFor(
		context.Background(), grant, at.Add(-time.Hour), at.Add(time.Hour))
	require.NoError(t, err)
	require.Len(t, got, 1, "exactly the owner's one entry, never the viewer's")
	require.Equal(t, 70.0, got[0].WeightKg)
}

// A forged Grant is reachable from any package -- access.Grant{} compiles
// everywhere; only its fields are unreachable. The design's promise is that
// the failure mode of forging one is NO DATA, never someone else's. Pin it.
func TestBodySeriesForOnAForgedGrantReturnsNothing(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db)
	at := time.Now().Add(-24 * time.Hour)
	seedWeighIn(t, db, owner, at, 70, 20)

	got, err := NewRepository(db).BodySeriesFor(
		context.Background(), access.Grant{}, at.Add(-time.Hour), at.Add(time.Hour))
	require.NoError(t, err)
	require.Empty(t, got)
}

// BOTH bounds, deliberately. An earlier version of this test seeded only an
// entry before `from`, which meant dropping the upper bound entirely left it
// passing — the window was half-tested and the test could not say so.
func TestBodySeriesForExcludesEntriesOutsideTheWindow(t *testing.T) {
	db := testDB(t)
	viewer := seedUser(t, db)
	owner := seedUser(t, db)
	inside := time.Now().Add(-96 * time.Hour)
	before := inside.Add(-48 * time.Hour)
	after := inside.Add(48 * time.Hour)
	seedWeighIn(t, db, owner, inside, 70, 20)
	seedWeighIn(t, db, owner, before, 71, 21)
	seedWeighIn(t, db, owner, after, 72, 22)

	grant := seedGrant(t, db, viewer, owner, access.CategoryBody)

	got, err := NewRepository(db).BodySeriesFor(
		context.Background(), grant, inside.Add(-time.Hour), inside.Add(time.Hour))
	require.NoError(t, err)
	require.Len(t, got, 1, "the entry before `from` and the one at or after `to` are both excluded")
	require.Equal(t, 70.0, got[0].WeightKg)
}

// `to` is EXCLUSIVE, matching WeightSeries. Pinned because the boundary is
// invisible in the query and a >= there would silently widen every window by
// one instant.
func TestBodySeriesForTreatsToAsExclusive(t *testing.T) {
	db := testDB(t)
	viewer := seedUser(t, db)
	owner := seedUser(t, db)
	at := time.Now().Add(-24 * time.Hour).Truncate(time.Second)
	seedWeighIn(t, db, owner, at, 70, 20)

	grant := seedGrant(t, db, viewer, owner, access.CategoryBody)
	repo := NewRepository(db)

	got, err := repo.BodySeriesFor(context.Background(), grant, at.Add(-time.Hour), at)
	require.NoError(t, err)
	require.Empty(t, got, "an entry exactly at `to` is outside the window")

	got, err = repo.BodySeriesFor(context.Background(), grant, at, at.Add(time.Hour))
	require.NoError(t, err)
	require.Len(t, got, 1, "an entry exactly at `from` is inside it")
}

// The exposure boundary, pinned as data rather than prose.
//
// FriendBodyEntry deliberately is NOT tracking.WeightEntry: that type embeds
// BodyComposition and carries id, created_at, hk_uuid and source. Reusing it
// would mean any field added to either struct later becomes visible to
// another person silently, with no diff anywhere that looks like a
// permission change. Widening what a friend can see must require editing
// this list, which says why.
func TestFriendBodyEntryExposesExactlyTheseFields(t *testing.T) {
	fat, muscle := 20.0, 30.0
	blob, err := json.Marshal(FriendBodyEntry{
		LoggedAt:     time.Now(),
		LocalDate:    time.Now(),
		WeightKg:     70,
		BodyFatPct:   &fat,
		MuscleMassKg: &muscle,
	})
	require.NoError(t, err)

	var got map[string]any
	require.NoError(t, json.Unmarshal(blob, &got))
	keys := make([]string, 0, len(got))
	for k := range got {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	require.Equal(t, []string{
		"body_fat_pct", "local_date", "logged_at", "muscle_mass_kg", "weight_kg",
	}, keys, "every other metric field is omitempty and absent when nil")

	// The metadata that must never appear, asserted by name so a future
	// embedding of WeightEntry or BodyComposition fails here.
	full, err := json.Marshal(FriendBodyEntry{LoggedAt: time.Now(), WeightKg: 70})
	require.NoError(t, err)
	for _, forbidden := range []string{`"id"`, `"created_at"`, `"hk_uuid"`, `"source"`, `"user_id"`} {
		require.NotContains(t, string(full), forbidden)
	}
}

// --- HTTP level -------------------------------------------------------------

func friendBodyRouter(t *testing.T, db *gorm.DB, viewer uuid.UUID) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", viewer); c.Next() })
	h := NewFriendBodyHandler(NewRepository(db), access.NewService(access.NewRepository(db)))
	r.GET("/v1/friends/:userId/body", h.Get)
	return r
}

func getFriendBody(t *testing.T, r *gin.Engine, ownerID string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/friends/"+ownerID+"/body", nil))
	return w
}

func TestFriendBodyReturnsTheSeriesWhenGranted(t *testing.T) {
	db := testDB(t)
	viewer := seedUser(t, db)
	owner := seedUser(t, db)
	seedWeighIn(t, db, owner, time.Now().Add(-24*time.Hour), 70, 20)
	seedGrant(t, db, viewer, owner, access.CategoryBody)

	w := getFriendBody(t, friendBodyRouter(t, db, viewer), owner.String())

	require.Equal(t, http.StatusOK, w.Code)
	var env struct {
		Data []FriendBodyEntry `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &env))
	require.Len(t, env.Data, 1)
	require.Equal(t, 70.0, env.Data[0].WeightKg)
}

// ErrNotShared must render 404, never 403: a 403 confirms the data exists
// and is being withheld, which leaks the existence of something the owner
// chose not to share. Not-shared and not-there must be indistinguishable.
//
// Before this handler, access.Resolve had zero production callers, so
// ErrNotShared had no mapping anywhere and would have surfaced as a 500.
func TestFriendBodyIs404WithoutAGrant(t *testing.T) {
	db := testDB(t)
	viewer := seedUser(t, db)
	owner := seedUser(t, db)
	seedWeighIn(t, db, owner, time.Now().Add(-24*time.Hour), 70, 20)
	// Friends, deliberately: friendship alone must not grant visibility.
	require.NoError(t, db.Exec(
		`INSERT INTO friendships (id, requester_id, addressee_id, status)
		 VALUES (gen_random_uuid(), ?, ?, 'accepted')`, viewer, owner).Error)
	t.Cleanup(func() {
		db.Exec(`DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ?`, viewer, owner)
	})

	w := getFriendBody(t, friendBodyRouter(t, db, viewer), owner.String())

	require.Equal(t, http.StatusNotFound, w.Code)
	require.NotContains(t, w.Body.String(), "weight_kg")
	require.NotContains(t, w.Body.String(), "body_fat_pct")
}

// A stranger and a non-existent user must be indistinguishable from someone
// who simply has not shared -- same status, same body.
func TestFriendBodyIs404ForAStrangerAndForAnUnknownUser(t *testing.T) {
	db := testDB(t)
	viewer := seedUser(t, db)
	stranger := seedUser(t, db)
	r := friendBodyRouter(t, db, viewer)

	for _, target := range []string{stranger.String(), uuid.New().String(), "not-a-uuid"} {
		w := getFriendBody(t, r, target)
		require.Equal(t, http.StatusNotFound, w.Code, "target %s", target)
	}
}

// Your own body data has its own endpoint. access.Resolve already refuses a
// self-read (access/service_test.go); this pins that the handler forwards
// that refusal rather than special-casing it into a second way to read
// yourself.
func TestFriendBodyIs404ForYourself(t *testing.T) {
	db := testDB(t)
	viewer := seedUser(t, db)
	seedWeighIn(t, db, viewer, time.Now().Add(-24*time.Hour), 70, 20)

	w := getFriendBody(t, friendBodyRouter(t, db, viewer), viewer.String())

	require.Equal(t, http.StatusNotFound, w.Code)
	require.NotContains(t, w.Body.String(), "weight_kg")
}

// A progress grant is not a body grant. The category is the whole point of
// #326; a handler that resolved any grant would make it decorative.
func TestFriendBodyIs404WhenOnlyProgressIsGranted(t *testing.T) {
	db := testDB(t)
	viewer := seedUser(t, db)
	owner := seedUser(t, db)
	seedWeighIn(t, db, owner, time.Now().Add(-24*time.Hour), 70, 20)
	seedGrant(t, db, viewer, owner, access.CategoryProgress)

	w := getFriendBody(t, friendBodyRouter(t, db, viewer), owner.String())

	require.Equal(t, http.StatusNotFound, w.Code)
	require.NotContains(t, w.Body.String(), "weight_kg")
}
