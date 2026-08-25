// Package access answers one question: may this viewer see this category of
// this owner's data (kora#326)?
//
// It exists because there is no owner-scoping abstraction in this API to hang
// the check on -- ownership is ~57 hand-written `user_id = ?` filters, and a
// new cross-user endpoint would inherit no protection at all.
package access

import "github.com/google/uuid"

type Category string

const (
	CategoryProgress Category = "progress" // streak_days, adherence_days
	CategoryBody     Category = "body"     // weight, measurements, body fat
)

// Categories is the allow-list, mirroring share_grants_category_check in
// migration 000054. Changing one side alone makes the CHECK reject a write the
// Go layer accepted, so change both.
var Categories = []Category{CategoryProgress, CategoryBody}

func (c Category) Valid() bool {
	for _, known := range Categories {
		if c == known {
			return true
		}
	}
	return false
}

// Grant is proof that a specific viewer may read a specific category of a
// specific owner. Its fields are unexported and only Resolve/ResolveMany set
// them.
//
// This is FAIL-SAFE, not uncircumventable. Go permits `access.Grant{}` from any
// package -- only the fields are unreachable. Such a grant carries uuid.Nil as
// its owner, so a service using grant.Owner() as its query key reads zero rows.
// The failure mode of bypassing this package is NO DATA, never SOMEONE ELSE'S
// DATA. Do not restate that as "impossible"; it is not.
type Grant struct {
	viewer   uuid.UUID
	owner    uuid.UUID
	category Category
}

// Owner is the only key a cross-user read may query by.
func (g Grant) Owner() uuid.UUID { return g.owner }

func (g Grant) Viewer() uuid.UUID { return g.viewer }

func (g Grant) Category() Category { return g.category }
