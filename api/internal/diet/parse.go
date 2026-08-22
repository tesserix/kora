package diet

import "strings"

// Parse turns free text into candidate rules of the given kind.
//
// Negation is deliberately ignored here, unlike Screen. In a box labelled
// "allergies" or "foods you avoid", "no beef" and "beef-free" both mean beef is
// excluded — reading the cue as compliance would silently drop the very rule
// the user was stating.
func Parse(text, kind string) []Rule {
	if strings.TrimSpace(text) == "" {
		return nil
	}
	if !ValidKind(kind) {
		kind = KindPreference
	}

	seen := map[string]struct{}{}
	out := []Rule{}
	for _, h := range Match(text) {
		if _, dup := seen[h.Subject]; dup {
			continue
		}
		seen[h.Subject] = struct{}{}
		out = append(out, Rule{
			Subject:  h.Subject,
			Kind:     kind,
			Severity: DefaultSeverity(kind),
			Label:    LabelFor(h.Subject),
			Source:   SourceUser,
		})
	}
	return out
}

// ParseProfileText parses the two free-text fields a mentor profile already
// stores. Allergies parse as allergies so they compile to blocking rules.
func ParseProfileText(dietaryPreferences, allergies string) []Rule {
	out := Parse(allergies, KindAllergy)
	for _, r := range Parse(dietaryPreferences, KindExclusion) {
		out = append(out, r)
	}
	return out
}
