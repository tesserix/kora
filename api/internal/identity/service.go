package identity

import (
	"context"
	"strings"

	"github.com/google/uuid"
)

// Service owns the handle lifecycle. avatarURL composes a public URL from the
// stored object PATH; it is a func rather than an assets.Store so this package
// does not depend on object storage to be tested, and so the URL scheme stays a
// deployment concern rather than something baked into user rows.
type Service struct {
	repo      Repository
	avatarURL func(path string) string
}

func NewService(repo Repository, avatarURL func(path string) string) Service {
	return Service{repo: repo, avatarURL: avatarURL}
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

// Lookup resolves a spoken handle to one person. EXACT MATCH ONLY, after
// folding -- there is no prefix variant of this method and there must never be
// one, because prefix search would make the whole user base enumerable and tell
// anyone who cares who uses a calorie tracker.
//
// A handle that cannot even be a handle (wrong shape, reserved) returns
// ErrNotFound rather than a validation error: the caller asked "who is this",
// and "nobody" is the honest answer for every input that no account can hold.
func (s Service) Lookup(ctx context.Context, raw string) (LookupView, error) {
	_, canonical, err := Canonical(raw)
	if err != nil {
		return LookupView{}, ErrNotFound
	}
	u, err := s.repo.FindByCanonical(ctx, canonical)
	if err != nil {
		return LookupView{}, err
	}
	return LookupView{
		ID:          u.ID,
		DisplayName: u.DisplayName,
		Handle:      u.Handle,
		AvatarURL:   s.avatarURL(u.AvatarPath),
	}, nil
}
