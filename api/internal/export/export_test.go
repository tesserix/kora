package export

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// tx opens a transaction and registers its rollback immediately, so it runs on
// Goexit too (a require failure). Every assertion is made against THIS
// transaction, so the shared test database's ambient rows can neither satisfy
// nor defeat one.
func tx(t *testing.T) *gorm.DB {
	t.Helper()
	tx := schemaDB(t).Begin()
	require.NoError(t, tx.Error)
	t.Cleanup(func() { tx.Rollback() })
	return tx
}

func seedUser(t *testing.T, db *gorm.DB, email string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		`INSERT INTO users (id, firebase_uid, email, display_name, apple_refresh_token)
		 VALUES (?, ?, ?, 'Tester', 'apple-refresh-secret')`,
		id, "fb_"+id.String(), email).Error)
	return id
}

func seedFoodLog(t *testing.T, db *gorm.DB, userID uuid.UUID, phrase string) {
	t.Helper()
	require.NoError(t, db.Exec(
		`INSERT INTO food_logs
		   (id, user_id, logged_at, meal_slot, source, quantity_grams,
		    kcal, protein_g, carbs_g, fat_g, provenance, local_date, input_phrase)
		 VALUES (?, ?, now(), 'lunch', 'manual', 100, 200, 10, 20, 5, 'curated', current_date, ?)`,
		uuid.New(), userID, phrase).Error)
}

func seedRecipeWithIngredient(t *testing.T, db *gorm.DB, userID uuid.UUID, name, ingredient string) uuid.UUID {
	t.Helper()
	recipeID := uuid.New()
	require.NoError(t, db.Exec(
		`INSERT INTO recipes (id, user_id, name, servings, source)
		 VALUES (?, ?, ?, 2, 'manual')`, recipeID, userID, name).Error)
	require.NoError(t, db.Exec(
		`INSERT INTO recipe_ingredients (id, recipe_id, position, raw_text)
		 VALUES (?, ?, 1, ?)`, uuid.New(), recipeID, ingredient).Error)
	return recipeID
}

func exportFor(t *testing.T, db *gorm.DB, userID uuid.UUID) Document {
	t.Helper()
	doc, err := NewService(db).ForUser(context.Background(), userID)
	require.NoError(t, err)
	return doc
}

// rowValues pulls one column's values out of an exported table.
func rowValues(doc Document, table, column string) []any {
	out := make([]any, 0, len(doc.Tables[table]))
	for _, row := range doc.Tables[table] {
		out = append(out, row[column])
	}
	return out
}

// TestExportCarriesTheUsersOwnRowsAndNobodyElses is the assertion that
// matters most: an export handed to the wrong person, or carrying someone
// else's rows, is a breach rather than a bug.
func TestExportCarriesTheUsersOwnRowsAndNobodyElses(t *testing.T) {
	db := tx(t)
	mine := seedUser(t, db, "mine-"+uuid.NewString()+"@kora.test")
	theirs := seedUser(t, db, "theirs-"+uuid.NewString()+"@kora.test")

	seedFoodLog(t, db, mine, "my toast")
	seedFoodLog(t, db, theirs, "their toast")

	doc := exportFor(t, db, mine)

	phrases := rowValues(doc, "food_logs", "input_phrase")
	assert.Contains(t, phrases, "my toast")
	assert.NotContains(t, phrases, "their toast")
	assert.Equal(t, 1, doc.Counts["food_logs"])

	// The profile is exactly one row, and it is the right one.
	require.Len(t, doc.Tables["users"], 1)
	assert.Equal(t, mine.String(), fmt.Sprint(doc.Tables["users"][0]["id"]))
}

// TestChildRowsAreScopedThroughTheirParent — recipe_ingredients has no user
// column, so it is scoped by a subquery. If that subquery were dropped, every
// user's ingredients would land in every export, and nothing about the file
// would look wrong.
func TestChildRowsAreScopedThroughTheirParent(t *testing.T) {
	db := tx(t)
	mine := seedUser(t, db, "mine-"+uuid.NewString()+"@kora.test")
	theirs := seedUser(t, db, "theirs-"+uuid.NewString()+"@kora.test")

	seedRecipeWithIngredient(t, db, mine, "My Curry", "my cumin")
	seedRecipeWithIngredient(t, db, theirs, "Their Curry", "their cumin")

	doc := exportFor(t, db, mine)

	texts := rowValues(doc, "recipe_ingredients", "raw_text")
	assert.Contains(t, texts, "my cumin")
	assert.NotContains(t, texts, "their cumin")
	assert.Equal(t, 1, doc.Counts["recipe_ingredients"])
}

// TestFriendshipsExportBothSides — a friendship this user RECEIVED is as much
// a record of their social graph as one they sent. Binding the id once would
// export half of it, and the missing half would leave no trace.
func TestFriendshipsExportBothSides(t *testing.T) {
	db := tx(t)
	mine := seedUser(t, db, "mine-"+uuid.NewString()+"@kora.test")
	sent := seedUser(t, db, "sent-"+uuid.NewString()+"@kora.test")
	received := seedUser(t, db, "recv-"+uuid.NewString()+"@kora.test")
	unrelated := seedUser(t, db, "other-"+uuid.NewString()+"@kora.test")

	insert := func(a, b uuid.UUID) {
		require.NoError(t, db.Exec(
			`INSERT INTO friendships (requester_id, addressee_id, status)
			 VALUES (?, ?, 'accepted')`, a, b).Error)
	}
	insert(mine, sent)     // this user asked
	insert(received, mine) // someone asked this user
	insert(sent, unrelated)

	doc := exportFor(t, db, mine)
	assert.Equal(t, 2, doc.Counts["friendships"],
		"both the sent and the received side must be exported, and nothing else")
}

// TestRedactedValuesAreAbsentAndDeclared — a credential inside an export
// outlives every assumption about where the file went. It is dropped rather
// than nulled, and the Redacted list is how the user learns it existed.
func TestRedactedValuesAreAbsentAndDeclared(t *testing.T) {
	db := tx(t)
	userID := seedUser(t, db, "redact-"+uuid.NewString()+"@kora.test")
	require.NoError(t, db.Exec(
		`INSERT INTO device_tokens (id, user_id, token, platform)
		 VALUES (?, ?, 'ExponentPushToken[secret]', 'ios')`, uuid.New(), userID).Error)

	doc := exportFor(t, db, userID)

	require.Len(t, doc.Tables["users"], 1)
	assert.NotContains(t, doc.Tables["users"][0], "apple_refresh_token")

	require.Len(t, doc.Tables["device_tokens"], 1)
	assert.NotContains(t, doc.Tables["device_tokens"][0], "token")

	// Nothing anywhere in the serialised file carries either secret.
	raw, err := json.Marshal(doc)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "apple-refresh-secret")
	assert.NotContains(t, string(raw), "ExponentPushToken[secret]")

	// ...and the file says so, rather than being quietly incomplete.
	declared := map[string]bool{}
	for _, r := range doc.Redacted {
		declared[r.Table+"."+r.Column] = true
		assert.NotEmpty(t, r.Reason)
	}
	assert.True(t, declared["users.apple_refresh_token"])
	assert.True(t, declared["device_tokens.token"])
}

// TestRedactionIsDeclaredEvenWhenTheRowIsAbsent — the Redacted list describes
// the export's RULES, not this user's data. A reader diffing two exports
// should not see the rules appear and disappear.
func TestRedactionIsDeclaredEvenWhenTheRowIsAbsent(t *testing.T) {
	db := tx(t)
	userID := seedUser(t, db, "norows-"+uuid.NewString()+"@kora.test")

	doc := exportFor(t, db, userID)

	require.Empty(t, doc.Tables["device_tokens"], "no device token was seeded")
	assert.Len(t, doc.Redacted, len(RedactedColumns))
}

// TestEveryTableIsPresentEvenWhenEmpty — "you have none" and "we did not look"
// must not be the same thing in a file any more than in a response body.
func TestEveryTableIsPresentEvenWhenEmpty(t *testing.T) {
	db := tx(t)
	userID := seedUser(t, db, "empty-"+uuid.NewString()+"@kora.test")

	doc := exportFor(t, db, userID)

	for _, tbl := range Tables {
		rows, ok := doc.Tables[tbl.Name]
		assert.True(t, ok, "%s is missing from the export entirely", tbl.Name)
		assert.NotNil(t, rows, "%s must be [] rather than null", tbl.Name)
		_, counted := doc.Counts[tbl.Name]
		assert.True(t, counted, "%s has no count", tbl.Name)
	}
}

// TestEmptyTablesSerialiseAsArraysNotNull — assert on the BYTES. A non-nil
// empty slice and a nil one are both len 0 in Go and only differ once
// encoding/json has run, which is the only place it matters.
//
// Asserted per table rather than over the whole document: a NULL column value
// is legitimate and common (avatar_path, friend_code, onboarded_at), so
// scanning the entire file for ":null" tests the schema's nullability rather
// than this package's behaviour, and fails on a correct export.
func TestEmptyTablesSerialiseAsArraysNotNull(t *testing.T) {
	db := tx(t)
	userID := seedUser(t, db, "arrays-"+uuid.NewString()+"@kora.test")

	doc := exportFor(t, db, userID)
	for _, tbl := range Tables {
		raw, err := json.Marshal(doc.Tables[tbl.Name])
		require.NoError(t, err)
		// An array, empty or not — never null. Checking the first byte covers
		// both the empty case ("[]") and the populated one ("[{…").
		require.NotEmpty(t, raw)
		assert.Equal(t, byte('['), raw[0],
			"%s serialised as %s — a null table defeats a consumer's iteration "+
				"exactly when there is no data", tbl.Name, raw)
	}
}

// TestNewColumnsAppearWithoutCodeChanges is the point of reading rows as maps.
// A typed exporter would compile, pass every other test here, and quietly drop
// the new column — which is the failure this repo has already shipped four
// times across the Go/TypeScript wire.
func TestNewColumnsAppearWithoutCodeChanges(t *testing.T) {
	db := tx(t)
	userID := seedUser(t, db, "newcol-"+uuid.NewString()+"@kora.test")
	seedFoodLog(t, db, userID, "toast")

	require.NoError(t, db.Exec(`ALTER TABLE food_logs ADD COLUMN a_column_added_later TEXT`).Error)
	require.NoError(t, db.Exec(
		`UPDATE food_logs SET a_column_added_later = 'present' WHERE user_id = ?`, userID).Error)

	doc := exportFor(t, db, userID)

	require.Len(t, doc.Tables["food_logs"], 1)
	assert.Equal(t, "present", doc.Tables["food_logs"][0]["a_column_added_later"])
}

// TestCountsMatchTheRowsTheyDescribe — a count that disagrees with its own
// array is worse than no count, because it is the number a reader trusts
// without opening the array.
func TestCountsMatchTheRowsTheyDescribe(t *testing.T) {
	db := tx(t)
	userID := seedUser(t, db, "counts-"+uuid.NewString()+"@kora.test")
	seedFoodLog(t, db, userID, "one")
	seedFoodLog(t, db, userID, "two")

	doc := exportFor(t, db, userID)
	for table, rows := range doc.Tables {
		assert.Equal(t, len(rows), doc.Counts[table], "count disagrees with rows for %s", table)
	}
	assert.Equal(t, 2, doc.Counts["food_logs"])
}

func TestEnvelopeCarriesTheIdentifyingFacts(t *testing.T) {
	db := tx(t)
	userID := seedUser(t, db, "envelope-"+uuid.NewString()+"@kora.test")

	svc := NewService(db)
	svc.now = func() time.Time {
		return time.Date(2026, 8, 26, 12, 0, 0, 0, time.FixedZone("AEST", 10*3600))
	}
	doc, err := svc.ForUser(context.Background(), userID)
	require.NoError(t, err)

	assert.Equal(t, FormatVersion, doc.FormatVersion)
	assert.Equal(t, userID.String(), doc.UserID)
	assert.Equal(t, "2026-08-26T02:00:00Z", doc.ExportedAt, "UTC with offset")
}

// TestJSONColumnsExportAsStructureNotBase64 — Go base64-encodes []byte, so a
// jsonb column would land in the user's file as an opaque blob they could not
// read and could not know was JSON.
func TestJSONColumnsExportAsStructureNotBase64(t *testing.T) {
	assert.Equal(t, json.RawMessage(`{"a":1}`), marshalable([]byte(`{"a":1}`)))
	assert.Equal(t, "not json", marshalable([]byte("not json")))
	assert.Equal(t, 42, marshalable(42))
	assert.Nil(t, marshalable(nil))
}

// TestAFailingTableFailsTheWholeExport — a partial export is
// indistinguishable from a complete one once it is a file on someone's disk.
func TestAFailingTableFailsTheWholeExport(t *testing.T) {
	db := tx(t)
	userID := seedUser(t, db, "fail-"+uuid.NewString()+"@kora.test")

	// Poison the transaction so every subsequent read errors.
	require.Error(t, db.Exec(`SELECT * FROM a_table_that_does_not_exist`).Error)

	_, err := NewService(db).ForUser(context.Background(), userID)
	require.Error(t, err, "a partial document must never be returned")
}
