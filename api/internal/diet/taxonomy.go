// Package diet turns a user's dietary constraints into something code can
// enforce: canonical subjects, a matcher over free text and food names, and a
// screen that finds violations in generated answers.
//
// The taxonomy lives in Go rather than the database because it is code-shaped —
// unit-testable, reviewed as a diff, and versioned with the matcher that reads
// it. Adding a synonym should be a pull request, not a data edit.
package diet

import (
	"sort"
	"strings"
	"unicode"
)

// Severity is how hard a rule binds. Allergies block; everything else flags.
const (
	SeverityBlock = "block"
	SeverityFlag  = "flag"
)

// Kind is what the user meant by the rule, kept separate from Severity so a
// non-allergy exclusion can still be strict — religious and ethical exclusions
// are absolute for the people who hold them.
const (
	KindAllergy    = "allergy"
	KindExclusion  = "exclusion"
	KindPreference = "preference"
)

// Source records who created a rule. Only a user confirmation puts one in force.
const (
	SourceUser    = "user"
	SourcePattern = "pattern"
	SourceCoach   = "coach"
)

// Diet patterns expand into rules at write time so enforcement reads one place.
const (
	PatternNone        = ""
	PatternVegetarian  = "vegetarian"
	PatternVegan       = "vegan"
	PatternEggetarian  = "eggetarian"
	PatternJain        = "jain"
	PatternHalal       = "halal"
	PatternPescatarian = "pescatarian"
)

// Subject is one canonical thing a user can exclude. Family names the allergen
// group; matching widens to the family so a near miss errs toward caution.
type Subject struct {
	Token   string
	Label   string
	Family  string
	Aliases []string
}

// Allergen families. A rule on a family matches every subject within it.
const (
	FamilyDairy     = "dairy"
	FamilyEgg       = "egg"
	FamilyGluten    = "gluten"
	FamilyPeanut    = "peanut"
	FamilyTreeNut   = "tree nut"
	FamilySoy       = "soy"
	FamilyFish      = "fish"
	FamilyShellfish = "shellfish"
	FamilySesame    = "sesame"
	FamilyMustard   = "mustard"
)

// subjects is the canonical taxonomy. Aliases are matched on word boundaries
// with naive plural tolerance, so only genuinely distinct wordings are listed.
var subjects = []Subject{
	// Meat and poultry.
	{Token: "beef", Label: "Beef", Aliases: []string{"beef", "steak", "veal", "sirloin", "brisket", "rump", "ribeye", "corned beef", "beef mince", "minced beef", "ground beef"}},
	{Token: "pork", Label: "Pork", Aliases: []string{"pork", "bacon", "ham", "pancetta", "prosciutto", "chorizo", "salami", "lard", "pepperoni"}},
	{Token: "chicken", Label: "Chicken", Aliases: []string{"chicken", "poultry", "murgh", "chicken breast", "chicken thigh"}},
	{Token: "mutton", Label: "Mutton and lamb", Aliases: []string{"mutton", "lamb", "goat", "gosht", "keema"}},
	{Token: "turkey", Label: "Turkey", Aliases: []string{"turkey"}},
	{Token: "duck", Label: "Duck", Aliases: []string{"duck"}},
	{Token: "gelatin", Label: "Gelatin", Aliases: []string{"gelatin", "gelatine"}},

	// Seafood. Fish and shellfish are separate allergen families.
	{Token: "fish", Label: "Fish", Family: FamilyFish, Aliases: []string{"fish", "salmon", "tuna", "cod", "mackerel", "sardine", "anchovy", "pomfret", "rohu", "hilsa", "barramundi", "snapper", "fish sauce"}},
	{Token: "shellfish", Label: "Shellfish", Family: FamilyShellfish, Aliases: []string{"shellfish", "prawn", "shrimp", "crab", "lobster", "squid", "calamari", "octopus", "mussel", "oyster", "clam", "scallop"}},

	// Dairy and egg.
	{Token: "dairy", Label: "Dairy", Family: FamilyDairy, Aliases: []string{"dairy", "milk", "cheese", "butter", "ghee", "cream", "yoghurt", "yogurt", "curd", "dahi", "paneer", "khoya", "mawa", "condensed milk", "whey", "casein", "buttermilk", "lassi"}},
	{Token: "egg", Label: "Egg", Family: FamilyEgg, Aliases: []string{"egg", "omelette", "omelet", "anda", "mayonnaise", "meringue"}},

	// Nuts and seeds.
	{Token: "peanut", Label: "Peanut", Family: FamilyPeanut, Aliases: []string{"peanut", "groundnut", "moongphali", "peanut butter"}},
	{Token: "tree nut", Label: "Tree nuts", Family: FamilyTreeNut, Aliases: []string{"tree nut", "nut", "almond", "cashew", "walnut", "pistachio", "hazelnut", "pecan", "macadamia", "badam", "kaju", "akhrot", "pista"}},
	{Token: "sesame", Label: "Sesame", Family: FamilySesame, Aliases: []string{"sesame", "til", "tahini", "gingelly"}},
	{Token: "mustard", Label: "Mustard", Family: FamilyMustard, Aliases: []string{"mustard", "sarson", "rai"}},

	// Grains and legumes.
	{Token: "gluten", Label: "Gluten", Family: FamilyGluten, Aliases: []string{"gluten", "wheat", "atta", "maida", "suji", "semolina", "rava", "barley", "rye", "seitan", "bread", "roti", "chapati", "chapatti", "naan", "paratha", "pasta", "noodle", "couscous", "toast", "biscuit", "cracker"}},
	{Token: "soy", Label: "Soy", Family: FamilySoy, Aliases: []string{"soy", "soya", "tofu", "edamame", "soy sauce", "tempeh"}},

	// Preferences and observance.
	{Token: "onion", Label: "Onion", Aliases: []string{"onion", "pyaz", "shallot", "spring onion", "scallion", "leek"}},
	{Token: "garlic", Label: "Garlic", Aliases: []string{"garlic", "lehsun"}},
	{Token: "root vegetable", Label: "Root vegetables", Aliases: []string{"root vegetable", "potato", "aloo", "carrot", "radish", "mooli", "beetroot", "beet", "turnip", "yam", "ginger", "sweet potato"}},
	{Token: "mushroom", Label: "Mushroom", Aliases: []string{"mushroom", "button mushroom", "shiitake", "truffle"}},
	{Token: "alcohol", Label: "Alcohol", Aliases: []string{"alcohol", "wine", "beer", "rum", "whisky", "whiskey", "vodka", "brandy", "liqueur"}},
	{Token: "honey", Label: "Honey", Aliases: []string{"honey", "shahad"}},
	{Token: "caffeine", Label: "Caffeine", Aliases: []string{"caffeine", "coffee", "espresso"}},
}

// byToken indexes the taxonomy for lookup by canonical token.
var byToken = func() map[string]Subject {
	out := make(map[string]Subject, len(subjects))
	for _, s := range subjects {
		out[s.Token] = s
	}
	return out
}()

// patternExclusions maps a diet pattern to the subjects it excludes. Indian
// vegetarian excludes egg; eggetarian is the variant that does not.
var patternExclusions = map[string][]string{
	PatternVegetarian:  {"beef", "pork", "chicken", "mutton", "turkey", "duck", "fish", "shellfish", "gelatin", "egg"},
	PatternEggetarian:  {"beef", "pork", "chicken", "mutton", "turkey", "duck", "fish", "shellfish", "gelatin"},
	PatternVegan:       {"beef", "pork", "chicken", "mutton", "turkey", "duck", "fish", "shellfish", "gelatin", "egg", "dairy", "honey"},
	PatternJain:        {"beef", "pork", "chicken", "mutton", "turkey", "duck", "fish", "shellfish", "gelatin", "egg", "onion", "garlic", "root vegetable"},
	PatternHalal:       {"pork", "gelatin", "alcohol"},
	PatternPescatarian: {"beef", "pork", "chicken", "mutton", "turkey", "duck", "gelatin"},
}

// Patterns lists the supported diet patterns, sorted for a stable API response.
func Patterns() []string {
	out := make([]string, 0, len(patternExclusions))
	for p := range patternExclusions {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// ValidPattern reports whether p is a supported pattern. The empty string is
// valid and means the user has not chosen one.
func ValidPattern(p string) bool {
	if p == PatternNone {
		return true
	}
	_, ok := patternExclusions[p]
	return ok
}

// CatalogEntry is one selectable subject, for a client building a rule picker.
type CatalogEntry struct {
	Subject string `json:"subject"`
	Label   string `json:"label"`
	Family  string `json:"family,omitempty"`
}

// Catalog is the taxonomy the API will accept, served alongside a user's rules
// so the client's picker cannot drift from what the server enforces.
func Catalog() []CatalogEntry {
	out := make([]CatalogEntry, 0, len(subjects))
	for _, s := range subjects {
		out = append(out, CatalogEntry{Subject: s.Token, Label: s.Label, Family: s.Family})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Label < out[j].Label })
	return out
}

// ValidSubject reports whether token names a canonical subject.
func ValidSubject(token string) bool {
	_, ok := byToken[token]
	return ok
}

// LabelFor returns the display label for a token, or the token itself when it
// is not in the taxonomy — a rule the user typed is still worth showing back.
func LabelFor(token string) string {
	if s, ok := byToken[token]; ok {
		return s.Label
	}
	return token
}

// ExpandPattern returns the rules a diet pattern puts in force. They are
// exclusions rather than allergies: a pattern is a choice, so it flags.
func ExpandPattern(pattern string) []Rule {
	tokens := patternExclusions[pattern]
	out := make([]Rule, 0, len(tokens))
	for _, t := range tokens {
		out = append(out, Rule{
			Subject:  t,
			Kind:     KindExclusion,
			Severity: SeverityFlag,
			Label:    LabelFor(t),
			Source:   SourcePattern,
		})
	}
	return out
}

// tokenize lowercases text and splits it into words, turning every
// non-alphanumeric rune into a boundary. "beef-free" becomes ["beef", "free"],
// which is what lets negation detection see the qualifier.
func tokenize(text string) []string {
	return strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
}

// wordsEqual compares two words with naive plural tolerance, so the taxonomy
// does not have to list both forms of every alias.
func wordsEqual(a, b string) bool {
	switch {
	case a == b:
		return true
	case a == b+"s", b == a+"s":
		return true
	case a == b+"es", b == a+"es":
		return true
	}
	return false
}
