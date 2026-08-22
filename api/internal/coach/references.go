package coach

import (
	"context"
	"fmt"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/nutrition"
)

const nutritionReferenceLimit = 6

// NutritionReference is one reviewed, global food-composition record supplied
// to an AI run. It is evidence for the answer, never user memory.
type NutritionReference struct {
	Name           string
	Provenance     string
	Locale         nutrition.Locale
	KcalPer100g    float64
	ProteinPer100g float64
	CarbsPer100g   float64
	FatPer100g     float64
	FiberPer100g   float64
}

// NutritionReferenceSource retrieves global evidence for one user question.
// Implementations must not read user-owned rows.
type NutritionReferenceSource interface {
	Search(
		ctx context.Context,
		query string,
		locale nutrition.Locale,
		limit int,
	) ([]NutritionReference, ai.Usage, error)
}

type nutritionReferenceSource struct {
	foods    nutrition.Repository
	provider ai.Provider
}

// NewNutritionReferenceSource reuses the same embedding model and pgvector
// index as food resolution, keeping vector spaces compatible.
func NewNutritionReferenceSource(
	foods nutrition.Repository,
	provider ai.Provider,
) NutritionReferenceSource {
	if provider == nil {
		return nil
	}
	return nutritionReferenceSource{foods: foods, provider: provider}
}

func (s nutritionReferenceSource) Search(
	ctx context.Context,
	query string,
	locale nutrition.Locale,
	limit int,
) ([]NutritionReference, ai.Usage, error) {
	if s.provider == nil {
		return nil, ai.Usage{}, fmt.Errorf("coach: nutrition references: provider unavailable")
	}
	vector, usage, err := s.provider.Embed(ctx, query)
	if err != nil {
		return nil, usage, fmt.Errorf("coach: nutrition references: embed query: %w", err)
	}
	candidates, err := s.foods.SearchReferenceFoods(ctx, vector, locale, limit)
	if err != nil {
		return nil, usage, fmt.Errorf("coach: nutrition references: search: %w", err)
	}

	items := make([]NutritionReference, len(candidates))
	for i, candidate := range candidates {
		item := candidate.Item
		items[i] = NutritionReference{
			Name: item.Name, Provenance: item.Provenance, Locale: item.Locale,
			KcalPer100g: item.KcalPer100g, ProteinPer100g: item.ProteinPer100g,
			CarbsPer100g: item.CarbsPer100g, FatPer100g: item.FatPer100g,
			FiberPer100g: item.FiberPer100g,
		}
	}
	return items, usage, nil
}
