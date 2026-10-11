package billing

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPriceItemisesFeeAndGSTForEveryPack(t *testing.T) {
	want := map[string]PriceBreakdown{
		"spark":     {BasePaise: 5_000, PlatformFeePaise: 100, TaxablePaise: 5_100, GSTPaise: 918, TotalPaise: 6_018},
		"steady":    {BasePaise: 15_000, PlatformFeePaise: 300, TaxablePaise: 15_300, GSTPaise: 2_754, TotalPaise: 18_054},
		"strong":    {BasePaise: 35_000, PlatformFeePaise: 700, TaxablePaise: 35_700, GSTPaise: 6_426, TotalPaise: 42_126},
		"boundless": {BasePaise: 105_000, PlatformFeePaise: 2_100, TaxablePaise: 107_100, GSTPaise: 19_278, TotalPaise: 126_378},
	}
	for _, pack := range Packs() {
		got := Price(pack)
		expected := want[pack.Code]
		expected.GSTRateBasisPoints = gstRateBasisPoints
		expected.PlatformFeeRateBasisPoints = platformFeeBasisPoints
		require.Equal(t, expected, got, "price of %s", pack.Code)
		require.Equal(t, got.TotalPaise, got.TaxablePaise+got.GSTPaise, "%s total is the sum of its lines", pack.Code)
	}
}

func TestPacksSpanTheSoldPriceRange(t *testing.T) {
	list := Packs()
	require.NotEmpty(t, list)
	require.Equal(t, 5_000, list[0].BasePaise, "the cheapest pack is ₹50")
	require.Equal(t, 105_000, list[len(list)-1].BasePaise, "the dearest pack is ₹1050")
	for i := 1; i < len(list); i++ {
		require.Greater(t, list[i].BasePaise, list[i-1].BasePaise, "packs are listed cheapest first")
	}
}

// Only the ₹1050 pack is unlimited, and every other pack must bound BOTH the
// total grant and the daily rate. A pack with a grant but no daily cap would
// let a user spend a month of allowance in an afternoon.
func TestOnlyTheTopPackIsUnlimitedAndTheRestAreBounded(t *testing.T) {
	for _, pack := range Packs() {
		if pack.Unlimited {
			require.Equal(t, 105_000, pack.BasePaise, "only the ₹1050 pack is unlimited")
			continue
		}
		require.Greater(t, pack.Grant, 0, "%s grants requests", pack.Code)
		require.Greater(t, pack.DailyCap, 0, "%s caps its daily rate", pack.Code)
		require.LessOrEqual(t, pack.DailyCap, pack.Grant, "%s cannot spend more in a day than it grants", pack.Code)
	}
}

// Bigger packs must cost less per request, or the price list punishes the user
// for buying more; and none may fall below the list-price proxy cost of a
// request, or the monthly cost cap would stop a paying user before their pack
// ran out.
func TestPricePerRequestFallsWithPackSizeAndStaysAboveCost(t *testing.T) {
	const proxyCostPaisePerRequest = 145
	previous := 0
	for _, pack := range Packs() {
		if pack.Unlimited {
			continue
		}
		perRequest := pack.BasePaise / pack.Grant
		require.Greater(t, perRequest, proxyCostPaisePerRequest, "%s is priced above proxy cost", pack.Code)
		if previous > 0 {
			require.Less(t, perRequest, previous, "%s is better value than the pack below it", pack.Code)
		}
		previous = perRequest
	}
}

func TestPackByCodeRejectsAnUnknownCode(t *testing.T) {
	pack, err := PackByCode("spark")
	require.NoError(t, err)
	require.Equal(t, "spark", pack.Code)

	_, err = PackByCode("free-everything")
	require.Error(t, err)
}

func TestRoundedBasisPointsRoundsHalfUp(t *testing.T) {
	require.Equal(t, 1, roundedBasisPoints(25, platformFeeBasisPoints), "0.5 paise rounds up")
	require.Equal(t, 0, roundedBasisPoints(24, platformFeeBasisPoints), "below half rounds down")
}

func TestRupeesRendersPaiseWithBothDecimals(t *testing.T) {
	require.Equal(t, "60.18", Rupees(6_018))
	require.Equal(t, "1263.78", Rupees(126_378))
	require.Equal(t, "0.05", Rupees(5))
}
