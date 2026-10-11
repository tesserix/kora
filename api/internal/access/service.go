package access

import (
	"context"

	"github.com/google/uuid"
)

// granter is the minimal repository behavior Service depends on. Defined as
// an interface here, not the concrete Repository, so tests can substitute a
// fake that never touches Postgres -- the DB's own CHECK constraint on
// share_grants.category (see migration 000054) means an invalid category can
// never match a row, which makes the app-level Category.Valid() guard below
// impossible to mutation-test through a real DB. A fake exposes it directly.
type granter interface {
	GrantedOwners(ctx context.Context, viewer uuid.UUID, owners []uuid.UUID, category Category) ([]uuid.UUID, error)
}

type Service struct {
	granter granter
}

// NewService is the production constructor. It takes the CONCRETE Repository
// on purpose: an interface parameter here would let any package outside
// `access` substitute its own granter and have Resolve manufacture a Grant
// for an owner it was never granted. Go does not enforce unexported
// interfaces against external structural satisfaction, so the concrete type
// is the only thing that makes that impossible.
func NewService(repo Repository) Service { return Service{granter: repo} }

// newServiceWithGranter exists so the category guard can be tested in
// isolation -- see TestResolveManyRefusesAnUnknownCategoryWithoutQueryingTheRepository.
// Unexported, so only this package (and its tests) can reach it.
func newServiceWithGranter(g granter) Service { return Service{granter: g} }

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
	granted, err := s.granter.GrantedOwners(ctx, viewer, owners, c)
	if err != nil {
		return nil, err
	}
	for _, owner := range granted {
		out[owner] = Grant{viewer: viewer, owner: owner, category: c}
	}
	return out, nil
}
