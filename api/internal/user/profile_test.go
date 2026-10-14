package user

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/auth"
)

type countingProfiles struct {
	profile auth.Profile
	err     error
	calls   int
	tokens  []string
}

func (p *countingProfiles) Profile(_ context.Context, token string) (auth.Profile, error) {
	p.calls++
	p.tokens = append(p.tokens, token)
	return p.profile, p.err
}

func loaderFor(p *countingProfiles) ProfileLoader {
	return func(ctx context.Context) (string, string, error) {
		got, err := p.Profile(ctx, "token")
		return got.Email, got.Name, err
	}
}

func TestEnsureUserWithProfileSkipsLoadForCompleteRow(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	const uid = "profile-complete-uid"
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE idp_subject = ?", uid) })
	_, err := repo.EnsureUser(context.Background(), uid, "complete@test.dev", "Ada")
	require.NoError(t, err)

	profiles := &countingProfiles{profile: auth.Profile{Email: "other@test.dev", Name: "Other"}}
	u, err := repo.EnsureUserWithProfile(context.Background(), uid, loaderFor(profiles))

	require.NoError(t, err)
	assert.Zero(t, profiles.calls)
	assert.Equal(t, "complete@test.dev", u.Email)
	assert.Equal(t, "Ada", u.DisplayName)
}

func TestEnsureUserWithProfileProvisionsFromLoader(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	const uid = "profile-new-uid"
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE idp_subject = ?", uid) })

	profiles := &countingProfiles{profile: auth.Profile{Email: "new@test.dev", Name: "Grace Hopper"}}
	u, err := repo.EnsureUserWithProfile(context.Background(), uid, loaderFor(profiles))

	require.NoError(t, err)
	assert.Equal(t, 1, profiles.calls)
	assert.Equal(t, "new@test.dev", u.Email)
	assert.Equal(t, "Grace Hopper", u.DisplayName)
}

func TestEnsureUserWithProfileFillsEmptyEmailButNeverReplacesOne(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	const blank, set = "profile-blank-email-uid", "profile-set-email-uid"
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE idp_subject IN (?, ?)", blank, set) })
	_, err := repo.EnsureUser(context.Background(), blank, "", "Named")
	require.NoError(t, err)
	_, err = repo.EnsureUser(context.Background(), set, "kept@test.dev", "")
	require.NoError(t, err)
	profiles := &countingProfiles{profile: auth.Profile{Email: "fresh@test.dev", Name: "Fresh"}}

	filled, err := repo.EnsureUserWithProfile(context.Background(), blank, loaderFor(profiles))
	require.NoError(t, err)
	kept, err := repo.EnsureUserWithProfile(context.Background(), set, loaderFor(profiles))
	require.NoError(t, err)

	assert.Equal(t, "fresh@test.dev", filled.Email)
	assert.Equal(t, "Named", filled.DisplayName)
	assert.Equal(t, "kept@test.dev", kept.Email)
	assert.Equal(t, "Fresh", kept.DisplayName)
	stored, err := repo.ByID(context.Background(), filled.ID)
	require.NoError(t, err)
	assert.Equal(t, "fresh@test.dev", stored.Email)
}

func TestEnsureUserWithProfileProvisionsEvenWhenLoaderFails(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	const uid = "profile-loadfail-uid"
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE idp_subject = ?", uid) })

	profiles := &countingProfiles{err: errors.New("userinfo down")}
	u, err := repo.EnsureUserWithProfile(context.Background(), uid, loaderFor(profiles))

	require.NoError(t, err)
	assert.Empty(t, u.Email)
	assert.NotEqual(t, [16]byte{}, [16]byte(u.ID))
}

func TestResolveMiddlewareFetchesProfileWithTheVerifiedToken(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	const uid = "profile-mw-uid"
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE idp_subject = ?", uid) })
	profiles := &countingProfiles{profile: auth.Profile{Email: "mw@test.dev", Name: "Middle Ware"}}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/x", auth.Middleware(staticVerifier{claims: auth.Claims{UID: uid}}),
		ResolveMiddleware(repo, WithProfileSource(profiles)),
		func(c *gin.Context) { c.Status(http.StatusNoContent) })
	for range 3 {
		w := httptest.NewRecorder()
		req, _ := http.NewRequest(http.MethodGet, "/x", nil)
		req.Header.Set("Authorization", "Bearer the-access-token")
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusNoContent, w.Code)
	}

	assert.Equal(t, 1, profiles.calls, "a complete row must not call userinfo again")
	assert.Equal(t, []string{"the-access-token"}, profiles.tokens)
	u, err := repo.EnsureUser(context.Background(), uid, "", "")
	require.NoError(t, err)
	assert.Equal(t, "mw@test.dev", u.Email)
	assert.Equal(t, "Middle Ware", u.DisplayName)
}

func TestResolveMiddlewarePrefersProfileClaimsInTheToken(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	const uid = "profile-claims-uid"
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE idp_subject = ?", uid) })
	profiles := &countingProfiles{}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/x", auth.Middleware(staticVerifier{claims: auth.Claims{UID: uid, Email: "claim@test.dev"}}),
		ResolveMiddleware(repo, WithProfileSource(profiles)),
		func(c *gin.Context) { c.Status(http.StatusNoContent) })
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer t")
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusNoContent, w.Code)
	assert.Zero(t, profiles.calls)
}

func TestProfileThrottleAllowsOncePerIntervalPerUser(t *testing.T) {
	th := &profileThrottle{last: map[string]time.Time{}, every: time.Minute}
	t0 := time.Now()

	assert.True(t, th.allow("a", t0))
	assert.False(t, th.allow("a", t0.Add(30*time.Second)))
	assert.True(t, th.allow("b", t0.Add(30*time.Second)))
	assert.True(t, th.allow("a", t0.Add(time.Minute)))
	assert.Contains(t, th.last, "b", "b is 30s old, still inside its interval")
	assert.True(t, th.allow("c", t0.Add(2*time.Minute)))
	assert.NotContains(t, th.last, "b", "stale entries are pruned on write")
}
