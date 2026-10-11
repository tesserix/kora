package export

import (
	"fmt"
	"os"
	"regexp"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func schemaDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	require.NoError(t, err)
	return db
}

type fkRef struct {
	Table  string `gorm:"column:table_name"`
	Column string `gorm:"column:column_name"`
}

// userReferences reads every foreign key pointing at users(id).
//
// This is the authority, and it is deliberately read from the DATABASE rather
// than from a list in Go. A list in Go is the thing that goes stale; the
// schema cannot, because a migration is what creates the obligation in the
// first place.
func userReferences(t *testing.T, db *gorm.DB) []fkRef {
	t.Helper()
	var refs []fkRef
	require.NoError(t, db.Raw(`
		SELECT tc.table_name, kcu.column_name
		FROM information_schema.table_constraints tc
		JOIN information_schema.key_column_usage kcu
		  ON kcu.constraint_name = tc.constraint_name
		JOIN information_schema.constraint_column_usage ccu
		  ON ccu.constraint_name = tc.constraint_name
		WHERE tc.constraint_type = 'FOREIGN KEY'
		  AND ccu.table_name = 'users' AND ccu.column_name = 'id'
		ORDER BY 1, 2`).Scan(&refs).Error)

	require.NotEmpty(t, refs,
		"no foreign keys to users(id) found — the query is wrong, and a broken "+
			"query here would make this whole suite pass vacuously")
	return refs
}

// mentions reports whether a scope clause references this exact column.
//
// Word-bounded on purpose. A substring check would let `member_user_id = ?`
// satisfy an obligation to export a column called `user_id`, which is exactly
// the kind of near-miss this test exists to catch.
func mentions(where, column string) bool {
	return regexp.MustCompile(`\b` + regexp.QuoteMeta(column) + `\b`).MatchString(where)
}

// TestEveryUserScopedTableIsExportedOrExcluded is the guarantee this package
// is built around.
//
// Deletion gets completeness free from ON DELETE CASCADE. An export has to
// name things, so a table added later is invisible to it — and an export
// missing a table looks exactly like a working export. This test converts
// that silence into a red build: add a user-scoped table, and until you
// either export it or write down why not, this fails and names it.
func TestEveryUserScopedTableIsExportedOrExcluded(t *testing.T) {
	db := schemaDB(t)

	exported := make(map[string][]Table, len(Tables))
	for _, tbl := range Tables {
		exported[tbl.Name] = append(exported[tbl.Name], tbl)
	}
	excluded := make(map[string]ExcludedColumn, len(ExcludedColumns))
	for _, e := range ExcludedColumns {
		excluded[e.Table+"."+e.Column] = e
	}

	for _, ref := range userReferences(t, db) {
		key := ref.Table + "." + ref.Column
		t.Run(key, func(t *testing.T) {
			if e, ok := excluded[key]; ok {
				assert.NotEmpty(t, e.Reason,
					"an exclusion without a reason is indistinguishable from an oversight")
				return
			}

			tbls, ok := exported[ref.Table]
			require.True(t, ok, "%s references users(id) but is neither exported "+
				"(export.Tables) nor excluded (export.ExcludedColumns)", key)

			covered := false
			for _, tbl := range tbls {
				if mentions(tbl.Where, ref.Column) {
					covered = true
				}
			}
			assert.True(t, covered,
				"%s is exported, but its scope clause (%q) never mentions %s — "+
					"so those rows are filtered by a different column and this "+
					"reference is silently unexported",
				ref.Table, tbls[0].Where, ref.Column)
		})
	}
}

// TestEveryExportedTableExistsInTheSchema is the reverse direction: a typo, or
// a table dropped by a migration, must not survive as a query that fails only
// when a real user asks for their data.
func TestEveryExportedTableExistsInTheSchema(t *testing.T) {
	db := schemaDB(t)

	var names []string
	require.NoError(t, db.Raw(`
		SELECT table_name FROM information_schema.tables
		WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`).Scan(&names).Error)

	exists := make(map[string]struct{}, len(names))
	for _, n := range names {
		exists[n] = struct{}{}
	}

	for _, tbl := range Tables {
		_, ok := exists[tbl.Name]
		assert.True(t, ok, "export.Tables names %q, which is not a table", tbl.Name)
	}
}

// TestEveryExportedTableActuallyRuns catches a scope clause that references a
// column the table does not have — a `through` whose foreign key was renamed,
// say. Without this, the first person to find out is a user whose export 500s.
func TestEveryExportedTableActuallyRuns(t *testing.T) {
	db := schemaDB(t)

	for _, tbl := range Tables {
		t.Run(tbl.Name, func(t *testing.T) {
			args := make([]any, tbl.Args)
			for i := range args {
				args[i] = "00000000-0000-0000-0000-000000000000"
			}
			var rows []map[string]any
			err := db.Table(tbl.Name).Where(tbl.Where, args...).Find(&rows).Error
			assert.NoError(t, err, "scope clause %q does not run against %s", tbl.Where, tbl.Name)
		})
	}
}

// TestScopeClausePlaceholderCountMatchesArgs — a clause naming the user twice
// (friendships) bound once would export half the rows, and the half that
// vanished would leave no trace. Checked by counting rather than by trusting
// the two fields to have been edited together.
func TestScopeClausePlaceholderCountMatchesArgs(t *testing.T) {
	for _, tbl := range Tables {
		want := 0
		for _, r := range tbl.Where {
			if r == '?' {
				want++
			}
		}
		assert.Equal(t, want, tbl.Args,
			"%s: Where has %d placeholders but Args says %d", tbl.Name, want, tbl.Args)
	}
}

// TestRedactedColumnsExist stops a redaction from silently becoming a no-op.
//
// If `users.apple_refresh_token` were renamed, the redaction rule would match
// nothing, the column would start appearing in exports, and the Redacted list
// would still promise it had been withheld. That is worse than never having
// redacted it, because the file would assert something untrue.
func TestRedactedColumnsExist(t *testing.T) {
	db := schemaDB(t)

	for _, r := range RedactedColumns {
		t.Run(r.Table+"."+r.Column, func(t *testing.T) {
			var n int64
			require.NoError(t, db.Raw(`
				SELECT count(*) FROM information_schema.columns
				WHERE table_schema='public' AND table_name=? AND column_name=?`,
				r.Table, r.Column).Scan(&n).Error)

			assert.Equal(t, int64(1), n,
				"%s.%s is declared redacted but does not exist — the rule matches "+
					"nothing while the export still claims the value was withheld",
				r.Table, r.Column)
			assert.NotEmpty(t, r.Reason)
		})
	}
}

// TestRedactedColumnsBelongToExportedTables — redacting a column of a table
// nobody exports is a rule that can never fire, and reads in the export's
// own Redacted list as a promise about data that was never there.
func TestRedactedColumnsBelongToExportedTables(t *testing.T) {
	exported := make(map[string]struct{}, len(Tables))
	for _, tbl := range Tables {
		exported[tbl.Name] = struct{}{}
	}
	for _, r := range RedactedColumns {
		_, ok := exported[r.Table]
		assert.True(t, ok, "%s.%s is redacted, but %s is not exported at all",
			r.Table, r.Column, r.Table)
	}
}

// TestTablesHaveNoDuplicates — a table listed twice would export its rows
// twice, and the count would be right for neither.
func TestTablesHaveNoDuplicates(t *testing.T) {
	seen := make(map[string]struct{}, len(Tables))
	for _, tbl := range Tables {
		_, dup := seen[tbl.Name]
		assert.False(t, dup, "export.Tables lists %s more than once", tbl.Name)
		seen[tbl.Name] = struct{}{}
	}
}

// TestUserScopedTableCountIsWhatWeThink is a canary on the query itself.
//
// It is a soft floor, not a pin: it fails only if the FK count DROPS below
// what existed when this was written, which means either a migration removed
// user-scoped tables (worth noticing deliberately) or the introspection query
// silently stopped matching — the failure that would make every test above
// pass while checking nothing.
func TestUserScopedTableCountIsWhatWeThink(t *testing.T) {
	db := schemaDB(t)
	refs := userReferences(t, db)

	const floorAt000057 = 32
	assert.GreaterOrEqual(t, len(refs), floorAt000057,
		fmt.Sprintf("only %d foreign keys to users(id); there were %d at migration 000057. "+
			"Either tables were removed, or the introspection query has stopped "+
			"matching and every completeness assertion above is now vacuous",
			len(refs), floorAt000057))
}
