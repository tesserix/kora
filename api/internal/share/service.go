package share

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/access"
	"github.com/tesserix/kora/api/internal/httpx"
)

// friendSource is the slice of social.Repository this package needs, declared
// here (rather than imported from social) so the dependency is one method
// wide.
//
// This stays an unexported one-method interface even though Go does not stop
// an external package from satisfying it structurally -- unlike
// access.NewService (deliberately forced back to a concrete granter type
// because a substituted granter forges permission itself), a substituted
// friendSource can only decide who may be ADDED to a circle. It cannot grant
// anyone access to another person's data, because access.Resolve stays
// concrete. Don't widen access to match this, and don't narrow this to match
// access -- the two are deliberately different for this reason.
type friendSource interface {
	AreFriends(ctx context.Context, a, b uuid.UUID) (bool, error)
}

type Service struct {
	repo    Repository
	friends friendSource
}

func NewService(repo Repository, friends friendSource) Service {
	return Service{repo: repo, friends: friends}
}

func (s Service) Create(ctx context.Context, ownerID uuid.UUID, name string) (Circle, error) {
	if len(name) == 0 || len(name) > 60 {
		return Circle{}, httpx.ValidationError{Message: "Circle name must be 1-60 characters."}
	}
	return s.repo.Create(ctx, ownerID, name)
}

func (s Service) List(ctx context.Context, ownerID uuid.UUID) ([]CircleView, error) {
	return s.repo.ListForOwner(ctx, ownerID)
}

// ownedCircle is the gate on every mutation: knowing a circle's UUID must not
// be enough to modify it.
func (s Service) ownedCircle(ctx context.Context, ownerID, circleID uuid.UUID) error {
	c, err := s.repo.FindByID(ctx, circleID)
	if err != nil {
		return err
	}
	if c == nil || c.OwnerID != ownerID {
		return ErrNotOwner
	}
	return nil
}

func (s Service) AddMember(ctx context.Context, ownerID, circleID, memberID uuid.UUID) error {
	if err := s.ownedCircle(ctx, ownerID, circleID); err != nil {
		return err
	}
	friends, err := s.friends.AreFriends(ctx, ownerID, memberID)
	if err != nil {
		return fmt.Errorf("share: check friendship: %w", err)
	}
	if !friends {
		return ErrNotFriends
	}
	return s.repo.AddMember(ctx, circleID, memberID)
}

func (s Service) RemoveMember(ctx context.Context, ownerID, circleID, memberID uuid.UUID) error {
	if err := s.ownedCircle(ctx, ownerID, circleID); err != nil {
		return err
	}
	return s.repo.RemoveMember(ctx, circleID, memberID)
}

func (s Service) SetCategories(ctx context.Context, ownerID, circleID uuid.UUID, cats []access.Category) error {
	if err := s.ownedCircle(ctx, ownerID, circleID); err != nil {
		return err
	}
	for _, c := range cats {
		if !c.Valid() {
			return httpx.ValidationError{Message: fmt.Sprintf("Unknown sharing category: %s", c)}
		}
	}
	return s.repo.SetCategories(ctx, circleID, cats)
}

func (s Service) Delete(ctx context.Context, ownerID, circleID uuid.UUID) error {
	if err := s.ownedCircle(ctx, ownerID, circleID); err != nil {
		return err
	}
	return s.repo.Delete(ctx, circleID)
}

// Leave removes the CALLER from a circle they do not own. Deliberately not
// owner-gated -- that is the whole point of it.
func (s Service) Leave(ctx context.Context, memberID, circleID uuid.UUID) error {
	return s.repo.RemoveMember(ctx, circleID, memberID)
}
