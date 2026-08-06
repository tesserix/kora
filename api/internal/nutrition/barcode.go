package nutrition

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"gorm.io/gorm"
)

// OFFClient fetches a product from OpenFoodFacts. It returns (nil, nil) when the
// product is unknown, and an error only on transport/decode failure.
type OFFClient interface {
	Fetch(ctx context.Context, barcode string) (*FoodItem, error)
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
	url := fmt.Sprintf("%s/api/v2/product/%s.json?fields=product_name,brands,nutriments,serving_quantity", c.BaseURL, barcode)
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
			ServingQuantity float64 `json:"serving_quantity"`
		} `json:"product"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("nutrition: off decode: %w", err)
	}
	if body.Status != 1 || body.Product.ProductName == "" || body.Product.Nutriments.EnergyKcal100g == 0 {
		return nil, nil // unknown or unusable
	}
	code := barcode
	return &FoodItem{
		Name:           body.Product.ProductName,
		Brand:          body.Product.Brands,
		Provenance:     ProvenanceOFF,
		Barcode:        &code,
		ServingGrams:   body.Product.ServingQuantity,
		KcalPer100g:    body.Product.Nutriments.EnergyKcal100g,
		ProteinPer100g: body.Product.Nutriments.Protein100g,
		CarbsPer100g:   body.Product.Nutriments.Carbs100g,
		FatPer100g:     body.Product.Nutriments.Fat100g,
		FiberPer100g:   body.Product.Nutriments.Fiber100g,
	}, nil
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
	return &cached, true, nil
}
