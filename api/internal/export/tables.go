// Package export produces a complete copy of one user's data, for
// GET /v1/me/export (#24, spec §20).
//
// # The failure mode this package is built against
//
// It is not size. It is COMPLETENESS. An export that silently omits a table
// added six months from now is worse than no export, because it looks like it
// worked — the user gets a plausible file, and neither they nor we can tell
// that their fasting history is missing from it.
//
// Account deletion does not have this problem: it delegates to the schema's
// own ON DELETE CASCADE, so a new user-scoped table is covered the moment it
// is created. An exporter cannot delegate — it has to name things. So two
// mechanisms stand in for that guarantee:
//
//   - **Rows are read as maps, via SELECT *.** No Go struct mirrors any
//     table, so a column added to food_logs appears in the export with no
//     code change. This repo has already shipped four instances of "the Go
//     projection gained a field and the consumer's type never declared it";
//     a typed exporter would be the fifth, and the one nobody would ever
//     notice.
//   - **Every table with a foreign key to users(id) must be accounted for.**
//     `TestEveryUserScopedTableIsExportedOrExcluded` reads the live schema's
//     foreign keys and fails if a (table, column) pair is neither exported
//     nor explicitly excluded with a reason. Adding a user-scoped table
//     without touching this file is a red build, not a silent gap.
package export

import "fmt"

// Table is one table's contribution to an export.
type Table struct {
	// Name is the SQL table. It is a compile-time constant from this file,
	// never request input, so interpolating it carries nothing to inject.
	Name string
	// Where scopes the table to one user. Every `?` binds the SAME user id;
	// Args reports how many, so a clause that names the user twice (see
	// friendships) cannot be bound once by mistake.
	Where string
	// Args is the number of `?` placeholders in Where.
	Args int
	// Note explains a scope that is not simply "this user's rows". Empty for
	// the ordinary case.
	Note string
}

// owned is the common case: a table with a user_id column.
func owned(name string) Table {
	return Table{Name: name, Where: "user_id = ?", Args: 1}
}

// by scopes a table whose owner column is not called user_id.
func by(name, column string) Table {
	return Table{Name: name, Where: column + " = ?", Args: 1}
}

// through scopes a child table that has no user column of its own, via the
// parent that does. The subquery is written out rather than joined so the
// exported rows are the child's own columns and nothing else — a join would
// silently widen the shape with the parent's columns.
func through(name, fk, parent, parentOwner string) Table {
	return Table{
		Name:  name,
		Where: fmt.Sprintf("%s IN (SELECT id FROM %s WHERE %s = ?)", fk, parent, parentOwner),
		Args:  1,
		Note:  fmt.Sprintf("scoped through %s", parent),
	}
}

// Tables is every table an export reads, in a fixed order so two exports of
// unchanged data are byte-comparable.
//
// Keep this sorted by name. The completeness test does not check ordering,
// but a diff of two exports is the cheapest way anyone will ever audit this.
var Tables = []Table{
	owned("ai_entitlements"),
	through("ai_entitlement_days", "entitlement_id", "ai_entitlements", "user_id"),
	owned("ai_payment_orders"),
	owned("ai_quota_windows"),
	owned("ai_usage_events"),
	owned("challenge_participants"),
	by("challenges", "creator_id"),
	owned("coach_plan_proposals"),
	owned("coach_turns"),
	through("coach_turn_citations", "turn_id", "coach_turns", "user_id"),
	owned("device_tokens"),
	owned("fasting_intervals"),
	owned("feedback"),
	owned("food_aliases"),
	owned("food_logs"),
	// Both sides. A friendship this user RECEIVED is as much a record of
	// their social graph as one they sent, and binding the id once would
	// export half of it with nothing to show that half was missing.
	{
		Name:  "friendships",
		Where: "requester_id = ? OR addressee_id = ?",
		Args:  2,
		Note:  "both sides: friendships this user sent and received",
	},
	owned("group_members"),
	by("groups", "owner_id"),
	owned("health_daily_summaries"),
	owned("mentor_check_ins"),
	owned("mentor_commitment_proposals"),
	owned("mentor_commitments"),
	owned("mentor_food_rules"),
	owned("mentor_profiles"),
	// notifications.user_id only — see excludedColumns for actor_id.
	owned("notifications"),
	owned("pins"),
	owned("recipes"),
	through("recipe_ingredients", "recipe_id", "recipes", "user_id"),
	through("recipe_steps", "recipe_id", "recipes", "user_id"),
	through("recipe_tags", "recipe_id", "recipes", "user_id"),
	owned("saved_meals"),
	through("saved_meal_items", "saved_meal_id", "saved_meals", "user_id"),
	by("share_circle_members", "member_user_id"),
	by("share_circles", "owner_id"),
	through("share_grants", "circle_id", "share_circles", "owner_id"),
	// The profile itself. Scoped on the primary key, so it is exactly one
	// row — and it is a table like any other here rather than a special case,
	// so the redaction rules below apply to it uniformly.
	by("users", "id"),
	owned("water_entries"),
	owned("weight_entries"),
}

// ExcludedColumn is a foreign key to users(id) that an export deliberately
// does NOT follow, with the reason.
//
// This exists so the completeness test can tell "we decided not to export
// this" apart from "nobody noticed this". The two are indistinguishable from
// the absence of a line in Tables, and only one of them is acceptable.
type ExcludedColumn struct {
	Table  string
	Column string
	Reason string
}

// ExcludedColumns are the user references an export must not follow.
var ExcludedColumns = []ExcludedColumn{
	{
		Table:  "notifications",
		Column: "actor_id",
		Reason: "someone ELSE's notification, on which this user was the actor. " +
			"Exporting it would hand this user a list of other people's notification " +
			"rows — their data, not this user's, and the recipient never consented " +
			"to it leaving with a third party.",
	},
}

// RedactedColumn is a value withheld from an export, and why.
//
// Redaction is DECLARED in the export payload rather than applied silently
// (see Document.Redacted). A user who is handed an incomplete file is owed the
// list of what is missing; withholding a field and saying nothing makes the
// export quietly untrue, which is the same defect as omitting a table.
type RedactedColumn struct {
	Table  string
	Column string
	Reason string
}

// RedactedColumns are withheld because they are CAPABILITIES, not records.
//
// The test is not "is this sensitive" — the whole export is sensitive, and it
// is going to the person it is about. The test is "could someone holding this
// file act AS the user, or act ON their devices". An export is a file that
// gets emailed, synced and left in a downloads folder; a live credential
// inside one outlives every assumption about where it went.
var RedactedColumns = []RedactedColumn{
	{
		Table:  "users",
		Column: "apple_refresh_token",
		Reason: "a live credential: it exchanges for access to this user's Apple " +
			"identity. Anyone holding the export could act as them.",
	},
	{
		Table:  "device_tokens",
		Column: "token",
		Reason: "a push capability: anyone holding it can send notifications to " +
			"this user's device.",
	},
}

// redactionIndex is RedactedColumns keyed for lookup during a read.
func redactionIndex() map[string]map[string]struct{} {
	out := make(map[string]map[string]struct{}, len(RedactedColumns))
	for _, r := range RedactedColumns {
		if out[r.Table] == nil {
			out[r.Table] = make(map[string]struct{})
		}
		out[r.Table][r.Column] = struct{}{}
	}
	return out
}
