// Package units turns the serving-size text a food row already carries into
// structured, convertible serving units.
//
// Every number this package produces is traceable to a parsed label, the
// curated table, or the food row itself. Nothing here calls an LLM, and
// nothing here invents a conversion: an unknown unit is an error, never a
// guess, because a fabricated density silently corrupts every total that
// uses it while an absent one is merely recoverable.
package units

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// ErrNoUnits reports that a serving description carried no parseable unit.
// It is not a failure state — the food simply has no named serving, and the
// caller falls back to raw base-unit entry.
var ErrNoUnits = errors.New("units: no parseable serving unit")

// ServingUnit is one named serving of a food, e.g. one sachet weighing 16.5g.
// BaseAmount is expressed in the food's own base unit (g or ml).
type ServingUnit struct {
	Name       string  `json:"name"`
	Amount     float64 `json:"amount"`
	BaseAmount float64 `json:"base_amount"`
}

// parenthetical matches the dominant label form: a count, a unit name, then
// the mass or volume in brackets — "1 cup (158g)", "2 biscuits (30g)".
var parenthetical = regexp.MustCompile(`^\s*([\d.]+)\s+([a-zA-Z ]+?)\s*\(\s*([\d.]+)\s*(g|ml)\s*\)\s*$`)

// leadingMass matches the inverted form OFF sometimes uses — "45g pack".
var leadingMass = regexp.MustCompile(`^\s*([\d.]+)\s*(g|ml)\s+([a-zA-Z ]+?)\s*$`)

// Parse extracts serving units from a serving description. It returns
// ErrNoUnits when the text carries none — the common case for bare
// descriptions like "per serving".
func Parse(servingDesc string) ([]ServingUnit, error) {
	if m := parenthetical.FindStringSubmatch(servingDesc); m != nil {
		count, err := strconv.ParseFloat(m[1], 64)
		if err != nil || count <= 0 {
			return nil, ErrNoUnits
		}
		base, err := strconv.ParseFloat(m[3], 64)
		if err != nil || base <= 0 {
			return nil, ErrNoUnits
		}
		// Divide by the count so the unit describes ONE of the thing. A label
		// reading "2 biscuits (30g)" means each biscuit is 15g; recording 30
		// against the name "biscuit" would double every logged biscuit.
		return []ServingUnit{{Name: singular(m[2]), Amount: 1, BaseAmount: base / count}}, nil
	}
	if m := leadingMass.FindStringSubmatch(servingDesc); m != nil {
		base, err := strconv.ParseFloat(m[1], 64)
		if err != nil || base <= 0 {
			return nil, ErrNoUnits
		}
		return []ServingUnit{{Name: singular(m[3]), Amount: 1, BaseAmount: base}}, nil
	}
	return nil, ErrNoUnits
}

// singular trims a trailing plural "s" so "biscuits" and "biscuit" resolve to
// the same unit name. Deliberately naive: the label vocabulary here is small
// and closed (cup, slice, sachet, biscuit, pack, glass), and an English
// inflection library would be far more machinery than the input warrants.
func singular(name string) string {
	trimmed := strings.TrimSpace(strings.ToLower(name))
	if strings.HasSuffix(trimmed, "s") && len(trimmed) > 2 {
		// Don't remove trailing "s" if the word naturally ends in "ss"
		// (like "glass", "class", "kiss") to avoid corrupting singular forms.
		if !strings.HasSuffix(trimmed, "ss") {
			return strings.TrimSuffix(trimmed, "s")
		}
	}
	return trimmed
}
