package nutrition

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// seedAliasUser inserts a bare user row and returns its id.
func seedAliasUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		id, "alias-"+id.String(), "alias@test.dev").Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })
	return id
}

// seedAliasFood inserts a food item and returns it.
func seedAliasFood(t *testing.T, db *gorm.DB, name string) FoodItem {
	t.Helper()
	item := FoodItem{Name: name + " " + uuid.NewString(), Provenance: ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })
	return item
}

func TestPersonalAliasResolvesForItsOwner(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	ctx := context.Background()
	userID := seedAliasUser(t, db)
	quinoa := seedAliasFood(t, db, "Quinoa")
	phrase := "brekkie bowl " + uuid.NewString()

	require.NoError(t, repo.AddAlias(ctx, userID, phrase, quinoa.ID))

	got, err := repo.Resolve(ctx, userID, phrase, nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.Equal(t, quinoa.ID, got[0].Item.ID)
	require.Equal(t, MatchAlias, got[0].MatchTier)
}

func TestPersonalAliasIsInvisibleToOtherUsers(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	ctx := context.Background()
	owner := seedAliasUser(t, db)
	stranger := seedAliasUser(t, db)
	quinoa := seedAliasFood(t, db, "Quinoa")
	phrase := "brekkie bowl " + uuid.NewString()

	require.NoError(t, repo.AddAlias(ctx, owner, phrase, quinoa.ID))

	got, err := repo.Resolve(ctx, stranger, phrase, nil, 5)
	require.NoError(t, err)
	for _, c := range got {
		require.NotEqual(t, quinoa.ID, c.Item.ID,
			"another user's personal alias leaked into this user's resolution")
	}
}

func TestPersonalAliasOutranksGlobalAlias(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	ctx := context.Background()
	userID := seedAliasUser(t, db)
	global := seedAliasFood(t, db, "White Rice")
	personal := seedAliasFood(t, db, "Quinoa")
	phrase := "the usual " + uuid.NewString()

	// uuid.Nil writes a curated/global alias (user_id NULL).
	require.NoError(t, repo.AddAlias(ctx, uuid.Nil, phrase, global.ID))
	require.NoError(t, repo.AddAlias(ctx, userID, phrase, personal.ID))

	got, err := repo.Resolve(ctx, userID, phrase, nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.Equal(t, personal.ID, got[0].Item.ID, "personal alias must be ranked first")
}

func TestAddAliasIsIdempotent(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	ctx := context.Background()
	userID := seedAliasUser(t, db)
	quinoa := seedAliasFood(t, db, "Quinoa")
	phrase := "dupe " + uuid.NewString()

	require.NoError(t, repo.AddAlias(ctx, userID, phrase, quinoa.ID))
	require.NoError(t, repo.AddAlias(ctx, userID, phrase, quinoa.ID))

	var n int64
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND lower(alias) = ?",
		userID, phrase).Scan(&n).Error)
	require.EqualValues(t, 1, n)
}

// TestAddAliasNormalizesCaseAndWhitespaceOnWrite is the finding-3 regression
// test for AddAlias's `key := strings.ToLower(strings.TrimSpace(alias))`
// line. Every other AddAlias call site in this test file already passes an
// alias that is lowercase and trimmed, so nothing exercised the write-side
// normalization until now — mutating that line to `key := alias` still left
// `go test ./internal/nutrition/ -run Alias` green. This test writes with
// surrounding whitespace and mixed case, then resolves with a
// differently-cased/spaced form of the same phrase: if AddAlias stored the
// alias verbatim, the leading/trailing whitespace would survive into
// food_aliases.alias, and Resolve's `lower(fa.alias) = ?` comparison — SQL
// lower() lowercases but does not trim — would never match Resolve's
// trimmed lookup key, so the alias would be unfindable.
func TestAddAliasNormalizesCaseAndWhitespaceOnWrite(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	ctx := context.Background()
	userID := seedAliasUser(t, db)
	quinoa := seedAliasFood(t, db, "Quinoa")
	base := "brekkie bowl " + uuid.NewString()

	require.NoError(t, repo.AddAlias(ctx, userID, "  "+strings.ToUpper(base)+"  ", quinoa.ID))

	got, err := repo.Resolve(ctx, userID, strings.ToLower(base), nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, got, "alias written with whitespace/case must resolve via its normalized form")
	require.Equal(t, quinoa.ID, got[0].Item.ID)
	require.Equal(t, MatchAlias, got[0].MatchTier)
}

// TestAddAliasBlankIsNoOp is the finding-3 regression test for AddAlias's
// `if key == "" { return nil }` guard. A whitespace-only alias must not
// insert a row (and must not error) — verified directly against the table
// rather than through Resolve, since Resolve wouldn't distinguish "no alias
// row" from "alias row present but this lookup key is wrong".
func TestAddAliasBlankIsNoOp(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	ctx := context.Background()
	userID := seedAliasUser(t, db)
	quinoa := seedAliasFood(t, db, "Quinoa")

	require.NoError(t, repo.AddAlias(ctx, userID, "   ", quinoa.ID))

	var n int64
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND food_item_id = ?",
		userID, quinoa.ID).Scan(&n).Error)
	require.EqualValues(t, 0, n, "a blank/whitespace-only alias must not insert a row")
}

func TestRemoveAliasDeletesOnlyTheMatchingRow(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	ctx := context.Background()
	userID := seedAliasUser(t, db)
	other := seedAliasUser(t, db)
	quinoa := seedAliasFood(t, db, "Quinoa")
	rice := seedAliasFood(t, db, "Rice")
	phrase := "retract me " + uuid.NewString()

	require.NoError(t, repo.AddAlias(ctx, userID, phrase, quinoa.ID))
	require.NoError(t, repo.AddAlias(ctx, userID, phrase, rice.ID))
	require.NoError(t, repo.AddAlias(ctx, other, phrase, quinoa.ID))

	require.NoError(t, repo.RemoveAlias(ctx, userID, phrase, quinoa.ID))

	var n int64
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND lower(alias) = ? AND food_item_id = ?",
		userID, phrase, quinoa.ID).Scan(&n).Error)
	require.EqualValues(t, 0, n, "the targeted alias must be gone")

	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND lower(alias) = ? AND food_item_id = ?",
		userID, phrase, rice.ID).Scan(&n).Error)
	require.EqualValues(t, 1, n, "the same user's other alias must survive")

	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND lower(alias) = ?",
		other, phrase).Scan(&n).Error)
	require.EqualValues(t, 1, n, "another user's alias must survive")
}
