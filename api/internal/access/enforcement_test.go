package access_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/access"
	"github.com/tesserix/kora/api/internal/compare"
	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/groups"
	"github.com/tesserix/kora/api/internal/social"
	"github.com/tesserix/kora/api/internal/tracking"
	"github.com/tesserix/kora/api/internal/user"
)

// The invariant the whole design rests on: a viewer holding NO grant gets
// nothing from EVERY cross-user path. Asserted per PATH rather than per
// resolver, so an endpoint added later that forgets access.Resolve fails a
// test that already exists rather than needing someone to remember to write
// one.
//
// When a new cross-user endpoint is added, add it to crossUserPaths. That is
// the one manual step, and it is far smaller than remembering the whole rule.
//
// Two shapes of cross-user path, and the difference is not cosmetic:
//
//   - A LIST path (listField set) answers 200 even to a viewer with no
//     grant. Membership is not secret, so the other person is still listed;
//     what must be absent is every figure belonging to them.
//   - A SINGLE-OWNER path (listField empty) answers 404 with no body. There
//     is no list to appear in, so serving 200-with-nothing would leak the
//     fact that the owner exists and has withheld something. Not-shared and
//     not-there must be indistinguishable.
//
// listField names the key under "data" that holds the per-other-user
// entries (each with its own "sharing"/"streak_days"/"adherence_days"). It
// is NOT the whole response body: /v1/friends/progress also legitimately
// echoes the CALLER's own streak/adherence under "data.me" -- that is the
// viewer's own data, not a leak, so the leak assertion is scoped to
// listField rather than grepped over the raw response.
//
// pathArg says which seeded id fills the path's %s verb: a single-owner path
// is parameterised by the OWNER, a group path by the group.
var crossUserPaths = []struct {
	name      string
	method    string
	path      string
	listField string
	pathArg   pathArg
}{
	{"friends progress", "GET", "/v1/friends/progress", "friends", argNone},
	{"group progress", "GET", "/v1/groups/%s/progress", "members", argGroup},
	{"friend body", "GET", "/v1/friends/%s/body", "", argOwner},
}

type pathArg int

const (
	argNone pathArg = iota
	argGroup
	argOwner
)

// leakedFigures are the per-person values no cross-user path may return to a
// viewer holding no grant, whatever its shape.
var leakedFigures = []string{
	`"streak_days"`, `"adherence_days"`, `"weight_kg"`, `"body_fat_pct"`, `"waist_cm"`,
}

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
		id, "enforce-"+id.String(), id.String()+"@example.test", name).Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM users WHERE id = ?`, id) })
	return id
}

// seedGroupWithMembers creates a real groups row owned by ownerID, then adds
// every id in members (other than the owner, who CreateGroup already adds)
// as a plain member. It returns the group's id.
func seedGroupWithMembers(t *testing.T, db *gorm.DB, ownerID uuid.UUID, members []uuid.UUID) uuid.UUID {
	t.Helper()
	repo := groups.NewRepository(db)
	code := "enf-" + uuid.New().String()[:8]
	g, err := repo.CreateGroup(context.Background(), ownerID, "Enforcement Group", code)
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec(`DELETE FROM groups WHERE id = ?`, g.ID) })
	for _, m := range members {
		if m == ownerID {
			continue
		}
		require.NoError(t, repo.AddMember(context.Background(), g.ID, m, groups.RoleMember))
	}
	return g.ID
}

// testAPIRouter builds a gin.Engine wiring the REAL /v1/friends/progress and
// /v1/groups/:id/progress routes exactly as router.go wires them (same
// handler constructors, same dependencies), with a middleware standing in
// for auth.Middleware + user.ResolveMiddleware by setting "user_id" directly
// to the given viewer. A router that differs from production proves nothing
// about production, so this must be kept in sync with
// api/internal/server/router.go's wiring of these two routes.
// seedWeighIn gives the owner one weigh-in carrying the figures the leak
// assertions look for. Arbitrary fixtures; they describe nobody.
func seedWeighIn(t *testing.T, db *gorm.DB, userID uuid.UUID) {
	t.Helper()
	require.NoError(t, db.Exec(
		`INSERT INTO weight_entries (id, user_id, weight_kg, body_fat_pct, waist_cm, logged_at, local_date, source)
		 VALUES (gen_random_uuid(), ?, 70, 20, 80, now(), current_date, 'manual')`, userID).Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM weight_entries WHERE user_id = ?`, userID) })
}

func testAPIRouter(t *testing.T, db *gorm.DB, viewer uuid.UUID) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", viewer); c.Next() })

	socialRepo := social.NewRepository(db)
	userRepo := user.NewRepository(db)
	logRepo := foodlog.NewRepository(db)
	accessSvc := access.NewService(access.NewRepository(db))

	compareHandler := compare.NewHandler(compare.NewService(socialRepo, userRepo, logRepo), accessSvc)
	r.GET("/v1/friends/progress", compareHandler.Get)

	friendBodyHandler := tracking.NewFriendBodyHandler(tracking.NewRepository(db), accessSvc)
	r.GET("/v1/friends/:userId/body", friendBodyHandler.Get)

	groupsRepo := groups.NewRepository(db)
	groupsSvc := groups.NewService(groupsRepo, socialRepo, groups.NewCode)
	groupsHandler := groups.NewHandler(groupsSvc, groupsRepo, compare.NewService(socialRepo, userRepo, logRepo), accessSvc)
	r.GET("/v1/groups/:id/progress", groupsHandler.Progress)

	return r
}

func TestCrossUserPathsLeakNothingWithoutAGrant(t *testing.T) {
	db := testDB(t)
	viewer := seedUser(t, db, "viewer")
	owner := seedUser(t, db, "owner")
	// Friends, deliberately: friendship alone must not grant visibility.
	require.NoError(t, db.Exec(
		`INSERT INTO friendships (id, requester_id, addressee_id, status)
		 VALUES (gen_random_uuid(), ?, ?, 'accepted')`, viewer, owner).Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ?`, viewer, owner) })
	groupID := seedGroupWithMembers(t, db, owner, []uuid.UUID{viewer, owner})
	// The owner must actually HAVE data for "no figures came back" to mean
	// anything. Without this the leak assertions below pass against a
	// handler that leaks, simply because there was nothing to leak.
	seedWeighIn(t, db, owner)

	for _, p := range crossUserPaths {
		t.Run(p.name, func(t *testing.T) {
			path := p.path
			switch p.pathArg {
			case argGroup:
				path = fmt.Sprintf(path, groupID)
			case argOwner:
				path = fmt.Sprintf(path, owner)
			}
			r := testAPIRouter(t, db, viewer)
			req := httptest.NewRequest(p.method, path, nil)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

			// The single-owner shape: 404, and not one figure anywhere in
			// the response -- there is no list the owner may legitimately
			// appear in, so nothing about them may come back at all.
			if p.listField == "" {
				require.Equal(t, http.StatusNotFound, w.Code)
				for _, figure := range leakedFigures {
					require.NotContains(t, w.Body.String(), figure)
				}
				return
			}

			require.Equal(t, http.StatusOK, w.Code)

			var envelope struct {
				Data map[string]json.RawMessage `json:"data"`
			}
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &envelope))
			list, ok := envelope.Data[p.listField]
			require.True(t, ok, "response missing %q list", p.listField)
			listJSON := string(list)

			// The owner may be LISTED -- membership is not secret -- but none
			// of their figures may appear. omitempty drops nil metric
			// pointers, so their absence from the JSON is the assertion.
			for _, figure := range leakedFigures {
				require.NotContains(t, listJSON, figure)
			}
			require.Contains(t, listJSON, `"sharing":false`)

			// The absence of streak_days/adherence_days is not, on its own,
			// proof the owner's row is even present -- data.members also
			// carries the VIEWER's own row, gated the same way (see the
			// package comment on this pre-existing asymmetry with
			// data.friends). A broken membership/friends query that dropped
			// the owner entirely would satisfy every assertion above while
			// silently returning nothing about them. Pin the owner's actual
			// presence so that failure mode is caught too.
			require.Contains(t, listJSON, owner.String(),
				"owner must be present in the response, even though none of their figures may be")
		})
	}
}
