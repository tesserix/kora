package nutrition

import (
	"context"
	"fmt"
	"math"
	"strings"

	"github.com/google/uuid"
	"github.com/pgvector/pgvector-go"
	"gorm.io/gorm"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository {
	return Repository{db: db}
}

const searchLimitMax = 25

func (r Repository) Search(ctx context.Context, query string, limit int) ([]FoodItem, error) {
	if limit <= 0 || limit > searchLimitMax {
		limit = searchLimitMax
	}
	pattern := "%" + query + "%"
	var items []FoodItem
	err := r.db.WithContext(ctx).
		Where("name ILIKE ? OR brand ILIKE ?", pattern, pattern).
		Order("name ASC").
		Limit(limit).
		Find(&items).Error
	if err != nil {
		return nil, fmt.Errorf("nutrition: search: %w", err)
	}
	return items, nil
}

func (r Repository) GetByID(ctx context.Context, id uuid.UUID) (FoodItem, error) {
	var item FoodItem
	if err := r.db.WithContext(ctx).First(&item, "id = ?", id).Error; err != nil {
		return FoodItem{}, fmt.Errorf("nutrition: get by id: %w", err)
	}
	return item, nil
}

func (r Repository) Count(ctx context.Context) (int64, error) {
	var n int64
	if err := r.db.WithContext(ctx).Model(&FoodItem{}).Count(&n).Error; err != nil {
		return 0, fmt.Errorf("nutrition: count: %w", err)
	}
	return n, nil
}

// Insert adds items that are not already present (matched by barcode when
// present, falling back to name+brand for barcodeless items).
func (r Repository) Insert(ctx context.Context, items []FoodItem) (int, error) {
	inserted := 0
	for _, item := range items {
		if item.Barcode != nil && *item.Barcode != "" {
			var bcount int64
			if err := r.db.WithContext(ctx).Model(&FoodItem{}).
				Where("barcode = ?", *item.Barcode).
				Count(&bcount).Error; err != nil {
				return inserted, fmt.Errorf("nutrition: insert barcode check: %w", err)
			}
			if bcount > 0 {
				continue
			}
		}
		var count int64
		if err := r.db.WithContext(ctx).Model(&FoodItem{}).
			Where("name = ? AND brand = ?", item.Name, item.Brand).
			Count(&count).Error; err != nil {
			return inserted, fmt.Errorf("nutrition: insert check: %w", err)
		}
		if count > 0 {
			continue
		}
		created := item
		created.NormalizedName = Normalize(item.Name)
		if err := r.db.WithContext(ctx).Create(&created).Error; err != nil {
			return inserted, fmt.Errorf("nutrition: insert: %w", err)
		}
		inserted++
	}
	return inserted, nil
}

// Resolve ranks food candidates for a phrase across three tiers:
// alias (exact normalized) > full-text (tsvector) > embedding (cosine).
// queryVec may be nil to skip the embedding tier.
// userID scopes the alias tier: that user's personal aliases are checked
// first, then curated/global ones. uuid.Nil means global-only.
func (r Repository) Resolve(ctx context.Context, userID uuid.UUID, phrase string, queryVec []float32, limit int) ([]Candidate, error) {
	if limit <= 0 || limit > searchLimitMax {
		limit = searchLimitMax
	}
	norm := Normalize(phrase)
	seen := map[uuid.UUID]bool{}
	var out []Candidate

	add := func(items []FoodItem, tier string, score func(FoodItem) float64) {
		for _, it := range items {
			if seen[it.ID] {
				continue
			}
			seen[it.ID] = true
			out = append(out, Candidate{Item: it, MatchScore: score(it), MatchTier: tier})
		}
	}

	// Tier 1: alias exact match, personal before global. Aliases are stored
	// verbatim (see idx_food_aliases_unique ON food_aliases (user_id,
	// lower(alias))), so this compares on case/whitespace only — NOT the
	// fully Normalize()'d form, which also strips punctuation and
	// singularizes and would falsely miss aliases like "brekkie eggs" when
	// queried as "brekkie eggs".
	//
	// Personal rows are added first so that when the same phrase is aliased
	// both personally and globally, `seen` keeps the personal one and drops
	// the global duplicate. Both score 1.0: within the alias tier, order
	// carries the precedence, not the score.
	aliasKey := strings.ToLower(strings.TrimSpace(phrase))
	if userID != uuid.Nil {
		var personalItems []FoodItem
		// No ORDER BY here: idx_food_aliases_unique ON food_aliases (user_id,
		// lower(alias)) guarantees at most one personal row can ever match
		// this (user_id, lower(alias)) pair, so there is nothing for an
		// ordering to disambiguate — LIMIT only ever bounds a result of 0 or 1
		// rows.
		if err := r.db.WithContext(ctx).
			Raw(`SELECT fi.* FROM food_items fi
			     JOIN food_aliases fa ON fa.food_item_id = fi.id
			     WHERE fa.user_id = ? AND lower(fa.alias) = ?
			     LIMIT ?`, userID, aliasKey, limit).
			Scan(&personalItems).Error; err != nil {
			return nil, fmt.Errorf("nutrition: resolve personal alias: %w", err)
		}
		add(personalItems, MatchAlias, func(FoodItem) float64 { return 1.0 })
	}
	var aliasItems []FoodItem
	// ORDER BY fa.created_at DESC, fa.id DESC: unlike the personal query
	// above, global rows (user_id IS NULL) are NOT deduped by
	// idx_food_aliases_unique — Postgres treats NULL as distinct from NULL in
	// a unique index, so more than one global alias row can exist for the
	// same lower(alias). This ordering keeps the result deterministic
	// (newest alias wins) rather than dependent on Postgres's physical row
	// order, which is unspecified and has been observed to return a stale
	// alias ahead of a newer one.
	if err := r.db.WithContext(ctx).
		Raw(`SELECT fi.* FROM food_items fi
		     JOIN food_aliases fa ON fa.food_item_id = fi.id
		     WHERE fa.user_id IS NULL AND lower(fa.alias) = ?
		     ORDER BY fa.created_at DESC, fa.id DESC LIMIT ?`, aliasKey, limit).
		Scan(&aliasItems).Error; err != nil {
		return nil, fmt.Errorf("nutrition: resolve alias: %w", err)
	}
	add(aliasItems, MatchAlias, func(FoodItem) float64 { return 1.0 })

	// Tier 2: full-text on normalized_name. Both sides must go through
	// Normalize (which singularizes, e.g. "oats" -> "oat") so a plural query
	// matches a plural document name: fi.name is stored verbatim, but
	// normalized_name is Normalize(name) on both Insert and
	// BackfillNormalizedNames, so comparing norm against normalized_name
	// keeps the two sides in the same normalized form.
	type ftRow struct {
		FoodItem
		Rank float64 `gorm:"column:rank"`
	}
	var ftRows []ftRow
	if err := r.db.WithContext(ctx).
		Raw(`SELECT fi.*, ts_rank(to_tsvector('simple', fi.normalized_name), plainto_tsquery('simple', ?)) AS rank
		     FROM food_items fi
		     WHERE to_tsvector('simple', fi.normalized_name) @@ plainto_tsquery('simple', ?)
		     ORDER BY rank DESC LIMIT ?`, norm, norm, limit).
		Scan(&ftRows).Error; err != nil {
		return nil, fmt.Errorf("nutrition: resolve fulltext: %w", err)
	}
	// Normalize ts_rank (unbounded, typically < 1) into 0..1 via rank/(rank+1), capped below alias.
	for _, row := range ftRows {
		if seen[row.FoodItem.ID] {
			continue
		}
		seen[row.FoodItem.ID] = true
		s := row.Rank / (row.Rank + 1)
		out = append(out, Candidate{Item: row.FoodItem, MatchScore: 0.7 + 0.29*s, MatchTier: MatchFullText})
	}

	// Tier 3: embedding cosine (optional).
	if queryVec != nil {
		type embRow struct {
			FoodItem
			Distance float64 `gorm:"column:distance"`
		}
		var embRows []embRow
		if err := r.db.WithContext(ctx).
			Raw(`SELECT fi.*, (fi.embedding <=> ?) AS distance
			     FROM food_items fi
			     WHERE fi.embedding IS NOT NULL
			     ORDER BY distance ASC LIMIT ?`, pgvector.NewVector(queryVec), limit).
			Scan(&embRows).Error; err != nil {
			return nil, fmt.Errorf("nutrition: resolve embedding: %w", err)
		}
		for _, row := range embRows {
			if seen[row.FoodItem.ID] {
				continue
			}
			seen[row.FoodItem.ID] = true
			sim := math.Max(0, 1-row.Distance) // cosine distance → similarity
			out = append(out, Candidate{Item: row.FoodItem, MatchScore: sim * 0.7, MatchTier: MatchEmbedding})
		}
	}

	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// RowsMissingEmbedding returns food items with no embedding yet (up to limit),
// oldest-created first, for use by the embedding backfill command.
func (r Repository) RowsMissingEmbedding(ctx context.Context, limit int) ([]FoodItem, error) {
	var items []FoodItem
	err := r.db.WithContext(ctx).Raw(
		`SELECT * FROM food_items WHERE embedding IS NULL ORDER BY created_at LIMIT ?`, limit).
		Scan(&items).Error
	if err != nil {
		return nil, fmt.Errorf("nutrition: rows missing embedding: %w", err)
	}
	return items, nil
}

// SetEmbedding stores the 768-dim embedding for a food item.
func (r Repository) SetEmbedding(ctx context.Context, id uuid.UUID, vec []float32) error {
	if err := r.db.WithContext(ctx).Exec(
		`UPDATE food_items SET embedding = ? WHERE id = ?`, pgvector.NewVector(vec), id).Error; err != nil {
		return fmt.Errorf("nutrition: set embedding: %w", err)
	}
	return nil
}

// BackfillNormalizedNames recomputes normalized_name for every row using the
// Go Normalize function (the migration's SQL backfill is only approximate).
func (r Repository) BackfillNormalizedNames(ctx context.Context) (int, error) {
	var items []FoodItem
	if err := r.db.WithContext(ctx).Find(&items).Error; err != nil {
		return 0, fmt.Errorf("nutrition: backfill load: %w", err)
	}
	updated := 0
	for _, it := range items {
		norm := Normalize(it.Name)
		if norm == it.NormalizedName {
			continue
		}
		if err := r.db.WithContext(ctx).Model(&FoodItem{}).
			Where("id = ?", it.ID).Update("normalized_name", norm).Error; err != nil {
			return updated, fmt.Errorf("nutrition: backfill update: %w", err)
		}
		updated++
	}
	return updated, nil
}
