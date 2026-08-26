package nutrition

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/units"
)

// TestCuratedParmaAliasResolves proves the curated AU abbreviation actually
// reaches the cooked parmigiana row, end to end through the real alias tier.
//
// The file-shape test in internal/nutrition/ingest cannot show this: it checks
// the entry is well-formed, not that it WORKS. cmd/ingest only warns when an
// alias fails to resolve, so a mistyped target ships silently and the alias
// simply never fires. This pins the exact food name the entry depends on — if
// the AUSNUT row is ever renamed, this fails instead of degrading quietly.
//
// "chicken parma" has ZERO lexical candidates (verified against the production
// index): "parma" shares no token with "parmigiana", so nothing but an alias
// can reach the row.
func TestCuratedParmaAliasResolves(t *testing.T) {
	const target = "Chicken, schnitzel, breadcrumb coating, topped with tomato sauce & cheese (parmigiana)"

	b, err := os.ReadFile(filepath.Join("..", "..", "data", "food", "aliases.json"))
	require.NoError(t, err)
	var curated []GlobalAlias
	require.NoError(t, json.Unmarshal(b, &curated))

	tx := fixtureTx(t)
	repo := NewRepository(tx)
	ctx := context.Background()

	item := FoodItem{
		ID: uuid.New(), Name: target, NormalizedName: Normalize(target),
		Provenance: "ausnut", KcalPer100g: 219, EntityType: EntityTypeGeneric,
	}
	require.NoError(t, tx.Create(&item).Error)

	applied, unresolved, err := repo.UpsertGlobalAliases(ctx, curated)
	require.NoError(t, err)
	require.Positive(t, applied, "no curated alias resolved; unresolved=%v", unresolved)

	// Guard the premise: without the alias there is genuinely nothing to find,
	// so a pass below cannot be coming from lexical matching.
	lexical, err := repo.ResolveQuery(ctx, uuid.Nil, Query{Text: "chicken parmigiana-not-a-word"}, nil, 5)
	require.NoError(t, err)
	require.Empty(t, lexical)

	for _, phrase := range []string{"chicken parma", "chicken parmi", "parmi"} {
		got, err := repo.ResolveQuery(ctx, uuid.Nil, Query{Text: phrase}, nil, 5)
		require.NoError(t, err, phrase)
		require.NotEmpty(t, got, "%q resolved to nothing", phrase)
		require.Equal(t, item.ID, got[0].Item.ID, "%q must resolve to the parmigiana row, got %q", phrase, got[0].Item.Name)
		require.Equal(t, MatchAlias, got[0].MatchTier, "%q must resolve via the alias tier", phrase)
	}
}

// TestCuratedToastAliasResolves pins kora#470.
//
// identify splits "X on toast" into components and emits the bare food "toast".
// That guess returned `French toast, plain` — an egg-battered fried dish — with
// `Prawn toast` at rank 3, because `French toast, plain` heads on the token
// "toast" and collects headBonus, while the correct `Bread, ..., toasted` rows
// score precision 0: "toasted" sits outside the first two comma segments the
// identity is derived from.
//
// Both ranker-side fixes for that shape were measured net-harmful and reverted
// (kora#219), so a curated alias is the sanctioned route. This asserts the
// alias actually fires AND that it beats the French toast row that previously
// won — inserting that row explicitly, so the test fails if the alias is
// removed rather than passing on an empty index.
func TestCuratedToastAliasResolves(t *testing.T) {
	const target = "Bread, white, commercial, toasted"

	b, err := os.ReadFile(filepath.Join("..", "..", "data", "food", "aliases.json"))
	require.NoError(t, err)
	var curated []GlobalAlias
	require.NoError(t, json.Unmarshal(b, &curated))

	tx := fixtureTx(t)
	repo := NewRepository(tx)
	ctx := context.Background()

	bread := FoodItem{
		ID: uuid.New(), Name: target, NormalizedName: Normalize(target),
		Provenance: "ausnut", KcalPer100g: 296.6, EntityType: EntityTypeGeneric,
	}
	// The row that used to win. Without it the test would pass trivially.
	french := FoodItem{
		ID: uuid.New(), Name: "French toast, plain", NormalizedName: Normalize("French toast, plain"),
		Provenance: "ausnut", KcalPer100g: 202, EntityType: EntityTypeGeneric,
	}
	require.NoError(t, tx.Create(&bread).Error)
	require.NoError(t, tx.Create(&french).Error)

	// Guard the premise: without the alias, French toast really does win.
	lexical, err := repo.ResolveQuery(ctx, uuid.Nil, Query{Text: "toast", CookingMethod: "toasted"}, nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, lexical)
	require.Equal(t, french.ID, lexical[0].Item.ID,
		"premise changed: French toast no longer wins the bare query, so this test no longer proves what it claims")

	applied, unresolved, err := repo.UpsertGlobalAliases(ctx, curated)
	require.NoError(t, err)
	require.Positive(t, applied, "no curated alias resolved; unresolved=%v", unresolved)

	got, err := repo.ResolveQuery(ctx, uuid.Nil, Query{Text: "toast", CookingMethod: "toasted"}, nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.Equal(t, bread.ID, got[0].Item.ID, "\"toast\" must resolve to toasted bread, got %q", got[0].Item.Name)
	require.Equal(t, MatchAlias, got[0].MatchTier)
}

// TestCuratedFlatWhiteAliasResolves pins kora#219's last open item.
//
// `flat white` returned `Iced Flat White` (branded) at CONFIRM tier — the wrong
// drink, one tap from being logged. The generic loses because it is the longer
// string and precision, trigram and headBonus all independently favour the
// shorter one; both ranker-side fixes were measured net harmful and reverted,
// so the alias is the sanctioned route.
//
// This test asserts on the row ID, not a name substring, deliberately. #219
// recorded no expectation in the ranking harness precisely because the obvious
// substring "flat white" MATCHES `Iced Flat White` — a scoreboard that lies.
// An ID comparison cannot lie that way.
func TestCuratedFlatWhiteAliasResolves(t *testing.T) {
	const target = "Flat white, full cream milk"

	b, err := os.ReadFile(filepath.Join("..", "..", "data", "food", "aliases.json"))
	require.NoError(t, err)
	var curated []GlobalAlias
	require.NoError(t, json.Unmarshal(b, &curated))

	tx := fixtureTx(t)
	repo := NewRepository(tx)
	ctx := context.Background()

	generic := FoodItem{
		ID: uuid.New(), Name: target, NormalizedName: Normalize(target),
		Provenance: "user_estimate", KcalPer100g: 46, ServingGrams: 240,
		EntityType: EntityTypeGeneric,
	}
	// The row that used to win. Without it the test passes trivially.
	branded := FoodItem{
		ID: uuid.New(), Name: "Iced Flat White", NormalizedName: Normalize("Iced Flat White"),
		Brand: "Pablo&Rusty's", Provenance: "off", KcalPer100g: 50.8, ServingGrams: 240,
		EntityType: EntityTypeBrandedProduct,
	}
	// The better-provenance AUSNUT row, present so the serving-size assertion
	// below actually discriminates: without it in the fixture, pointing the
	// alias here would fail merely because the row is absent, and the test
	// would only LOOK like it checks serving size.
	zeroServing := FoodItem{
		ID:             uuid.New(),
		Name:           "Coffee, flat white/cappuccino/latte, single shot & cow's milk",
		NormalizedName: Normalize("Coffee, flat white/cappuccino/latte, single shot & cow's milk"),
		Provenance:     "ausnut", KcalPer100g: 48, ServingGrams: 0,
		EntityType: EntityTypeGeneric,
	}
	require.NoError(t, tx.Create(&generic).Error)
	require.NoError(t, tx.Create(&branded).Error)
	require.NoError(t, tx.Create(&zeroServing).Error)

	// Guard the premise: without the alias, the branded row really does win.
	before, err := repo.ResolveQuery(ctx, uuid.Nil, Query{Text: "flat white"}, nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, before)
	require.Equal(t, branded.ID, before[0].Item.ID,
		"premise changed: the branded row no longer wins, so this test no longer proves what it claims")

	applied, unresolved, err := repo.UpsertGlobalAliases(ctx, curated)
	require.NoError(t, err)
	require.Positive(t, applied, "no curated alias resolved; unresolved=%v", unresolved)

	got, err := repo.ResolveQuery(ctx, uuid.Nil, Query{Text: "flat white"}, nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.Equal(t, generic.ID, got[0].Item.ID,
		"\"flat white\" must resolve to the generic drink, got %q", got[0].Item.Name)
	require.Equal(t, MatchAlias, got[0].MatchTier)

	// The reason this row was chosen over the better-provenance AUSNUT one: it
	// carries a serving size. A row with serving_grams=0 sends a "1 cup"
	// portion through the 100g default and logs less than half the drink.
	require.Positive(t, got[0].Item.ServingGrams,
		"the alias target must carry a serving size, or the portion falls back to 100g")
}

// TestCuratedAliasesPreferRowsThatCanBePortioned is the general rule the
// `flat white` work turned up, applied to the whole curated set.
//
// An alias resolves at score 1.0 — the auto-log tier — so whatever it points at
// is logged without a human looking. If that row carries no serving
// information, every portion phrase falls through to `defaultPortionGrams`
// (100g) regardless of what the user actually ate. 4,807 of 26,186 rows have
// no serving size, so this is easy to hit by picking on provenance alone.
//
// The check is deliberately WEAK — it warns rather than fails — because 100g is
// a defensible default for some foods (a raw vegetable) and indefensible for
// others (a 240ml drink, a takeaway serve of chips). Judgement belongs with the
// person adding the alias; this test's job is to make sure they SEE it.
//
// It fails only when a target cannot be found at all, which is the silent
// failure mode: cmd/ingest merely warns, so a typo ships and the alias never
// fires.
//
// READ THE WARNINGS AGAINST THE RIGHT INDEX. Serving coverage differs between
// databases — 12,660 of 18,876 rows in dev against 21,379 of 26,186 in prod as
// of 2026-08-27 — so a row that warns here may carry a serving size in
// production, and vice versa. Verify against prod before retargeting an alias
// on the strength of a warning from this test.
func TestCuratedAliasesPreferRowsThatCanBePortioned(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "data", "food", "aliases.json"))
	require.NoError(t, err)
	var curated []GlobalAlias
	require.NoError(t, json.Unmarshal(b, &curated))
	require.NotEmpty(t, curated)

	tx := fixtureTx(t)
	var indexed int64
	require.NoError(t, tx.Raw("SELECT count(*) FROM food_items WHERE deleted_at IS NULL").Scan(&indexed).Error)
	if indexed == 0 {
		t.Skip("no food index in this database; this check reads real rows")
	}

	for _, a := range curated {
		var rows []FoodItem
		require.NoError(t, tx.Raw(
			`SELECT * FROM food_items WHERE name = ? AND COALESCE(brand,'') = '' AND deleted_at IS NULL
			 ORDER BY id LIMIT 1`, a.Food).Scan(&rows).Error)

		require.NotEmpty(t, rows,
			"alias %q names a food that does not exist: %q. cmd/ingest only WARNS about this, so it "+
				"ships and the alias silently never fires.", a.Alias, a.Food)

		item := rows[0]
		// DECODE the units rather than measuring the raw JSON. ServingUnits is
		// json.RawMessage, so an empty list is the two bytes "[]" and a naive
		// len() check is ALWAYS non-zero — this test silently warned about
		// nothing until that was found. Production reads it the same way, via
		// units.DecodeServingUnits in portion.go.
		if item.ServingGrams <= 0 && len(units.DecodeServingUnits(item.ServingUnits)) == 0 {
			t.Logf("NOTE: alias %q -> %q carries no serving size or units, so every portion "+
				"resolves to the flat %.0fg default. Fine for a raw vegetable; wrong for a drink "+
				"or a takeaway serve.", a.Alias, a.Food, 100.0)
		}
	}
}

// TestCuratedKebabAliasResolves pins the AU takeaway staple.
//
// `kebab` returned the OFF row `10 kebabs` — a packaged product, not the thing
// anyone means by the word. Same shape as every other case in this file: the
// branded row is shorter, wins on trigram, and no scoring change reaches it
// (kora#219).
//
// The assertion is on the row ID, and the branded row is inserted so the test
// cannot pass on an empty index.
func TestCuratedKebabAliasResolves(t *testing.T) {
	const target = "Kebab wrap, meat, with salad, takeaway"

	b, err := os.ReadFile(filepath.Join("..", "..", "data", "food", "aliases.json"))
	require.NoError(t, err)
	var curated []GlobalAlias
	require.NoError(t, json.Unmarshal(b, &curated))

	tx := fixtureTx(t)
	repo := NewRepository(tx)
	ctx := context.Background()

	wrap := FoodItem{
		ID: uuid.New(), Name: target, NormalizedName: Normalize(target),
		Provenance: "ausnut", KcalPer100g: 192.2, ServingGrams: 300,
		EntityType: EntityTypeGeneric,
	}
	packaged := FoodItem{
		ID: uuid.New(), Name: "10 kebabs", NormalizedName: Normalize("10 kebabs"),
		Brand: "Zephbrand", Provenance: "off", KcalPer100g: 153.3,
		EntityType: EntityTypeBrandedProduct,
	}
	require.NoError(t, tx.Create(&wrap).Error)
	require.NoError(t, tx.Create(&packaged).Error)

	before, err := repo.ResolveQuery(ctx, uuid.Nil, Query{Text: "kebab"}, nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, before)
	require.Equal(t, packaged.ID, before[0].Item.ID,
		"premise changed: the packaged row no longer wins, so this test no longer proves what it claims")

	applied, unresolved, err := repo.UpsertGlobalAliases(ctx, curated)
	require.NoError(t, err)
	require.Positive(t, applied, "no curated alias resolved; unresolved=%v", unresolved)

	got, err := repo.ResolveQuery(ctx, uuid.Nil, Query{Text: "kebab"}, nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.Equal(t, wrap.ID, got[0].Item.ID, "\"kebab\" must resolve to the wrap, got %q", got[0].Item.Name)
	require.Equal(t, MatchAlias, got[0].MatchTier)
	require.Positive(t, got[0].Item.ServingGrams, "a kebab is not 100g; the target must carry a serving")
}
