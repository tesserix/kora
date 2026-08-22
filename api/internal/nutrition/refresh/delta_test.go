package refresh

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
)

func line(t *testing.T, raw string) product {
	t.Helper()
	var p product
	require.NoError(t, json.Unmarshal([]byte(raw), &p))
	return p
}

const goodAU = `{"code":"9300601123456","product_name":"Weet-Bix","brands":"Sanitarium, Sanitarium NZ",` +
	`"countries_tags":["en:australia","en:new-zealand"],"serving_quantity":"33",` +
	`"serving_size":"2 biscuits (33 g)","serving_quantity_unit":"g",` +
	`"nutriments":{"energy-kcal_100g":355,"proteins_100g":12.4,"carbohydrates_100g":67,"fat_100g":1.4,"fiber_100g":10}}`

func TestItemConvertsAndStampsFirstMatchingLocale(t *testing.T) {
	item, ok := line(t, goodAU).item(DefaultCountries())
	require.True(t, ok)
	// AU listed before NZ in DefaultCountries, matching the snapshot rule.
	require.Equal(t, nutrition.LocaleAU, item.Locale)
	require.Equal(t, nutrition.ProvenanceOFF, item.Provenance)
	require.Equal(t, "Weet-Bix", item.Name)
	require.Equal(t, "Sanitarium", item.Brand, "first brand segment only")
	require.Equal(t, "9300601123456", *item.Barcode)
	require.Equal(t, 33.0, item.ServingGrams, "string serving_quantity must parse")
	require.Equal(t, 355.0, item.KcalPer100g)
}

func TestItemRejectsBelowTheBar(t *testing.T) {
	cases := map[string]string{
		"wrong country": `{"code":"4000000000000","product_name":"Brezel","countries_tags":["en:germany"],` +
			`"nutriments":{"energy-kcal_100g":300,"proteins_100g":9,"carbohydrates_100g":60,"fat_100g":3,"fiber_100g":3}}`,
		"no barcode": `{"code":"x123","product_name":"Mystery","countries_tags":["en:australia"],` +
			`"nutriments":{"energy-kcal_100g":300,"proteins_100g":9,"carbohydrates_100g":60,"fat_100g":3,"fiber_100g":3}}`,
		"missing fiber": `{"code":"9300601123456","product_name":"Bar","countries_tags":["en:australia"],` +
			`"nutriments":{"energy-kcal_100g":300,"proteins_100g":9,"carbohydrates_100g":60,"fat_100g":3}}`,
		"kJ in kcal column": `{"code":"9300601123456","product_name":"Bar","countries_tags":["en:australia"],` +
			`"nutriments":{"energy-kcal_100g":1487,"proteins_100g":9,"carbohydrates_100g":60,"fat_100g":3,"fiber_100g":3}}`,
		"macros sum past 100g": `{"code":"9300601123456","product_name":"Bar","countries_tags":["en:australia"],` +
			`"nutriments":{"energy-kcal_100g":500,"proteins_100g":50,"carbohydrates_100g":40,"fat_100g":30,"fiber_100g":3}}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			_, ok := line(t, raw).item(DefaultCountries())
			require.False(t, ok)
		})
	}
}

func TestItemKeepsMeasuredZeroFiber(t *testing.T) {
	raw := `{"code":"9415142004556","product_name":"L&P","countries_tags":"en:new-zealand",` +
		`"nutriments":{"energy-kcal_100g":43,"proteins_100g":0,"carbohydrates_100g":10.7,"fat_100g":0,"fiber_100g":0}}`
	item, ok := line(t, raw).item(DefaultCountries())
	require.True(t, ok, "zero macros are measurements, not missing data")
	require.Equal(t, nutrition.LocaleNZ, item.Locale)
	require.Empty(t, item.BaseUnit, "unstated unit must stay unstated for diffForUpdate")
}
