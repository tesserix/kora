package access

import (
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestCategoryValid(t *testing.T) {
	require.True(t, CategoryProgress.Valid())
	require.True(t, CategoryBody.Valid())
	require.False(t, Category("recipes").Valid())
	require.False(t, Category("").Valid())
}

// The allow-list and share_grants_category_check in migration 000054 are one
// rule in two places. This pins the Go half so a category added here without
// the CHECK is caught by a test rather than by a failing INSERT in production.
func TestCategoriesListMatchesConstants(t *testing.T) {
	require.Equal(t, []Category{CategoryProgress, CategoryBody}, Categories)
}

// THE invariant behind the whole package: a Grant that did not come from
// Resolve carries no owner, so it reads nobody's data. Other packages can
// write access.Grant{} -- they cannot put an owner in it.
func TestZeroGrantHasNoOwner(t *testing.T) {
	require.Equal(t, uuid.Nil, Grant{}.Owner())
}
