package nutrition

import "context"

// Ingester is a source of FoodItems for the local index. External-source
// implementations (AFCD, OpenFoodFacts, USDA dumps) land in Phase 1b; for now
// SeedIngester provides a curated dev set.
type Ingester interface {
	Name() string
	Fetch(ctx context.Context) ([]FoodItem, error)
}

type SeedIngester struct{}

func (SeedIngester) Name() string { return "seed" }

func (SeedIngester) Fetch(_ context.Context) ([]FoodItem, error) {
	return SeedItems(), nil
}

// Seed idempotently loads the curated dev food set. Returns count inserted.
func Seed(ctx context.Context, repo Repository) (int, error) {
	items, err := SeedIngester{}.Fetch(ctx)
	if err != nil {
		return 0, err
	}
	return repo.Insert(ctx, items)
}
