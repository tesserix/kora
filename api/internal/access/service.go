package access

import (
	"context"

	"github.com/google/uuid"
)

type Service struct {
	repo Repository
}

func NewService(repo Repository) Service { return Service{repo: repo} }

// Resolve returns a Grant, or ErrNotShared. It is the ONLY way to obtain a
// Grant with an owner in it.
func (s Service) Resolve(ctx context.Context, viewer, owner uuid.UUID, c Category) (Grant, error) {
	grants, err := s.ResolveMany(ctx, viewer, []uuid.UUID{owner}, c)
	if err != nil {
		return Grant{}, err
	}
	g, ok := grants[owner]
	if !ok {
		return Grant{}, ErrNotShared
	}
	return g, nil
}

// ResolveMany is the batch form, keyed by owner. Owners with no grant are
// ABSENT from the map rather than present with a zero Grant -- a zero Grant is
// indistinguishable from a forged one and must never appear to be a result.
func (s Service) ResolveMany(ctx context.Context, viewer uuid.UUID, owners []uuid.UUID, c Category) (map[uuid.UUID]Grant, error) {
	out := map[uuid.UUID]Grant{}
	// An unknown category is refused here rather than in SQL, so a typo can
	// never silently match nothing and read as "not shared".
	if !c.Valid() || len(owners) == 0 {
		return out, nil
	}
	granted, err := s.repo.GrantedOwners(ctx, viewer, owners, c)
	if err != nil {
		return nil, err
	}
	for _, owner := range granted {
		out[owner] = Grant{viewer: viewer, owner: owner, category: c}
	}
	return out, nil
}
