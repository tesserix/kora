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

// Embedder generates a vector for a food name. Declared HERE rather than
// imported from package ai because ai imports nutrition — taking the
// dependency the other way would be an import cycle. cmd/api adapts the real
// provider (which also returns a Usage) to this narrower shape.
type Embedder interface {
	Embed(ctx context.Context, text string) ([]float32, error)
}

type Repository struct {
	db       *gorm.DB
	embedder Embedder
}

func NewRepository(db *gorm.DB) Repository {
	return Repository{db: db}
}

// WithEmbedder returns a copy of the repository that embeds a food as soon as
// it is ingested. A nil embedder (the default) simply skips that step, so every
// existing construction site keeps working unchanged.
func (r Repository) WithEmbedder(e Embedder) Repository {
	r.embedder = e
	return r
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
		created.NormalizedIdentity = identityPhrase(item.Name)
		// Derived at write time for the same reason NormalizedName is: it is a
		// function of the row, so a caller must not be able to disagree with
		// the rule. Every bulk source lands here — cmd/ingest, cmd/seed and the
		// OpenFoodFacts cache-on-miss in ResolveBarcode all call Insert.
		created.EntityType = DeriveEntityType(item.Brand, item.Barcode)
		// Unlike EntityType, locale is NOT recomputed here: it is a property of
		// the SOURCE, not of the row's own columns, and the caller may
		// legitimately know better than the provenance rule (au_in_dishes.json
		// carries a per-row locale). Fall back to the rule only when the
		// caller supplied nothing.
		if created.Locale == "" {
			created.Locale = DeriveLocale(item.Provenance)
		}
		if err := r.db.WithContext(ctx).Create(&created).Error; err != nil {
			return inserted, fmt.Errorf("nutrition: insert: %w", err)
		}
		inserted++
	}
	return inserted, nil
}

// Query is a structured food query: what the user asked for, with the parts
// that mean different things kept apart.
//
// It exists because a flat string cannot express "the user named a brand".
// identify produces this shape (kora#212 Phase 3, ai.Guess), and collapsing it
// back into one string here would discard the same information the phase was
// created to preserve. Declared in this package rather than taking ai.Guess
// directly because ai imports nutrition — the dependency cannot run both ways.
type Query struct {
	// Text is the food core, e.g. "chicken".
	Text string
	// Brand is the brand the user named, empty when they named none. Empty is
	// a meaningful state, not missing data: it is what marks a query as
	// unqualified for the generic-preference policy.
	Brand string
	// Qualifiers narrow which variant is meant, e.g. ["charcoal"].
	Qualifiers []string
	// CookingMethod is how the food was prepared, as identify reported it
	// ("grilled", "fried", "raw"). It was being thrown away: ai.Guess has
	// carried it all along and the resolver never received it, so "grilled
	// barramundi" competed against `Barramundi, raw` with nothing to separate
	// them. Nobody logs raw fish.
	CookingMethod string
	// Locale is the user's food culture (kora#212 Phase 4), empty when unknown.
	// It only ever boosts matching rows — never filters — because an
	// Australian user eating Indian food is the normal case here.
	Locale Locale
}

// Resolve ranks food candidates for a plain phrase. It is the unstructured
// entry point, equivalent to a Query carrying no brand and no qualifiers, and
// is kept because most callers (barcode paths, admin search, the recipe
// importer) genuinely have nothing but a string.
//
// A caller that HAS a structured guess should use ResolveQuery instead:
// flattening it here throws away the brand, and no downstream scoring can get
// it back.
func (r Repository) Resolve(ctx context.Context, userID uuid.UUID, phrase string, queryVec []float32, limit int) ([]Candidate, error) {
	return r.ResolveQuery(ctx, userID, Query{Text: phrase}, queryVec, limit)
}

// ResolveQuery ranks food candidates for a structured query across three
// tiers: alias (exact normalized) > full-text (tsvector) > embedding (cosine).
// queryVec may be nil to skip the embedding tier.
// userID scopes the alias tier: that user's personal aliases are checked
// first, then curated/global ones. uuid.Nil means global-only.
func (r Repository) ResolveQuery(ctx context.Context, userID uuid.UUID, q Query, queryVec []float32, limit int) ([]Candidate, error) {
	phrase := q.Text
	if limit <= 0 || limit > searchLimitMax {
		limit = searchLimitMax
	}
	// The ALIAS tier keys off the user's plain phrase, so it must not see the
	// qualifiers — aliases are stored as the exact words someone typed, and
	// appending anything makes every lookup miss.
	//
	// Retrieval and scoring use the qualified form (kora#212 Phase 3). This is
	// the half of the phase that does the work: without it, splitting "Coke
	// Zero" into food "cola" + brand "Coca-Cola" makes the search term STRICTLY
	// WEAKER than the flat string it replaced, and a row literally named "Cola"
	// scores a perfect 1.0 and wins. Searching "cola zero sugar" instead puts
	// coverage behind the words that actually distinguish the product.
	norm := Normalize(phrase)
	searchNorm := Normalize(strings.TrimSpace(phrase + " " + strings.Join(q.Qualifiers, " ")))
	if searchNorm == "" {
		searchNorm = norm
	}
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
	//
	// They are stamped with DIFFERENT tiers, though — MatchPersonalAlias vs
	// MatchAlias — because the score alone cannot tell the two apart
	// downstream, and one of them (the user's own correction) is trusted
	// enough to be exempt from ai's phrase-reduction damping while the other
	// is not. See the MatchPersonalAlias doc comment in model.go.
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
		add(personalItems, MatchPersonalAlias, func(FoodItem) float64 { return 1.0 })
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
		s.comp.Coverage, s.comp.Precision = tokenOverlap(searchNorm, it.NormalizedName, identityPhrase(it.Name))
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
		     -- RECALL uses the CORE text only, never the qualified form.
		     -- plainto_tsquery ANDs its terms, so folding qualifiers in here
		     -- makes them mandatory: "chicken" with the qualifier "half"
		     -- became the query "chicken half", no row contains both, and
		     -- kora#184's own case returned ZERO candidates. Qualifiers are a
		     -- RANKING signal — they are still in searchNorm below, which
		     -- feeds similarity() and the coverage/precision scoring.
		     WHERE to_tsvector('simple', fi.normalized_name) @@ plainto_tsquery('simple', ?)
		     AND fi.deleted_at IS NULL
		     -- fi.id is a TIEBREAKER, not a preference. similarity() produces
		     -- large ties (every "Corn Chips" row scores identically), and with
		     -- no second key Postgres returns them in heap order — so ANY
		     -- migration that rewrites rows silently reshuffles results. That
		     -- made the ranking harness report phantom changes three separate
		     -- times (the IFCT ingest, the USDA brand backfill, and the locale
		     -- migration), each needing a manual check that the score multiset
		     -- was unchanged before the real diff could be read. Ordering ties
		     -- by id costs nothing and makes the whole pipeline deterministic,
		     -- since the Go ranker below sorts stably.
		     ORDER BY similarity(fi.normalized_name, ?) DESC, fi.id
		     -- searchNorm ranks (similarity), norm recalls (tsquery).
		     LIMIT ?`, searchNorm, norm, searchNorm, resolveScanLimit).
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
			         -- id tiebreaks equal distances, for the same determinism
			         -- reason as the full-text query above.
			         ORDER BY distance ASC, id LIMIT ?
			     ) ranked`,
				searchNorm, pgvector.NewVector(queryVec), resolveScanLimit).
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
	qTokens := fieldSet(searchNorm)
	scoredList := make([]*scoredItem, 0, len(order))
	for _, id := range order {
		scoredList = append(scoredList, pool[id])
	}

	// kora#212's retrieval policy. An unqualified query prefers generic
	// reference data; a query that names a brand turns that preference off and
	// rewards rows of the brand actually named.
	//
	// Phase 3 changes where "did the user name a brand" comes from. Phase 2 had
	// to INFER it by matching query tokens against candidate brands, because a
	// flat phrase was all the resolver received. A structured Query states it,
	// so when q.Brand is set the inference is skipped entirely — it exists now
	// only for the plain-string Resolve path, which still has nothing better.
	namedBrand := strings.TrimSpace(q.Brand)
	wantBrand := Normalize(namedBrand)

	// Whether the named brand is actually IN this index, not merely named.
	//
	// The distinction matters more than it looks. Turning the generic
	// preference off on the mere mention of a brand is wrong when we do not
	// stock it: nothing then earns the brand bonus either, so the only effect
	// is that generics lose their preference and arbitrary OTHER brands float
	// up. Measured on "El Janah 1/2 chicken with Chips", whose brand has no
	// rows at all: the generic `Banana chip` was displaced by `Corn Chips`
	// (Woolworths) — a branded row for a brand the user did not name, which is
	// worse than either policy on its own.
	//
	// So the preference is disabled only when the brand is present to compete.
	// Naming a brand we do not carry leaves the query effectively unqualified,
	// and a generic is the honest fallback.
	brandPresent := false
	if wantBrand != "" {
		for _, s := range scoredList {
			if brandMatches(wantBrand, s.item.Brand) {
				brandPresent = true
				break
			}
		}
	}
	// The token-matching inference is for the plain-string Resolve path only.
	// Once identify has stated the brand, re-deriving it from the phrase can
	// only disagree with the better source.
	brandNamed := brandPresent
	if namedBrand == "" {
		brandNamed = queryNamesABrand(qTokens, scoredList)
	}
	preferGenerics := !brandNamed
	method := Normalize(strings.TrimSpace(q.CookingMethod))

	for _, s := range scoredList {
		s.score = quality(s.comp)
		s.rankKey = s.score
		if head := headToken(s.item.Name); head != "" && qTokens[head] {
			s.rankKey += headBonus
		}
		// Stated about what the row IS (entity_type, kora#213), not inferred
		// from how its name looks — which is the whole point of Phase 1 having
		// landed first. Note this REWARDS generics rather than penalising
		// branded rows: same ordering effect, but nothing is ever subtracted,
		// so a row's rankKey can never fall below its own quality.
		if preferGenerics && s.item.EntityType == EntityTypeGeneric {
			s.rankKey += genericBonus
		}
		// The user named a brand and this row is that brand. Rewarding the
		// match rather than filtering out everything else is deliberate: a
		// hard filter returns NOTHING when the named brand is absent from the
		// index — which is the common case, since El Janah and most local
		// takeaways have no rows at all — and an empty candidate set is a
		// worse answer than a ranked generic one the user can correct.
		// Matching rows still win comfortably when they exist, which since
		// kora#217 includes the 310 USDA chain rows that finally carry a brand.
		if brandNamed && wantBrand != "" && brandMatches(wantBrand, s.item.Brand) {
			s.rankKey += brandMatchBonus
		}
		// Locale preference. Both sides must be known: an unknown user locale
		// must not favour unknown-locale rows, which would quietly promote
		// user estimates over reference data for every user whose timezone we
		// do not map.
		if q.Locale != LocaleUnknown && s.item.Locale == q.Locale {
			s.rankKey += localeBonus
		}
		// Reward a row prepared the way the user said. Like every other signal
		// here this only ever ADDS, so a raw row is never pushed below its own
		// quality — it simply stops collecting a bonus the cooked row earns.
		// That asymmetry matters: when no method is stated, nothing changes.
		if method != "" && strings.Contains(Normalize(s.item.Name), method) {
			s.rankKey += cookingMethodBonus
		}
	}
	sort.SliceStable(scoredList, func(i, j int) bool {
		return scoredList[i].rankKey > scoredList[j].rankKey
	})

	// The ambiguity margin comes from the two highest BASE qualities in the
	// pool, found independently of the ranked order — see ambiguityMargin for
	// the invariant and a worked example.
	//
	// It deliberately does NOT read scoredList[0] and scoredList[1]. Doing that
	// let any ranking-only bonus substitute a weaker row into second place and
	// widen the gap, so demoting a rival could RAISE the survivor's confidence.
	// That is the mechanism that promoted an arbitrary branded milk to `auto`
	// on the parked feat/184 branch, and it was latent here via headBonus.
	factor := ambiguityFactorFor(scoredList)
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
//
// DELIBERATE ASYMMETRY: unlike every read path in this package, this
// maintenance backfill deliberately does NOT filter out soft-deleted rows.
// A retired food's normalized_name should be kept current so that if the food
// is ever restored, its data is correct rather than stale. Do not add a
// `deleted_at IS NULL` predicate to the Find call.
func (r Repository) BackfillNormalizedNames(ctx context.Context) (int, error) {
	var items []FoodItem
	if err := r.db.WithContext(ctx).Find(&items).Error; err != nil {
		return 0, fmt.Errorf("nutrition: backfill load: %w", err)
	}
	updated := 0
	for _, it := range items {
		norm := Normalize(it.Name)
		// normalized_identity (kora#219) is recomputed in the same pass: it is
		// derived from the same source string, and a row whose name is current
		// but whose identity is empty would otherwise never be filled in.
		identity := identityPhrase(it.Name)
		if norm == it.NormalizedName && identity == it.NormalizedIdentity {
			continue
		}
		if err := r.db.WithContext(ctx).Model(&FoodItem{}).
			Where("id = ?", it.ID).
			Updates(map[string]any{"normalized_name": norm, "normalized_identity": identity}).Error; err != nil {
			return updated, fmt.Errorf("nutrition: backfill update: %w", err)
		}
		updated++
	}
	return updated, nil
}

// BackfillLocales fills in the locale of rows that are already in the index and
// have none, using the locale the source file states for them.
//
// Needed because migration 000035 can only set what provenance derives, and the
// curated file is deliberately mixed — 46 Indian dishes and 15 Australian ones
// under one provenance. Those rows come out of the migration with an empty
// locale, and Insert skips them on re-ingest (they already exist), so nothing
// else would ever fill them in.
//
// Only ever writes over an EMPTY locale. A row that already has one was either
// derived correctly by the migration or set deliberately, and this must not
// second-guess it — which also makes a second run a no-op.
func (r Repository) BackfillLocales(ctx context.Context, items []FoodItem) (int, error) {
	updated := 0
	for _, item := range items {
		if item.Locale == "" {
			continue
		}
		res := r.db.WithContext(ctx).Model(&FoodItem{}).
			Where("name = ? AND brand = ? AND COALESCE(locale, '') = ''", item.Name, item.Brand).
			Update("locale", item.Locale)
		if res.Error != nil {
			return updated, fmt.Errorf("nutrition: backfill locales: %w", res.Error)
		}
		updated += int(res.RowsAffected)
	}
	return updated, nil
}

// BackfillUSDAEmbeddedBrands moves a brand that USDA wrote into the name of an
// ALREADY-INGESTED row into the brand column, and retypes the row.
//
// This is the other half of the loader change in ingest.LoadFile, and skipping
// it does active harm rather than merely leaving work undone: ingest matches
// existing rows on name+brand, so once the loader starts emitting
// ("FILET-O-FISH", "McDONALD'S") while the table still holds
// ("McDONALD'S, FILET-O-FISH", ""), the next run stops recognising them and
// inserts 310 DUPLICATES instead of updating anything.
//
// Rewriting `name` also invalidates `normalized_name`, which is what the
// full-text tier matches on, so it is recomputed in the same update rather
// than left to a separate BackfillNormalizedNames pass a caller might forget.
// EntityType is recomputed through the ordinary DeriveEntityType, which needs
// no change to start returning branded_product now that the brand column is
// populated — that is the whole point of doing this at the data layer instead
// of teaching the derivation about name shapes (kora#212).
//
// Scoped to USDA rows with an empty brand, so a second run is a no-op.
func (r Repository) BackfillUSDAEmbeddedBrands(ctx context.Context) (int, error) {
	var items []FoodItem
	if err := r.db.WithContext(ctx).
		Where("provenance = ? AND (brand IS NULL OR brand = '')", ProvenanceUSDA).
		Find(&items).Error; err != nil {
		return 0, fmt.Errorf("nutrition: backfill usda brands load: %w", err)
	}
	updated := 0
	for _, it := range items {
		brand, rest := SplitEmbeddedBrand(it.Name)
		if brand == "" {
			continue
		}
		if err := r.db.WithContext(ctx).Model(&FoodItem{}).
			Where("id = ?", it.ID).
			Updates(map[string]any{
				"name":            rest,
				"brand":           brand,
				"normalized_name": Normalize(rest),
				"entity_type":     DeriveEntityType(brand, it.Barcode),
			}).Error; err != nil {
			return updated, fmt.Errorf("nutrition: backfill usda brands update: %w", err)
		}
		updated++
	}
	return updated, nil
}
