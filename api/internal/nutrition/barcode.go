package nutrition

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/units"
)

// OFFClient fetches a product from OpenFoodFacts. It returns (nil, nil) when the
// product is unknown, and an error only on transport/decode failure.
type OFFClient interface {
	Fetch(ctx context.Context, barcode string) (*FoodItem, error)
}

// ServingUnitFetcher reports OpenFoodFacts' serving_quantity_unit for a
// barcode exactly as published, with no defaulting applied.
//
// Fetch cannot express this: BaseUnitFor maps anything unrecognised — an
// absent unit included — onto "g", so a FoodItem's BaseUnit makes "OFF
// publishes no unit" indistinguishable from "OFF says grams". That difference
// matters to any caller CORRECTING an existing row: writing "g" on absent
// evidence downgrades a row that is already correctly ml. Such callers read
// the raw field through this instead.
//
// found is false when OFF does not know the product at all; raw is "" when it
// knows the product but publishes no serving_quantity_unit.
type ServingUnitFetcher interface {
	FetchServingUnit(ctx context.Context, barcode string) (raw string, found bool, err error)
}

// HTTPOFFClient calls the OpenFoodFacts v2 product API.
type HTTPOFFClient struct {
	BaseURL string
	Client  *http.Client
}

func NewHTTPOFFClient() HTTPOFFClient {
	return HTTPOFFClient{
		BaseURL: "https://world.openfoodfacts.org",
		Client:  &http.Client{Timeout: 4 * time.Second},
	}
}

func (c HTTPOFFClient) Fetch(ctx context.Context, barcode string) (*FoodItem, error) {
	url := fmt.Sprintf("%s/api/v2/product/%s.json?fields=product_name,brands,nutriments,serving_quantity,serving_quantity_unit,serving_size", c.BaseURL, barcode)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("nutrition: off request: %w", err)
	}
	req.Header.Set("User-Agent", "Kora/1.0 (nutrition index)")
	resp, err := c.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("nutrition: off fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, nil // treat non-200 as unknown, not an error to the caller
	}
	var body struct {
		Status  int `json:"status"`
		Product struct {
			ProductName string `json:"product_name"`
			Brands      string `json:"brands"`
			Nutriments  struct {
				EnergyKcal100g float64 `json:"energy-kcal_100g"`
				Protein100g    float64 `json:"proteins_100g"`
				Carbs100g      float64 `json:"carbohydrates_100g"`
				Fat100g        float64 `json:"fat_100g"`
				Fiber100g      float64 `json:"fiber_100g"`
			} `json:"nutriments"`
			ServingQuantity     float64 `json:"serving_quantity"`
			ServingQuantityUnit string  `json:"serving_quantity_unit"`
			ServingSize         string  `json:"serving_size"`
		} `json:"product"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("nutrition: off decode: %w", err)
	}
	if body.Status != 1 || body.Product.ProductName == "" || body.Product.Nutriments.EnergyKcal100g == 0 {
		return nil, nil // unknown or unusable
	}
	code := barcode
	item := &FoodItem{
		Name:           body.Product.ProductName,
		Brand:          body.Product.Brands,
		Provenance:     ProvenanceOFF,
		Barcode:        &code,
		ServingDesc:    body.Product.ServingSize,
		ServingGrams:   body.Product.ServingQuantity,
		BaseUnit:       BaseUnitFor(body.Product.ServingQuantityUnit),
		KcalPer100g:    body.Product.Nutriments.EnergyKcal100g,
		ProteinPer100g: body.Product.Nutriments.Protein100g,
		CarbsPer100g:   body.Product.Nutriments.Carbs100g,
		FatPer100g:     body.Product.Nutriments.Fat100g,
		FiberPer100g:   body.Product.Nutriments.Fiber100g,
	}
	// The row's own label first: it carries the serving's real NAME ("sachet",
	// "glass"), which a user recognises and a generic word never will.
	//
	// Failing that, OFF very often publishes a numeric serving_quantity with no
	// serving_size text at all — both barcodes from the 2026-08-11 verification
	// are like this. Naming that mass "1 portion" is not a guess: it is the
	// serving OFF already published, relabelled. Nothing is derived from the
	// food's name or from any density table, which is exactly what separates
	// this from the curated fallback that used to live in units.Fallback.
	if parsed, err := units.Parse(body.Product.ServingSize); err == nil {
		if encoded, mErr := json.Marshal(parsed); mErr == nil {
			item.ServingUnits = encoded
		}
	} else if portion, ok := PortionFromServingGrams(item.ServingGrams); ok {
		if encoded, mErr := json.Marshal(portion); mErr == nil {
			item.ServingUnits = encoded
		}
	} else {
		slog.DebugContext(ctx, "nutrition: no serving unit parsed and no serving quantity to name",
			"barcode", barcode, "serving_size", body.Product.ServingSize)
	}
	return item, nil
}

// GenericPortionName is what a serving gets called when the source published a
// serving mass but no name for it. Deliberately generic: it makes no claim
// about the food's form, only that this is one serving of it.
const GenericPortionName = "portion"

// PortionFromServingGrams names a row's own serving mass as a single generic
// portion, or reports false when there is no mass to name.
//
// The guard is not cosmetic. A zero — OFF omitting serving_quantity, which is
// common — would otherwise become a serving unit whose base_amount is 0, and
// every log entered against it would resolve to zero grams and silently
// contribute nothing to the day's totals.
func PortionFromServingGrams(servingGrams float64) ([]units.ServingUnit, bool) {
	if servingGrams <= 0 {
		return nil, false
	}
	return []units.ServingUnit{{Name: GenericPortionName, Amount: 1, BaseAmount: servingGrams}}, true
}

// FetchServingUnit reads only the product's serving_quantity_unit, verbatim.
// See ServingUnitFetcher for why a caller would want the raw field rather than
// the already-defaulted BaseUnit Fetch produces.
func (c HTTPOFFClient) FetchServingUnit(ctx context.Context, barcode string) (string, bool, error) {
	url := fmt.Sprintf("%s/api/v2/product/%s.json?fields=serving_quantity_unit", c.BaseURL, barcode)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", false, fmt.Errorf("nutrition: off serving unit request: %w", err)
	}
	req.Header.Set("User-Agent", "Kora/1.0 (nutrition index)")
	resp, err := c.Client.Do(req)
	if err != nil {
		return "", false, fmt.Errorf("nutrition: off serving unit fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", false, nil // treat non-200 as unknown, same as Fetch
	}
	var body struct {
		Status  int `json:"status"`
		Product struct {
			ServingQuantityUnit string `json:"serving_quantity_unit"`
		} `json:"product"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", false, fmt.Errorf("nutrition: off serving unit decode: %w", err)
	}
	if body.Status != 1 {
		return "", false, nil
	}
	return strings.TrimSpace(body.Product.ServingQuantityUnit), true, nil
}

var _ ServingUnitFetcher = HTTPOFFClient{}

// BaseUnitFor maps OpenFoodFacts' serving_quantity_unit onto our two-value
// base unit. OFF reports a liquid's nutriments per 100 ml already, so this is
// purely a labelling decision — no numeric conversion is implied. Anything
// unrecognised falls back to grams, which is what every pre-000026 row is.
//
// That default is right for INGEST, where a row has to be given some base unit
// and grams is the safe assumption. It is wrong for CORRECTION: a caller
// rewriting an existing row must first establish that OFF published a unit at
// all (see ServingUnitFetcher), because "" arriving here silently becomes "g".
func BaseUnitFor(offUnit string) string {
	switch strings.ToLower(strings.TrimSpace(offUnit)) {
	case "ml", "l":
		return "ml"
	default:
		return "g"
	}
}

// ResolveBarcode returns a FoodItem for a barcode: local index first, then the
// OFF client on a miss (caching the hit). Never fabricates a row.
//
// A row an admin has retired (deleted_at set) is treated as if it were not
// there: the local lookup is filtered to deleted_at IS NULL, so a retired
// row falls through to the OFF fetch and a scan returns fresh third-party
// data instead of auto-logging the retired record at maximum confidence.
// Insert's barcode dedup count is deliberately unfiltered (see the
// DELIBERATE ASYMMETRY comment on Insert in repository.go), so re-fetching
// the same barcode from OFF finds the retired row and no-ops rather than
// resurrecting it — the reload below then also misses under the same
// deleted_at filter and falls into the existing "insert deduped, return the
// fetched item directly" branch, same as the pre-existing name+brand dedup
// case.
func (r Repository) ResolveBarcode(ctx context.Context, off OFFClient, code string) (*FoodItem, bool, error) {
	var local FoodItem
	err := r.db.WithContext(ctx).Where("deleted_at IS NULL").First(&local, "barcode = ?", code).Error
	if err == nil {
		return &local, true, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, false, fmt.Errorf("nutrition: resolve barcode local: %w", err)
	}
	item, ferr := off.Fetch(ctx, code)
	if ferr != nil {
		return nil, false, fmt.Errorf("nutrition: resolve barcode: %w", ferr)
	}
	if item == nil {
		return nil, false, nil
	}
	if _, ierr := r.Insert(ctx, []FoodItem{*item}); ierr != nil {
		return nil, false, fmt.Errorf("nutrition: resolve barcode cache: %w", ierr)
	}
	var cached FoodItem
	if err := r.db.WithContext(ctx).Where("deleted_at IS NULL").First(&cached, "barcode = ?", code).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			// Insert deduped on name+brand, or found an existing (possibly
			// retired) row under this barcode, rather than creating a new
			// row. Either way no live row exists to reload here — return
			// the freshly fetched OFF item directly. The OFF item itself is
			// still valid, current data.
			return item, true, nil
		}
		return nil, false, fmt.Errorf("nutrition: resolve barcode reload: %w", err)
	}
	r.embedAsync(cached.ID, cached.Name)
	return &cached, true, nil
}

// embedAsync fills a freshly ingested food's embedding in the background.
//
// Deliberately fire-and-forget with its own context: the caller's context is
// cancelled the moment the scan response is written, and a scan must never
// fail — or wait — because an embedding did.
//
// On failure it logs and leaves the column NULL, which puts the row straight
// back into RowsMissingEmbedding for the next cmd/embed pass. That is the
// whole safety argument for doing this asynchronously, and it is why there is
// no retry here: cmd/embed already retries properly.
func (r Repository) embedAsync(id uuid.UUID, name string) {
	if r.embedder == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		vec, err := r.embedder.Embed(ctx, name)
		if err != nil {
			slog.WarnContext(ctx, "nutrition: ingest-time embed failed; row left for cmd/embed",
				"error", err, "food_item_id", id, "name", name)
			return
		}
		if err := r.SetEmbedding(ctx, id, vec); err != nil {
			slog.WarnContext(ctx, "nutrition: storing ingest-time embedding failed; row left for cmd/embed",
				"error", err, "food_item_id", id)
		}
	}()
}
