package access_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
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
// listField names the key under "data" that holds the per-other-user
// entries (each with its own "sharing"/"streak_days"/"adherence_days"). It
// is NOT the whole response body: /v1/friends/progress also legitimately
// echoes the CALLER's own streak/adherence under "data.me" -- that is the
// viewer's own data, not a leak, so the leak assertion is scoped to
// listField rather than grepped over the raw response.
var crossUserPaths = []struct {
	name      string
	method    string
	path      string
	listField string
}{
	{"friends progress", "GET", "/v1/friends/progress", "friends"},
	{"group progress", "GET", "/v1/groups/%s/progress", "members"},
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

	for _, p := range crossUserPaths {
		t.Run(p.name, func(t *testing.T) {
			path := p.path
			if strings.Contains(path, "%s") {
				path = fmt.Sprintf(path, groupID)
			}
			r := testAPIRouter(t, db, viewer)
			req := httptest.NewRequest(p.method, path, nil)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

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
			require.NotContains(t, listJSON, `"streak_days"`)
			require.NotContains(t, listJSON, `"adherence_days"`)
			require.Contains(t, listJSON, `"sharing":false`)
		})
	}
}
