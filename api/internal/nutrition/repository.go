package nutrition

import (
	"context"
	"fmt"
	"sort"
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

// resolveScanLimit bounds how many ordered candidates the full-text and
// embedding queries fetch for scoring in Resolve, independent of the
// caller's requested limit. The caller's limit is how many results it
// wants back; the scan limit is how many candidates the in-Go ranker gets
// to consider before truncating to that count. Decoupling them matters
// because production calls Resolve with a small limit (5) purely to bound
// the response size — if that same number also bounded the SQL fetch, the
// scorer would only ever see a handful of rows out of a query that can
// match hundreds, and the true best match can be silently excluded from
// scoring entirely. 100 is generous enough to hold the true best row for
// virtually any query while staying cheap to score in Go.
const resolveScanLimit = 100

func (r Repository) Search(ctx context.Context, query string, limit int) ([]FoodItem, error) {
	if limit <= 0 || limit > searchLimitMax {
		limit = searchLimitMax
	}
	pattern := "%" + query + "%"
	var items []FoodItem
	err := r.db.WithContext(ctx).
		Where("deleted_at IS NULL").
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
	if err := r.db.WithContext(ctx).Where("deleted_at IS NULL").First(&item, "id = ?", id).Error; err != nil {
		return FoodItem{}, fmt.Errorf("nutrition: get by id: %w", err)
	}
	return item, nil
}

// NameForID returns a food_items row's name REGARDLESS of retirement status
// (it does not filter deleted_at), or ("", false) if no row with that id
// exists at all. It exists solely so a caller whose filtered lookup
// (GetByID) came back not-found can tell "this id never existed" apart from
// "this food was retired" and surface a diagnosable message — e.g.
// foodlog.Service.CreateBatch naming the unavailable food in its batch
// error, rather than a bare id the user never chose. Do not use this as a
// substitute for GetByID in any path that serves nutrition data to a
// client: it deliberately bypasses the soft-delete filter every other read
// path enforces.
func (r Repository) NameForID(ctx context.Context, id uuid.UUID) (string, bool) {
	var rows []struct{ Name string }
	if err := r.db.WithContext(ctx).
		Raw(`SELECT name FROM food_items WHERE id = ?`, id).
		Scan(&rows).Error; err != nil || len(rows) == 0 {
		return "", false
	}
	return rows[0].Name, true
}

func (r Repository) Count(ctx context.Context) (int64, error) {
	var n int64
	if err := r.db.WithContext(ctx).Model(&FoodItem{}).Where("deleted_at IS NULL").Count(&n).Error; err != nil {
		return 0, fmt.Errorf("nutrition: count: %w", err)
	}
	return n, nil
}

// Insert adds items that are not already present (matched by barcode when
// present, falling back to name+brand for barcodeless items).
//
// DELIBERATE ASYMMETRY: unlike every read path in this package, the two dedup
// counts below (barcode, then name+brand) deliberately do NOT filter out
// soft-deleted rows. A food an admin retires stays counted here on purpose —
// re-ingesting/re-seeding a name that was deliberately retired must remain a
// no-op, not a back-door resurrection of a row someone chose to hide. Do not
// add a `deleted_at IS NULL` predicate to these two counts.
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
			     WHERE fa.user_id = ? AND lower(fa.alias) = ? AND fi.deleted_at IS NULL
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
		     WHERE fa.user_id IS NULL AND lower(fa.alias) = ? AND fi.deleted_at IS NULL
		     ORDER BY fa.created_at DESC, fa.id DESC LIMIT ?`, aliasKey, limit).
		Scan(&aliasItems).Error; err != nil {
		return nil, fmt.Errorf("nutrition: resolve alias: %w", err)
	}
	add(aliasItems, MatchAlias, func(FoodItem) float64 { return 1.0 })

	// Non-alias candidates are pooled and scored comparably, then sorted. A
	// row found by BOTH full-text and embedding contributes its components to
	// one entry rather than appearing twice.
	pool := map[uuid.UUID]*scoredItem{}
	var order []uuid.UUID
	poolAdd := func(it FoodItem) *scoredItem {
		if s, ok := pool[it.ID]; ok {
			return s
		}
		s := &scoredItem{item: it}
		s.comp.Coverage, s.comp.Precision = tokenOverlap(norm, it.NormalizedName)
		pool[it.ID] = s
		order = append(order, it.ID)
		return s
	}

	// Tier 2: full-text on normalized_name. Both sides go through Normalize
	// (which singularizes, e.g. "oats" -> "oat") so a plural query matches a
	// plural document name.
	//
	// ts_rank is NOT used for scoring. With the default normalization flag it
	// ignores document length, and plainto_tsquery ANDs every term, so its
	// value depends only on how many terms the query had — it is identical for
	// every candidate and cannot rank them. The predicate is kept for recall;
	// similarity() supplies the signal.
	type ftRow struct {
		FoodItem
		Trgm float64 `gorm:"column:trgm"`
	}
	var ftRows []ftRow
	// ORDER BY similarity(...) DESC: recall from the tsvector predicate can
	// vastly exceed resolveScanLimit (hundreds of rows for a common word), so
	// if the scan limit ever truncates, it must drop the least similar rows
	// rather than an arbitrary subset of Postgres's unspecified scan order.
	// This reuses the same similarity() expression already computed for the
	// trgm column below — same column, same parameter, so the ordering and
	// the score it feeds are consistent.
	if err := r.db.WithContext(ctx).
		Raw(`SELECT fi.*, similarity(fi.normalized_name, ?) AS trgm
		     FROM food_items fi
		     WHERE to_tsvector('simple', fi.normalized_name) @@ plainto_tsquery('simple', ?)
		     AND fi.deleted_at IS NULL
		     ORDER BY similarity(fi.normalized_name, ?) DESC
		     LIMIT ?`, norm, norm, norm, resolveScanLimit).
		Scan(&ftRows).Error; err != nil {
		return nil, fmt.Errorf("nutrition: resolve fulltext: %w", err)
	}
	for _, row := range ftRows {
		if seen[row.FoodItem.ID] {
			continue
		}
		poolAdd(row.FoodItem).comp.Trigram = row.Trgm
	}

	// Tier 3: embedding cosine (optional). This has always run whenever
	// queryVec != nil; previously its rows were appended after full-text and
	// silently cut by the limit, so the scan was paid for and discarded.
	if queryVec != nil {
		type embRow struct {
			FoodItem
			Distance float64 `gorm:"column:distance"`
			Trgm     float64 `gorm:"column:trgm"`
		}
		var embRows []embRow
		// resolveScanLimit here too: ORDER BY distance ASC is already a
		// meaningful ranking (unlike the full-text case above), but pgvector
		// computes that distance for every embedded row regardless of how
		// many are returned, so fetching more of an already-ranked result is
		// nearly free and gives the Go scorer the same generous pool.
		//
		// similarity() is computed in the OUTER select, over the already
		// ranked/limited "ranked" subquery — not alongside distance in the
		// inner one. Unlike distance, similarity() has no index to lean on;
		// computing it inline with distance would price it in for every
		// embedded row in the table before ORDER BY ... LIMIT discards most
		// of them. Computed out here, it only runs for the resolveScanLimit
		// rows that survive the limit.
		//
		// RECALL TRAP (documented, not yet a bug): the inner ORDER BY distance
		// ASC LIMIT resolveScanLimit is meant to fetch a generous candidate
		// pool, but that guarantee depends on the planner choosing a seq scan
		// over the HNSW index at today's retire ratio. Swept up to a 95%
		// retire ratio at production scale, Postgres still chose a seq scan
		// every time and returned the full 100 rows — so there is no bug
		// today. But forcing the HNSW index at that same 95% ratio returned
		// only 24 of 100: the graph traversal exhausts its internal queue
		// before LIMIT is satisfied, because hnsw.iterative_scan is 'off' (the
		// default) and the index has no way to keep walking past exhausted
		// neighbourhoods to backfill the difference. If food_items grows past
		// the planner's flip point (~40k rows in these measurements) — or if
		// the partial index migration 000023 deliberately deferred is later
		// added — this tier can silently hand the Go scorer a quarter of its
		// intended candidate pool, and it will be exactly the neighbourhoods
		// clustered around retired rows that go missing. Mitigation, if it is
		// ever needed: turn hnsw.iterative_scan on (relaxed_order or
		// strict_order) so the index keeps scanning past exhausted
		// neighbourhoods instead of giving up short of LIMIT. No test guards
		// this — it requires embedded rows and a retire ratio high enough to
		// flip the planner, and both the local and CI databases have zero
		// embedded rows.
		if err := r.db.WithContext(ctx).
			Raw(`SELECT ranked.*, similarity(ranked.normalized_name, ?) AS trgm
			     FROM (
			         SELECT fi.*, (fi.embedding <=> ?) AS distance
			         FROM food_items fi
			         WHERE fi.embedding IS NOT NULL AND fi.deleted_at IS NULL
			         ORDER BY distance ASC LIMIT ?
			     ) ranked`,
				norm, pgvector.NewVector(queryVec), resolveScanLimit).
			Scan(&embRows).Error; err != nil {
			return nil, fmt.Errorf("nutrition: resolve embedding: %w", err)
		}
		for _, row := range embRows {
			if seen[row.FoodItem.ID] {
				continue
			}
			s := poolAdd(row.FoodItem)
			s.comp.Trigram = row.Trgm
			if sim := 1 - row.Distance; sim > 0 {
				s.comp.EmbSim = sim
			}
		}
	}

	// Score, sort, then scale by ambiguity. Sorting uses a rank key that adds
	// headBonus when the candidate's head noun (see headToken) is one of the
	// query's tokens — this is a RANKING signal only. s.score stays the
	// unmodified quality() and is what MatchScore is ultimately derived from,
	// so the head-noun signal can move a row to top-1 without ever inflating
	// its reported confidence.
	qTokens := fieldSet(norm)
	scoredList := make([]*scoredItem, 0, len(order))
	for _, id := range order {
		s := pool[id]
		s.score = quality(s.comp)
		s.rankKey = s.score
		if head := headToken(s.item.Name); head != "" && qTokens[head] {
			s.rankKey += headBonus
		}
		scoredList = append(scoredList, s)
	}
	sort.SliceStable(scoredList, func(i, j int) bool {
		return scoredList[i].rankKey > scoredList[j].rankKey
	})

	// The ambiguity margin is computed from the BASE qualities (not rank keys)
	// of the top two candidates in the now-ranked order, clamped at >= 0.
	// Ranking by rankKey can promote a candidate whose base quality is lower
	// than the one it displaced (that's the whole point of the head-noun
	// signal), so a naive scoredList[0].score - scoredList[1].score can go
	// negative post-reorder. A negative margin must not be interpreted as
	// "more ambiguous than a dead tie" — clamp it at the dead-tie value (0)
	// instead of letting it feed further below.
	//
	// This clamp is deliberately BELT-AND-BRACES and currently unobservable:
	// ambiguityFactor already floors any input below 0 at ambiguityFloor, so
	// removing this would change no output today. It is kept because it makes
	// the intent local ("a reorder cannot mean extra ambiguity") rather than
	// relying on a clamp two functions away. Note there is therefore no test
	// that can distinguish its presence — do not write one and claim it
	// guards this; it would pass either way.
	factor := 1.0
	if len(scoredList) > 1 {
		margin := scoredList[0].score - scoredList[1].score
		if margin < 0 {
			margin = 0
		}
		factor = ambiguityFactor(margin)
	}
	for _, s := range scoredList {
		tier := MatchFullText
		if embeddingFactor*s.comp.EmbSim > lexical(s.comp) {
			tier = MatchEmbedding
		}
		out = append(out, Candidate{
			Item:       s.item,
			MatchScore: s.score * factor,
			MatchTier:  tier,
		})
	}

	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// scoredItem accumulates one candidate's signals across the full-text and
// embedding queries before a single score is computed from them.
type scoredItem struct {
	item    FoodItem
	comp    components
	score   float64 // unmodified quality() — this, scaled by the ambiguity factor, becomes MatchScore
	rankKey float64 // score plus headBonus when applicable — sort order ONLY, never reported
}

// RowsMissingEmbedding returns food items with no embedding yet (up to limit),
// oldest-created first, for use by the embedding backfill command.
//
// deleted_at IS NULL is filtered here for a reason beyond the usual
// read-path consistency: the embedding backfill (cmd/embed) burns against
// Gemini's free tier (~1000 requests/day) and the index is only ~61%
// embedded, so every row this returns spends a scarce daily slot. Ordering
// is oldest-created-first, which means an old retired row that was never
// embedded would sit permanently at the head of this queue, consuming a
// slot on every single run forever (retiring it doesn't change created_at).
// Filtering it out also keeps this worklist in sync with the
// kora_food_index_missing gauge (internal/metrics/foodindex.go), which
// already counts only live rows — without this filter the two would
// describe different sets of "still needs an embedding".
func (r Repository) RowsMissingEmbedding(ctx context.Context, limit int) ([]FoodItem, error) {
	var items []FoodItem
	err := r.db.WithContext(ctx).Raw(
		`SELECT * FROM food_items WHERE embedding IS NULL AND deleted_at IS NULL ORDER BY created_at LIMIT ?`, limit).
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
