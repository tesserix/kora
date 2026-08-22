package diet

import (
	"fmt"
	"sort"
	"strings"
)

// Violation is one rule broken by a piece of generated text.
type Violation struct {
	Subject  string `json:"subject"`
	Label    string `json:"label"`
	Kind     string `json:"kind"`
	Severity string `json:"severity"`
	Match    string `json:"match"`
}

// Screen finds the rules a generated answer breaks. A mention qualified by a
// negation cue is compliance, not a violation, so the coach can say "beef is
// iron-rich but you avoid it" without being blocked from saying it.
func Screen(text string, p Profile) []Violation {
	if p.Empty() || strings.TrimSpace(text) == "" {
		return nil
	}

	out := []Violation{}
	for _, h := range Match(text) {
		if h.Negated {
			continue
		}
		rule, ok := p.Rule(h.Subject)
		if !ok {
			continue
		}
		out = append(out, Violation{
			Subject:  rule.Subject,
			Label:    rule.Label,
			Kind:     rule.Kind,
			Severity: rule.Severity,
			Match:    h.Match,
		})
	}

	// Blocking violations first: callers act on the most severe and the order
	// must not depend on map iteration.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Severity != out[j].Severity {
			return out[i].Severity == SeverityBlock
		}
		return out[i].Subject < out[j].Subject
	})
	return out
}

// HasBlocking reports whether any violation is a hard constraint.
func HasBlocking(violations []Violation) bool {
	for _, v := range violations {
		if v.Severity == SeverityBlock {
			return true
		}
	}
	return false
}

// RenderConstraints is the prompt block that replaces the old free-text
// sentence. It states the constraints explicitly and separates the two
// severities, because an agent told everything is equally forbidden treats
// nothing as forbidden.
func RenderConstraints(p Profile) string {
	if p.Empty() {
		return ""
	}

	var b strings.Builder
	if blocked := p.Blocked(); len(blocked) > 0 {
		fmt.Fprintf(&b, " Hard dietary constraints, never recommend or include: %s.", labelList(blocked))
	}
	if flagged := p.Flagged(); len(flagged) > 0 {
		fmt.Fprintf(&b, " Avoid unless the user asks for it: %s.", labelList(flagged))
	}
	return b.String()
}

// RetryInstruction is appended when a first answer broke a hard constraint. It
// names the constraint rather than restating the whole rule set, so the retry
// stays pointed at what went wrong.
func RetryInstruction(violations []Violation) string {
	subjects := []string{}
	for _, v := range violations {
		if v.Severity == SeverityBlock {
			subjects = append(subjects, v.Subject)
		}
	}
	if len(subjects) == 0 {
		return ""
	}
	sort.Strings(subjects)
	return fmt.Sprintf(
		"Your previous answer included %s, which the user must never be given. Answer again without it, and do not mention that you are retrying.",
		labelList(subjects))
}

func labelList(subjects []string) string {
	labels := make([]string, 0, len(subjects))
	for _, s := range subjects {
		labels = append(labels, strings.ToLower(LabelFor(s)))
	}
	return strings.Join(labels, ", ")
}
