// Package refresh keeps the packaged-food layer of the index current without
// human intervention: a weekly pass over OpenFoodFacts' published delta
// exports, filtered to the countries Kora serves, upserted through the same
// dedup and derivation rules every other bulk source goes through.
//
// Deltas, not the search API and not the full dump: the search API is
// rate-limited far below what a weekly reconciliation needs, and the 1.19 GB
// dump is a data-prep artefact (scripts/off_convert.py), not something an API
// pod should stream weekly. OFF publishes daily delta files of exactly the
// products that changed — a few MB each — for precisely this use.
package refresh

import (
	"bufio"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/units"
)

// Country is one OFF countries_tags value and the locale its products carry —
// the runtime mirror of off_convert.py's COUNTRIES table.
type Country struct {
	Tag    string
	Locale nutrition.Locale
}

// DefaultCountries matches the committed OFF slices (off_au/off_nz/off_in).
// Order matters: a trans-Tasman product takes the FIRST matching locale, the
// same priority the sorted-filename collision rule gives the snapshots.
func DefaultCountries() []Country {
	return []Country{
		{Tag: "en:australia", Locale: nutrition.LocaleAU},
		{Tag: "en:new-zealand", Locale: nutrition.LocaleNZ},
		{Tag: "en:india", Locale: nutrition.LocaleIN},
	}
}

// Client reads OpenFoodFacts delta exports.
type Client struct {
	// BaseURL serves /data/delta/index.txt and the files it lists;
	// production is https://static.openfoodfacts.org.
	BaseURL string
	HTTP    *http.Client
}

func NewClient() Client {
	return Client{
		BaseURL: "https://static.openfoodfacts.org",
		// Delta files are a few MB gzipped but the host can be slow; this
		// bounds one FILE, not the whole run.
		HTTP: &http.Client{Timeout: 5 * time.Minute},
	}
}

// deltaFiles lists the export files whose window ends at or after since.
// Names look like products_1724198400_1724284800.json.gz (epoch start_end);
// anything unparseable is skipped rather than fatal — one malformed line in
// the index must not stop the refresh.
func (c Client) deltaFiles(ctx context.Context, since time.Time) ([]string, error) {
	body, err := c.get(ctx, c.BaseURL+"/data/delta/index.txt")
	if err != nil {
		return nil, err
	}
	defer body.Close()
	var files []string
	scanner := bufio.NewScanner(body)
	for scanner.Scan() {
		name := strings.TrimSpace(scanner.Text())
		trimmed := strings.TrimSuffix(strings.TrimPrefix(name, "products_"), ".json.gz")
		parts := strings.Split(trimmed, "_")
		if name == "" || len(parts) != 2 {
			continue
		}
		end, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			continue
		}
		if time.Unix(end, 0).After(since) {
			files = append(files, name)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("refresh: read delta index: %w", err)
	}
	return files, nil
}

// product is the slice of an OFF delta line this refresh reads. countries and
// serving_quantity use tolerant types because OFF community data mixes
// representations (tags as array or comma string, quantities as number or
// string).
type product struct {
	Code                string          `json:"code"`
	ProductName         string          `json:"product_name"`
	Brands              string          `json:"brands"`
	CountriesTags       json.RawMessage `json:"countries_tags"`
	ServingQuantity     looseFloat      `json:"serving_quantity"`
	ServingQuantityUnit string          `json:"serving_quantity_unit"`
	ServingSize         string          `json:"serving_size"`
	Nutriments          struct {
		EnergyKcal100g looseFloat `json:"energy-kcal_100g"`
		Protein100g    looseFloat `json:"proteins_100g"`
		Carbs100g      looseFloat `json:"carbohydrates_100g"`
		Fat100g        looseFloat `json:"fat_100g"`
		Fiber100g      looseFloat `json:"fiber_100g"`
	} `json:"nutriments"`
}

// looseFloat decodes a JSON number or a numeric string; anything else reads
// as (0, unset). set distinguishes "absent" from a genuine zero — fiber 0 is
// a measurement, missing fiber disqualifies the row.
type looseFloat struct {
	value float64
	set   bool
}

func (f *looseFloat) UnmarshalJSON(data []byte) error {
	s := strings.Trim(string(data), `"`)
	if s == "null" || s == "" {
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil // tolerate garbage: the row just fails the completeness bar
	}
	f.value, f.set = v, true
	return nil
}

func (p product) countryTags() string {
	var tags []string
	if err := json.Unmarshal(p.CountriesTags, &tags); err == nil {
		return strings.Join(tags, ",")
	}
	var s string
	if err := json.Unmarshal(p.CountriesTags, &s); err == nil {
		return s
	}
	return ""
}

// The quality bar, verbatim from scripts/off_convert.py: a row is only worth
// having if it can answer "how many calories was that".
const (
	maxKcalPer100g = 900
	minServingG    = 1
	maxServingG    = 500
	maxNameLen     = 120
)

// item converts a delta product to a FoodItem, or reports false when the
// product fails the bar or matches none of the wanted countries. Barcode is
// mandatory here (unlike the converter) because barcode is the only identity
// UpsertBarcoded will update on.
func (p product) item(countries []Country) (nutrition.FoodItem, bool) {
	tags := p.countryTags()
	locale := nutrition.LocaleUnknown
	for _, c := range countries {
		if strings.Contains(tags, c.Tag) {
			locale = c.Locale
			break
		}
	}
	name := strings.TrimSpace(p.ProductName)
	code := strings.TrimSpace(p.Code)
	digits := len(code) >= 8 && len(code) <= 14 && strings.IndexFunc(code, func(r rune) bool { return r < '0' || r > '9' }) < 0
	if locale == nutrition.LocaleUnknown || name == "" || len(name) > maxNameLen || !digits {
		return nutrition.FoodItem{}, false
	}
	n := p.Nutriments
	if !n.EnergyKcal100g.set || !n.Protein100g.set || !n.Carbs100g.set || !n.Fat100g.set || !n.Fiber100g.set {
		return nutrition.FoodItem{}, false
	}
	kcal := n.EnergyKcal100g.value
	protein, carbs, fat, fiber := n.Protein100g.value, n.Carbs100g.value, n.Fat100g.value, n.Fiber100g.value
	if kcal <= 0 || kcal > maxKcalPer100g {
		return nutrition.FoodItem{}, false
	}
	for _, v := range []float64{protein, carbs, fat, fiber} {
		if v < 0 || v > 100 {
			return nutrition.FoodItem{}, false
		}
	}
	if protein+carbs+fat > 100 {
		return nutrition.FoodItem{}, false
	}

	brand := strings.TrimSpace(strings.Split(p.Brands, ",")[0])
	item := nutrition.FoodItem{
		Name:           name,
		Brand:          brand,
		Locale:         locale,
		Provenance:     nutrition.ProvenanceOFF,
		Barcode:        &code,
		KcalPer100g:    kcal,
		ProteinPer100g: protein,
		CarbsPer100g:   carbs,
		FatPer100g:     fat,
		FiberPer100g:   fiber,
	}
	if p.ServingQuantity.set && p.ServingQuantity.value >= minServingG && p.ServingQuantity.value <= maxServingG {
		item.ServingGrams = p.ServingQuantity.value
		item.ServingDesc = strings.TrimSpace(p.ServingSize)
	}
	// Only a STATED unit is carried; BaseUnitFor's "g" default over an absent
	// unit is exactly the downgrade diffForUpdate refuses to write.
	if p.ServingQuantityUnit != "" {
		item.BaseUnit = nutrition.BaseUnitFor(p.ServingQuantityUnit)
	}
	if parsed, err := units.Parse(item.ServingDesc); err == nil {
		if encoded, mErr := json.Marshal(parsed); mErr == nil {
			item.ServingUnits = encoded
		}
	}
	return item, true
}

// collect streams one delta file and returns the items that clear the bar.
// Later files re-state products from earlier ones; the caller keeps the LAST
// occurrence per barcode, since delta windows are chronological.
func (c Client) collect(ctx context.Context, file string, countries []Country) ([]nutrition.FoodItem, error) {
	body, err := c.get(ctx, c.BaseURL+"/data/delta/"+file)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	gz, err := gzip.NewReader(body)
	if err != nil {
		return nil, fmt.Errorf("refresh: gunzip %s: %w", file, err)
	}
	defer gz.Close()

	var items []nutrition.FoodItem
	scanner := bufio.NewScanner(gz)
	// OFF product documents run long; 10 MB covers the worst observed lines.
	scanner.Buffer(make([]byte, 1024*1024), 10*1024*1024)
	for scanner.Scan() {
		var p product
		if err := json.Unmarshal(scanner.Bytes(), &p); err != nil {
			continue // one broken line must not sink the file
		}
		if item, ok := p.item(countries); ok {
			items = append(items, item)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("refresh: scan %s: %w", file, err)
	}
	return items, nil
}

func (c Client) get(ctx context.Context, url string) (interface {
	Read([]byte) (int, error)
	Close() error
}, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("refresh: request %s: %w", url, err)
	}
	req.Header.Set("User-Agent", "Kora/1.0 (nutrition index refresh)")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("refresh: fetch %s: %w", url, err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("refresh: fetch %s: status %d", url, resp.StatusCode)
	}
	return resp.Body, nil
}
