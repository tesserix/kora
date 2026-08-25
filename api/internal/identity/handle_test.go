package identity

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCanonical(t *testing.T) {
	tests := []struct {
		name      string
		raw       string
		display   string
		canonical string
		err       error
	}{
		{name: "plain", raw: "ada", display: "ada", canonical: "ada"},
		{name: "uppercase folds to lower", raw: "AdaL", display: "adal", canonical: "ada1"},
		{name: "surrounding space is trimmed", raw: "  ada  ", display: "ada", canonical: "ada"},
		{name: "leading at sign is accepted and dropped", raw: "@ada", display: "ada", canonical: "ada"},
		{name: "underscore is allowed", raw: "ada_lovelace", display: "ada_lovelace", canonical: "ada_10ve1ace"},
		{name: "digits are allowed", raw: "ada2026", display: "ada2026", canonical: "ada2026"},
		{name: "too short", raw: "ad", err: ErrHandleInvalid},
		{name: "too long", raw: "abcdefghijklmnopqrstu", err: ErrHandleInvalid},
		{name: "empty", raw: "", err: ErrHandleInvalid},
		{name: "space inside", raw: "ada lovelace", err: ErrHandleInvalid},
		{name: "hyphen is not in the charset", raw: "ada-l", err: ErrHandleInvalid},
		{name: "dot is not in the charset", raw: "ada.l", err: ErrHandleInvalid},
		{name: "non-ascii is not in the charset", raw: "adaé", err: ErrHandleInvalid},
		{name: "reserved", raw: "support", err: ErrHandleReserved},
		{name: "reserved via confusables", raw: "adm1n", err: ErrHandleReserved},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			display, canonical, err := Canonical(tt.raw)
			if tt.err != nil {
				require.ErrorIs(t, err, tt.err)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tt.display, display)
			require.Equal(t, tt.canonical, canonical)
		})
	}
}

// The failure this prevents is not a missed lookup. It is sending a friend
// request to a stranger and then sharing body metrics with them, because
// `ada_l` and `ada_1` are indistinguishable when spoken.
func TestCanonical_ConfusableClassCollapsesToOneCanonicalForm(t *testing.T) {
	var got []string
	for _, raw := range []string{"ada_l", "ada_1", "ada_i", "ADA_I", "ada_L"} {
		_, canonical, err := Canonical(raw)
		require.NoError(t, err)
		got = append(got, canonical)
	}
	for _, c := range got {
		require.Equal(t, got[0], c, "every member of a confusable class must fold to one canonical form")
	}
}

func TestCanonical_OAndZeroFold(t *testing.T) {
	_, a, err := Canonical("b0b_smith")
	require.NoError(t, err)
	_, b, err := Canonical("bob_smith")
	require.NoError(t, err)
	require.Equal(t, a, b)
}

// Display keeps what the user typed (minus case and padding) so `ada_l` does
// not render back to them as `ada_1`.
func TestCanonical_DisplayIsNotFolded(t *testing.T) {
	display, canonical, err := Canonical("ada_l")
	require.NoError(t, err)
	require.Equal(t, "ada_l", display)
	require.NotEqual(t, display, canonical)
}

func TestErrorsAreDistinct(t *testing.T) {
	require.False(t, errors.Is(ErrHandleInvalid, ErrHandleReserved))
	require.False(t, errors.Is(ErrHandleTaken, ErrHandleRetired))
}

func TestCanonical_EveryReservedNameIsRefused(t *testing.T) {
	for _, name := range []string{"kora", "admin", "support", "help", "team"} {
		t.Run(name, func(t *testing.T) {
			_, _, err := Canonical(name)
			require.ErrorIs(t, err, ErrHandleReserved)
		})
	}
}
