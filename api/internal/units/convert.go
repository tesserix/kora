package units

import (
	"encoding/json"
	"errors"
	"strings"
)

// ErrNoConversion reports that no conversion exists from the given unit to
// the food's base unit. Callers must surface this — never substitute a
// default — and fall back to raw base-unit entry.
var ErrNoConversion = errors.New("units: no conversion for unit")

// ErrInvalidAmount reports a non-positive amount.
var ErrInvalidAmount = errors.New("units: amount must be positive")

// Scale factors from a bulk unit to its base. Mass and volume are kept
// separate on purpose: converting kg against an ml base would require a
// density this package refuses to invent.
var massScale = map[string]float64{"g": 1, "kg": 1000}
var volumeScale = map[string]float64{"ml": 1, "l": 1000}

// ToBase converts amount of unit into the food's base unit. It is the single
// conversion entry point in the system, and it returns an error rather than
// guessing when no conversion exists.
func ToBase(amount float64, unit string, baseUnit string, servingUnits []ServingUnit) (float64, error) {
	if amount <= 0 {
		return 0, ErrInvalidAmount
	}
	normalized := strings.ToLower(strings.TrimSpace(unit))

	// A bulk mass/volume unit, valid only against a matching base.
	switch strings.ToLower(baseUnit) {
	case "g":
		if scale, ok := massScale[normalized]; ok {
			return amount * scale, nil
		}
	case "ml":
		if scale, ok := volumeScale[normalized]; ok {
			return amount * scale, nil
		}
	}

	// A named serving carried by the food row itself.
	for _, su := range servingUnits {
		if strings.ToLower(su.Name) == normalized && su.Amount > 0 {
			return amount * (su.BaseAmount / su.Amount), nil
		}
	}

	return 0, ErrNoConversion
}

// UnrecognisedUnitMessage is the client-facing validation message every
// caller must use, verbatim, when ResolveEntered (or ToBase directly) fails
// to resolve an entered unit. It lives here — not as an httpx.ValidationError
// itself, since this package stays free of the httpx/nutrition dependency —
// so foodlog and savedmeals both wrap the same constant into their own
// validation-error type and read identically to a client.
const UnrecognisedUnitMessage = "unrecognised unit for this food"

// DecodeServingUnits decodes a food row's stored ServingUnits JSON (its raw
// serialized form, e.g. straight from a `serving_units jsonb` column). A
// decode error must never break the caller — it just means no named
// servings resolve for this row, so it degrades to an empty slice rather
// than surfacing as a failure.
func DecodeServingUnits(raw json.RawMessage) []ServingUnit {
	if len(raw) == 0 {
		return nil
	}
	var out []ServingUnit
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}

// ResolveEntered resolves an entered (amount, unit) pair into the food's
// base unit (grams or millilitres), exactly once, against baseUnit and the
// food's raw ServingUnits JSON. It is the single shared entry point foodlog
// and savedmeals both call so an entered unit resolves identically on every
// surface — deliberately just ToBase + DecodeServingUnits, so this package
// stays free of any dependency beyond what it already has (no httpx, no
// nutrition, no foodlog): a caller translates a non-nil error into its own
// validation-error type using UnrecognisedUnitMessage.
func ResolveEntered(amount float64, unit, baseUnit string, servingUnitsRaw json.RawMessage) (float64, error) {
	return ToBase(amount, unit, baseUnit, DecodeServingUnits(servingUnitsRaw))
}
