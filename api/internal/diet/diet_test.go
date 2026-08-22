package diet

import (
	"reflect"
	"testing"
)

func TestSubjectsFindsAliasesAndPlurals(t *testing.T) {
	tests := []struct {
		name string
		text string
		want []string
	}{
		{"canonical", "Monday: beef stir-fry", []string{"beef"}},
		{"alias", "grilled sirloin with salad", []string{"beef"}},
		{"plural", "roasted peanuts and rice", []string{"peanut"}},
		{"indian alias", "paneer butter masala", []string{"dairy"}},
		{"family widening", "cashew curry", []string{"tree nut"}},
		{"multi word", "peanut butter on toast", []string{"gluten", "peanut"}},
		{"nothing", "steamed rice and dal", nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Subjects(tt.text)
			if len(got) == 0 && len(tt.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("Subjects(%q) = %v, want %v", tt.text, got, tt.want)
			}
		})
	}
}

func TestMatchNegation(t *testing.T) {
	negated := []string{
		"a beef-free week",
		"no beef this week",
		"swap the beef for paneer",
		"lentils instead of beef",
		"Tuesday's curry without beef",
	}
	for _, text := range negated {
		hits := Match(text)
		if len(hits) == 0 {
			t.Fatalf("Match(%q) found nothing", text)
		}
		for _, h := range hits {
			if h.Subject == "beef" && !h.Negated {
				t.Fatalf("Match(%q) treated beef as affirmative", text)
			}
		}
	}

	// An affirmative mention anywhere outweighs a negated one: a plan that
	// offers beef as an option is a recommendation regardless of hedging.
	hits := Match("skip the beef on Monday, then beef curry on Tuesday")
	for _, h := range hits {
		if h.Subject == "beef" && h.Negated {
			t.Fatal("an affirmative mention was overridden by a negated one")
		}
	}

	// The known limit, asserted so it is a decision rather than a surprise:
	// discussing a food reads as recommending it. Erring this way costs one
	// retry; erring the other way serves an allergen.
	discussion := Match("beef is a common iron source")
	if len(discussion) != 1 || discussion[0].Negated {
		t.Fatalf("a bare mention must read as affirmative, got %+v", discussion)
	}
}

func TestScreenSplitsBySeverity(t *testing.T) {
	profile := Compile([]Rule{
		{Subject: "peanut", Kind: KindAllergy, Severity: SeverityBlock, Label: "Peanut"},
		{Subject: "mushroom", Kind: KindPreference, Severity: SeverityFlag, Label: "Mushroom"},
	})

	got := Screen("mushroom soup with a peanut garnish", profile)
	if len(got) != 2 {
		t.Fatalf("Screen found %d violations, want 2: %+v", len(got), got)
	}
	if got[0].Severity != SeverityBlock {
		t.Fatalf("blocking violation must sort first, got %+v", got)
	}
	if !HasBlocking(got) {
		t.Fatal("HasBlocking = false, want true")
	}

	if v := Screen("a peanut-free lunch", profile); len(v) != 0 {
		t.Fatalf("Screen flagged a compliant answer: %+v", v)
	}
	if v := Screen("grilled fish", profile); len(v) != 0 {
		t.Fatalf("Screen flagged an unconstrained food: %+v", v)
	}
	if v := Screen("peanut sauce", Profile{}); len(v) != 0 {
		t.Fatalf("an empty profile constrains nothing, got %+v", v)
	}
}

func TestCompileKeepsBlockOverFlag(t *testing.T) {
	// A vegetarian pattern must never soften an allergy on the same subject.
	profile := Compile([]Rule{
		{Subject: "fish", Kind: KindAllergy, Severity: SeverityBlock, Source: SourceUser},
		{Subject: "fish", Kind: KindExclusion, Severity: SeverityFlag, Source: SourcePattern},
	})
	rule, ok := profile.Rule("fish")
	if !ok || rule.Severity != SeverityBlock {
		t.Fatalf("Rule(fish) = %+v, %v; want a blocking rule", rule, ok)
	}
}

func TestExpandPattern(t *testing.T) {
	has := func(rules []Rule, subject string) bool {
		for _, r := range rules {
			if r.Subject == subject {
				return true
			}
		}
		return false
	}

	veg := ExpandPattern(PatternVegetarian)
	if !has(veg, "egg") {
		t.Error("Indian vegetarian excludes egg")
	}
	if !has(veg, "beef") || !has(veg, "fish") {
		t.Error("vegetarian excludes meat and fish")
	}

	if egg := ExpandPattern(PatternEggetarian); has(egg, "egg") {
		t.Error("eggetarian is the variant that allows egg")
	}
	if jain := ExpandPattern(PatternJain); !has(jain, "onion") || !has(jain, "root vegetable") {
		t.Error("jain excludes onion, garlic and root vegetables")
	}
	if vegan := ExpandPattern(PatternVegan); !has(vegan, "dairy") || !has(vegan, "honey") {
		t.Error("vegan excludes dairy and honey")
	}
	if pesc := ExpandPattern(PatternPescatarian); has(pesc, "fish") {
		t.Error("pescatarian allows fish")
	}
	if len(ExpandPattern(PatternNone)) != 0 {
		t.Error("no pattern excludes nothing")
	}
}

func TestParseIgnoresNegation(t *testing.T) {
	// "no beef" typed into a preferences box means beef is excluded. Reading
	// the cue as compliance would drop the rule the user was stating.
	rules := Parse("no beef, and I'm allergic to peanuts", KindExclusion)
	if len(rules) != 2 {
		t.Fatalf("Parse found %d rules, want 2: %+v", len(rules), rules)
	}
	for _, r := range rules {
		if r.Severity != SeverityFlag || r.Kind != KindExclusion {
			t.Fatalf("Parse produced %+v, want an exclusion that flags", r)
		}
	}

	allergies := ParseProfileText("I avoid mushroom", "peanuts")
	for _, r := range allergies {
		if r.Subject == "peanut" && r.Severity != SeverityBlock {
			t.Fatalf("an allergy must compile to a blocking rule, got %+v", r)
		}
		if r.Subject == "mushroom" && r.Severity != SeverityFlag {
			t.Fatalf("a preference must flag, got %+v", r)
		}
	}
}

func TestTagsFor(t *testing.T) {
	got := TagsFor("Pakhala bhata", "", []string{"rice_raw", "curd", "water"})
	want := []string{"contains-dairy"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("TagsFor = %v, want %v", got, want)
	}

	// Ingredients are authoritative where a source has them; name and brand are
	// the fallback for sources that do not.
	if got := TagsFor("Beef vindaloo", "", nil); !reflect.DeepEqual(got, []string{"contains-beef"}) {
		t.Fatalf("TagsFor(name only) = %v", got)
	}

	if tag := TagFor("tree nut"); tag != "contains-tree-nut" {
		t.Fatalf("TagFor = %q", tag)
	}
	subject, ok := SubjectFromTag("contains-tree-nut")
	if !ok || subject != "tree nut" {
		t.Fatalf("SubjectFromTag = %q, %v", subject, ok)
	}
	if _, ok := SubjectFromTag("vegetarian"); ok {
		t.Fatal("SubjectFromTag accepted a non-containment tag")
	}
}

func TestRenderConstraintsSeparatesSeverities(t *testing.T) {
	profile := Compile([]Rule{
		{Subject: "peanut", Kind: KindAllergy, Severity: SeverityBlock, Label: "Peanut"},
		{Subject: "mushroom", Kind: KindPreference, Severity: SeverityFlag, Label: "Mushroom"},
	})
	got := RenderConstraints(profile)
	if got == "" {
		t.Fatal("RenderConstraints returned nothing for a non-empty profile")
	}
	if want := "never recommend or include: peanut."; !contains(got, want) {
		t.Fatalf("RenderConstraints = %q, want it to contain %q", got, want)
	}
	if want := "Avoid unless the user asks for it: mushroom."; !contains(got, want) {
		t.Fatalf("RenderConstraints = %q, want it to contain %q", got, want)
	}
	if RenderConstraints(Profile{}) != "" {
		t.Fatal("an empty profile renders nothing")
	}
}

func TestRetryInstructionNamesOnlyBlockingSubjects(t *testing.T) {
	got := RetryInstruction([]Violation{
		{Subject: "peanut", Severity: SeverityBlock},
		{Subject: "mushroom", Severity: SeverityFlag},
	})
	if !contains(got, "peanut") {
		t.Fatalf("RetryInstruction = %q, want it to name peanut", got)
	}
	if contains(got, "mushroom") {
		t.Fatalf("RetryInstruction = %q, must not name a flagging subject", got)
	}
	if RetryInstruction([]Violation{{Subject: "mushroom", Severity: SeverityFlag}}) != "" {
		t.Fatal("no blocking violation means no retry")
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle || indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
