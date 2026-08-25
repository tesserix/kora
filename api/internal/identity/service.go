package identity

import (
	"context"
	"log/slog"
	"strings"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/assets"
	"github.com/tesserix/kora/api/internal/imageproc"
)

// Service owns the handle lifecycle. avatarURL composes a public URL from the
// stored object PATH; it is a func rather than an assets.Store so this package
// does not depend on object storage to be tested, and so the URL scheme stays a
// deployment concern rather than something baked into user rows.
type Service struct {
	repo        Repository
	avatarURL   func(path string) string
	store       assets.Store
	friendships FriendshipStatusProvider
}

// NewService takes a bare URL composer, for callers and tests that do not need
// to write objects. Its store is assets.Noop{}, so SetAvatar succeeds and
// produces no picture rather than panicking on a nil interface.
func NewService(repo Repository, avatarURL func(path string) string) Service {
	return Service{repo: repo, avatarURL: avatarURL, store: assets.Noop{}}
}

// NewServiceWithAssets is the wiring the real API uses: one store supplies both
// the writes and the URL composition, so the two can never disagree about where
// an object lives.
func NewServiceWithAssets(repo Repository, store assets.Store) Service {
	if store == nil {
		store = assets.Noop{}
	}
	return Service{repo: repo, avatarURL: store.URL, store: store}
}

// WithFriendships wires a FriendshipStatusProvider (social.Service in
// production, via router.go) into Lookup so it can report the viewer's
// relationship to the looked-up person. A Service built without this call
// still compiles and runs -- Lookup simply degrades friendship_status to
// FriendshipNone, same nil-tolerant shape as social.Service.WithNotifier /
// WithHandles.
func (s Service) WithFriendships(p FriendshipStatusProvider) Service {
	s.friendships = p
	return s
}

// SetAvatar normalises data, stores it at a fresh path, points the user row at
// it, and deletes whatever object it replaced.
//
// ORDER is load-bearing. The new object is written BEFORE the row is updated,
// so a failure between them leaves an orphaned object (reaped by the bucket's
// lifecycle rule) rather than a row pointing at nothing (a broken image in
// every friend row that renders this person). The OLD object is deleted LAST,
// and non-fatally: an upload that succeeded must not report failure because
// cleanup of a superseded file did not.
func (s Service) SetAvatar(ctx context.Context, userID uuid.UUID, data []byte) (string, error) {
	normalised, err := imageproc.NormalizeAvatar(data)
	if err != nil {
		return "", err
	}

	me, err := s.repo.FindByID(ctx, userID)
	if err != nil {
		return "", err
	}

	path := assets.AvatarPath(userID)
	if err := s.store.Put(ctx, path, normalised, "image/jpeg"); err != nil {
		return "", err
	}
	if err := s.repo.SetAvatarPath(ctx, userID, path); err != nil {
		return "", err
	}
	if me.AvatarPath != "" && me.AvatarPath != path {
		if err := s.store.Delete(ctx, me.AvatarPath); err != nil {
			slog.ErrorContext(ctx, "superseded avatar object survived; lifecycle rule will reap it",
				"user_id", userID, "path", me.AvatarPath, "error", err)
		}
	}
	return s.avatarURL(path), nil
}

// ClearAvatar removes the picture. The ROW is cleared first: if the object
// delete then fails, the user's picture is gone from every surface, which is
// what they asked for, and an unreferenced object is reaped by lifecycle. The
// reverse order would delete the object while the row still pointed at it --
// a broken image everywhere, on a request to remove one.
func (s Service) ClearAvatar(ctx context.Context, userID uuid.UUID) error {
	me, err := s.repo.FindByID(ctx, userID)
	if err != nil {
		return err
	}
	if me.AvatarPath == "" {
		return nil
	}
	if err := s.repo.SetAvatarPath(ctx, userID, ""); err != nil {
		return err
	}
	if err := s.store.Delete(ctx, me.AvatarPath); err != nil {
		slog.ErrorContext(ctx, "avatar object survived removal; lifecycle rule will reap it",
			"user_id", userID, "path", me.AvatarPath, "error", err)
	}
	return nil
}

// Claim sets the caller's handle, retiring whatever they held before.
//
// Re-claiming your own current handle is a no-op that returns success and
// retires nothing: saving a profile form twice must not tell someone their own
// handle is taken.
func (s Service) Claim(ctx context.Context, userID uuid.UUID, raw string) (string, error) {
	display, canonical, err := Canonical(raw)
	if err != nil {
		return "", err
	}

	me, err := s.repo.FindByID(ctx, userID)
	if err != nil {
		return "", err
	}
	// Not the safety mechanism for "reclaiming doesn't retire": that guarantee
	// actually comes from SetHandle's own prevCanonical != canonical check
	// below, which is what stops a same-handle write from inserting a
	// retirement. This early return only short-circuits the redundant
	// IsRetired/FindByCanonical/SetHandle round-trip on that path -- it saves
	// work, not correctness. No test discriminates removing it.
	if me.HandleCanonical == canonical {
		return me.Handle, nil
	}

	retired, err := s.repo.IsRetired(ctx, canonical)
	if err != nil {
		return "", err
	}
	if retired {
		return "", ErrHandleRetired
	}

	// Checked before the write for a clear error message, and enforced again
	// by the unique index below -- two callers racing for the same handle both
	// pass this check, and only one survives the INSERT.
	if owner, err := s.repo.FindByCanonical(ctx, canonical); err == nil {
		if owner.ID != userID {
			return "", ErrHandleTaken
		}
	} else if err != ErrNotFound {
		return "", err
	}

	if err := s.repo.SetHandle(ctx, userID, display, canonical, me.HandleCanonical); err != nil {
		// The partial unique index is the real arbiter of a race; translate
		// its violation into the same error the pre-check produces.
		if strings.Contains(err.Error(), "users_handle_canonical_key") {
			return "", ErrHandleTaken
		}
		return "", err
	}
	return display, nil
}

// Clear removes the caller's handle and retires it permanently. Clearing when
// you have no handle succeeds and does nothing.
func (s Service) Clear(ctx context.Context, userID uuid.UUID) error {
	me, err := s.repo.FindByID(ctx, userID)
	if err != nil {
		return err
	}
	if me.HandleCanonical == "" {
		return nil
	}
	return s.repo.ClearHandle(ctx, userID, me.HandleCanonical)
}

// MyHandle returns the caller's own display handle, or "" if they have none.
func (s Service) MyHandle(ctx context.Context, userID uuid.UUID) (string, error) {
	me, err := s.repo.FindByID(ctx, userID)
	if err != nil {
		return "", err
	}
	return me.Handle, nil
}

// Lookup resolves a spoken handle to one person, as seen by viewerID. EXACT
// MATCH ONLY, after folding -- there is no prefix variant of this method and
// there must never be one, because prefix search would make the whole user
// base enumerable and tell anyone who cares who uses a calorie tracker.
//
// A handle that cannot even be a handle (wrong shape, reserved) returns
// ErrNotFound rather than a validation error: the caller asked "who is this",
// and "nobody" is the honest answer for every input that no account can hold.
func (s Service) Lookup(ctx context.Context, viewerID uuid.UUID, raw string) (LookupView, error) {
	_, canonical, err := Canonical(raw)
	if err != nil {
		return LookupView{}, ErrNotFound
	}
	u, err := s.repo.FindByCanonical(ctx, canonical)
	if err != nil {
		return LookupView{}, err
	}
	return LookupView{
		ID:               u.ID,
		DisplayName:      u.DisplayName,
		Handle:           u.Handle,
		AvatarURL:        s.avatarURL(u.AvatarPath),
		FriendshipStatus: s.friendshipStatus(ctx, viewerID, u.ID),
	}, nil
}

// friendshipStatus resolves the viewer's relationship to other, degrading to
// FriendshipNone when there is no provider (nil-tolerant, see
// FriendshipStatusProvider's doc comment) or when the provider itself
// errors -- a friendship-status lookup failing must not turn a successful
// handle lookup into a 500, since the worst outcome of getting this wrong is
// a stale button, not a wrong action (SendRequest is idempotent either way).
//
// Self is handled BEFORE the provider is consulted, and unconditionally: a
// user is never their own pending request or friend, so this needs no DB
// round trip and holds even when s.friendships is nil.
func (s Service) friendshipStatus(ctx context.Context, viewerID, other uuid.UUID) FriendshipStatus {
	if viewerID == other {
		return FriendshipSelf
	}
	if s.friendships == nil {
		return FriendshipNone
	}
	status, err := s.friendships.FriendshipStatus(ctx, viewerID, other)
	if err != nil {
		slog.ErrorContext(ctx, "friendship status lookup failed; lookup degrades to none",
			"viewer_id", viewerID, "other_id", other, "error", err)
		return FriendshipNone
	}
	return status
}
