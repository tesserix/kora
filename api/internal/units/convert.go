package units

import (
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
