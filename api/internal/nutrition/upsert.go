package nutrition

import (
	"context"
	"fmt"
)

// UpsertBarcoded reconciles refreshed barcoded products against the index:
// unknown barcodes insert (through Insert, so they get the same derivation and
// name+brand dedup every bulk source gets), known live barcodes update in
// place when the upstream data actually changed, and soft-deleted barcodes are
// skipped entirely — a food an admin retired must stay retired no matter how
// often upstream re-publishes it, the same rule Insert's dedup enforces.
//
// Items without a barcode are skipped, not an error: barcode is the only
// identity stable enough to justify overwriting a stored row. A name+brand
// match is evidence two rows describe the same food, not proof, and updating
// on it would let a community rename corrupt a different product.
func (r Repository) UpsertBarcoded(ctx context.Context, items []FoodItem) (inserted, updated int, err error) {
	var creates []FoodItem
	for _, item := range items {
		if item.Barcode == nil || *item.Barcode == "" {
			continue
		}
		var existing []FoodItem
		if err := r.db.WithContext(ctx).
			Where("barcode = ? AND deleted_at IS NULL", *item.Barcode).
			Limit(1).Find(&existing).Error; err != nil {
			return inserted, updated, fmt.Errorf("nutrition: upsert lookup: %w", err)
		}
		if len(existing) == 0 {
			// Insert's dedup counts deleted rows too, so a retired barcode
			// stays dead without a second check here.
			creates = append(creates, item)
			continue
		}
		changes := diffForUpdate(existing[0], item)
		if len(changes) == 0 {
			continue
		}
		if err := r.db.WithContext(ctx).Model(&FoodItem{}).
			Where("id = ?", existing[0].ID).
			Updates(changes).Error; err != nil {
			return inserted, updated, fmt.Errorf("nutrition: upsert update: %w", err)
		}
		updated++
	}
	n, err := r.Insert(ctx, creates)
	return n, updated, err
}

// diffForUpdate returns only the columns whose upstream value genuinely
// differs, so an unchanged product is a no-op rather than a row churned every
// week.
//
// Deliberately absent: provenance and locale (properties of the source and of
// the original slice, not of the week's re-publish), and base_unit unless the
// incoming item states one — Fetch's BaseUnitFor collapses "unstated" onto
// "g", and writing that over a correctly-ml row is the exact downgrade
// ServingUnitFetcher's contract warns about.
func diffForUpdate(old, next FoodItem) map[string]any {
	changes := map[string]any{}
	if next.Name != "" && next.Name != old.Name {
		changes["name"] = next.Name
		changes["normalized_name"] = Normalize(next.Name)
		changes["normalized_identity"] = identityPhrase(next.Name)
	}
	if next.Brand != old.Brand {
		changes["brand"] = next.Brand
	}
	if _, renamed := changes["name"]; renamed || next.Brand != old.Brand {
		changes["entity_type"] = DeriveEntityType(next.Brand, next.Barcode)
	}
	if next.KcalPer100g != old.KcalPer100g {
		changes["kcal_per_100g"] = next.KcalPer100g
	}
	if next.ProteinPer100g != old.ProteinPer100g {
		changes["protein_per_100g"] = next.ProteinPer100g
	}
	if next.CarbsPer100g != old.CarbsPer100g {
		changes["carbs_per_100g"] = next.CarbsPer100g
	}
	if next.FatPer100g != old.FatPer100g {
		changes["fat_per_100g"] = next.FatPer100g
	}
	if next.FiberPer100g != old.FiberPer100g {
		changes["fiber_per_100g"] = next.FiberPer100g
	}
	if next.ServingGrams > 0 && next.ServingGrams != old.ServingGrams {
		changes["serving_grams"] = next.ServingGrams
	}
	if next.ServingDesc != "" && next.ServingDesc != old.ServingDesc {
		changes["serving_desc"] = next.ServingDesc
	}
	if len(next.ServingUnits) > 0 && string(next.ServingUnits) != string(old.ServingUnits) {
		changes["serving_units"] = next.ServingUnits
	}
	if next.BaseUnit != "" && next.BaseUnit != old.BaseUnit {
		changes["base_unit"] = next.BaseUnit
	}
	return changes
}
