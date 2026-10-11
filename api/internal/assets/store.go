// Package assets stores user-supplied files.
//
// It is worth naming what this package changes: before it, Kora persisted NO
// user images at all -- meal photos are sent to the vision provider as base64
// and never written anywhere. Profile pictures (kora#449) give that posture up
// on purpose, in exchange for people being able to tell they found the right
// human before sending a friend request that may end in sharing body metrics.
// Anything added here should be weighed against that trade, not waved through
// because the package already exists.
package assets

import (
	"context"
	"strings"

	"github.com/google/uuid"
)

type Store interface {
	Put(ctx context.Context, path string, data []byte, contentType string) error
	Delete(ctx context.Context, path string) error
	// URL composes the public URL for a stored path. It returns "" for an
	// empty path, which is what "this user has no picture" looks like.
	URL(path string) string
}

// AvatarPath is where one user's picture lives. The VERSION segment is a fresh
// UUID per write, which makes cache invalidation free: a new picture is a new
// URL, so no client, CDN or image cache has to be told to forget the old one.
// It also lets a lifecycle rule reap superseded objects without knowing
// anything about users.
//
// Objects are public-read at an unguessable path. Signed URLs were rejected:
// they would mean re-signing on every render of every friend row for no privacy
// gain, because the avatar is already visible to anyone holding the handle --
// that IS the consent boundary this feature is built on.
func AvatarPath(userID uuid.UUID) string {
	return "avatars/" + userID.String() + "/" + uuid.NewString() + ".jpg"
}

// Noop is the store used when no bucket is configured. Put and Delete succeed
// and URL returns "", so an environment with no object storage behaves exactly
// like every user having no picture -- rather than 500ing on upload, which
// would break local development for everyone not working on avatars.
type Noop struct{}

func (Noop) Put(context.Context, string, []byte, string) error { return nil }
func (Noop) Delete(context.Context, string) error              { return nil }
func (Noop) URL(string) string                                 { return "" }

// joinPublic composes publicBaseURL and path with exactly one slash between.
func joinPublic(base, path string) string {
	if path == "" || base == "" {
		return ""
	}
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(path, "/")
}
