package nutrition

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWorldFoodLocalesFollowSupportedCountries(t *testing.T) {
	for timezone, country := range map[string]string{
		"Europe/London": "GB", "Europe/Paris": "FR", "Asia/Tokyo": "JP",
		"Asia/Singapore": "SG", "Asia/Bangkok": "TH", "Asia/Dubai": "AE",
		"Africa/Johannesburg": "ZA", "America/Sao_Paulo": "BR", "America/Mexico_City": "MX",
	} {
		t.Run(timezone, func(t *testing.T) {
			require.Equal(t, country, LocaleFromTimezone(timezone))
		})
	}
	require.Equal(t, "GB", DeriveLocale("cofid"))
	require.Equal(t, "JP", DeriveLocale("mext"))
}
