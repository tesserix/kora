package assets

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestLocal_PutThenReadBack(t *testing.T) {
	dir := t.TempDir()
	s := NewLocal(dir, "http://localhost:8080/assets")
	path := "avatars/" + uuid.NewString() + "/v1.jpg"

	require.NoError(t, s.Put(context.Background(), path, []byte("bytes"), "image/jpeg"))

	got, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(path)))
	require.NoError(t, err)
	require.Equal(t, "bytes", string(got))
	require.Equal(t, "http://localhost:8080/assets/"+path, s.URL(path))
}

func TestLocal_DeleteIsIdempotent(t *testing.T) {
	s := NewLocal(t.TempDir(), "http://x/assets")
	path := "avatars/a/v1.jpg"
	require.NoError(t, s.Put(context.Background(), path, []byte("x"), "image/jpeg"))
	require.NoError(t, s.Delete(context.Background(), path))
	require.NoError(t, s.Delete(context.Background(), path),
		"deleting an object that is already gone is the outcome the caller asked for")
}

// An empty path must never compose a URL. It is the "this user has no picture"
// value, and a URL pointing at the bucket root renders as a broken image inside
// a friend row rather than falling back to initials.
func TestURL_EmptyPathIsEmptyURL(t *testing.T) {
	require.Empty(t, NewLocal(t.TempDir(), "http://x/assets").URL(""))
	require.Empty(t, Noop{}.URL("avatars/a/v1.jpg"))
}

// Path traversal. The path segment is composed by AvatarPath from a UUID today,
// but a store that joins caller-supplied text into a filesystem path must
// refuse to escape its directory regardless of who is calling.
func TestLocal_RefusesPathTraversal(t *testing.T) {
	dir := t.TempDir()
	s := NewLocal(dir, "http://x/assets")
	err := s.Put(context.Background(), "../../escaped.jpg", []byte("x"), "image/jpeg")
	require.Error(t, err)

	_, statErr := os.Stat(filepath.Join(filepath.Dir(dir), "escaped.jpg"))
	require.True(t, os.IsNotExist(statErr), "nothing may be written outside the store's directory")
}

// The version segment is what makes cache invalidation free: a new picture is a
// new URL, so no client, CDN or image cache anywhere has to be told to forget
// the old one.
func TestAvatarPath_IsVersionedPerUser(t *testing.T) {
	id := uuid.New()
	a, b := AvatarPath(id), AvatarPath(id)
	require.NotEqual(t, a, b, "each write gets its own path")
	require.True(t, strings.HasPrefix(a, "avatars/"+id.String()+"/"))
	require.True(t, strings.HasSuffix(a, ".jpg"))
}

func TestNoop_SucceedsSilently(t *testing.T) {
	require.NoError(t, Noop{}.Put(context.Background(), "p", []byte("x"), "image/jpeg"))
	require.NoError(t, Noop{}.Delete(context.Background(), "p"))
}
