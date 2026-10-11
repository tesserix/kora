package diet

import "sort"

// Rule is one dietary constraint in canonical form.
type Rule struct {
	Subject  string `json:"subject"`
	Kind     string `json:"kind"`
	Severity string `json:"severity"`
	Label    string `json:"label"`
	Source   string `json:"source"`
}

// ValidKind and ValidSeverity guard the API and the database check constraints
// from drifting apart.
func ValidKind(kind string) bool {
	return kind == KindAllergy || kind == KindExclusion || kind == KindPreference
}

func ValidSeverity(severity string) bool {
	return severity == SeverityBlock || severity == SeverityFlag
}

// DefaultSeverity is the severity a rule takes when the caller does not choose
// one: allergies block, everything else flags.
func DefaultSeverity(kind string) string {
	if kind == KindAllergy {
		return SeverityBlock
	}
	return SeverityFlag
}

// Profile is a compiled rule set, built once per turn and shared by every gate
// so a prompt, an answer and a food candidate are all judged identically.
type Profile struct {
	rules map[string]Rule
}

// Compile indexes rules by subject. Later rules win, and a blocking rule always
// wins over a flagging one for the same subject — a pattern must never soften
// an allergy the user also declared.
func Compile(rules []Rule) Profile {
	out := Profile{rules: make(map[string]Rule, len(rules))}
	for _, r := range rules {
		if r.Subject == "" {
			continue
		}
		if existing, ok := out.rules[r.Subject]; ok && existing.Severity == SeverityBlock {
			continue
		}
		out.rules[r.Subject] = r
	}
	return out
}

// Empty reports whether the profile constrains nothing, which lets callers skip
// every gate for the majority of users who have set no rules.
func (p Profile) Empty() bool { return len(p.rules) == 0 }

// Rules returns the compiled rules sorted by subject, for rendering.
func (p Profile) Rules() []Rule {
	out := make([]Rule, 0, len(p.rules))
	for _, r := range p.rules {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Subject < out[j].Subject })
	return out
}

// Blocked and Flagged return the subjects at each severity, sorted.
func (p Profile) Blocked() []string { return p.subjectsWith(SeverityBlock) }
func (p Profile) Flagged() []string { return p.subjectsWith(SeverityFlag) }

func (p Profile) subjectsWith(severity string) []string {
	out := []string{}
	for _, r := range p.rules {
		if r.Severity == severity {
			out = append(out, r.Subject)
		}
	}
	sort.Strings(out)
	return out
}

// Rule looks up the compiled rule for a subject.
func (p Profile) Rule(subject string) (Rule, bool) {
	r, ok := p.rules[subject]
	return r, ok
}
