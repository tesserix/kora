package coach

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/diet"
)

// screenDiet enforces a user's confirmed dietary rules on a generated answer.
//
// Severity decides the response, which is the whole point of storing it: a
// blocking rule is a medical or absolute constraint and its violation must not
// reach the user, while a flagging rule is a preference and suppressing an
// otherwise good answer over it would be worse than annotating it.
//
// Returns the text to show, the flagging violations to annotate, and whether a
// blocking violation survived — a caller must drop any commitment proposal
// parsed out of an answer that was replaced.
func (s *Service) screenDiet(
	ctx context.Context,
	userID uuid.UUID,
	profile diet.Profile,
	userPrompt, skill, raw string,
	viaAgent bool,
) (string, []diet.Violation, bool) {
	if profile.Empty() {
		return raw, nil, false
	}

	violations := diet.Screen(raw, profile)
	if !diet.HasBlocking(violations) {
		return raw, violations, false
	}

	slog.WarnContext(ctx, "coach: answer broke a hard dietary constraint, retrying",
		"user_id", userID, "skill", skill, "subjects", blockedSubjects(violations))

	retried, err := s.regenerate(ctx, userID, userPrompt+"\n"+diet.RetryInstruction(violations), skill, viaAgent)
	if err == nil && strings.TrimSpace(retried) != "" {
		if skill == planningSkill {
			retried = formatPlanDraft(retried)
		}
		// The retry is not re-reviewed by the coach: this is a safety redo,
		// and a second review call buys less than answering promptly.
		if again := diet.Screen(retried, profile); !diet.HasBlocking(again) {
			return retried, again, false
		}
	}

	slog.WarnContext(ctx, "coach: retry still broke a hard dietary constraint, withholding the answer",
		"user_id", userID, "skill", skill, "err", err)
	return dietBlockedText(violations), nil, true
}

// dietFlags is what a client is told about the preferences an answer touches.
// Always a list, never null: the client renders "this mentions something you
// prefer to avoid" next to the answer, and an absent key would make "no flags"
// look like an older server that never checked.
func dietFlags(a Answer) []diet.Violation {
	if a.DietFlags == nil {
		return []diet.Violation{}
	}
	return a.DietFlags
}

// regenerate re-runs the same path that produced an answer. Falling back to the
// provider when the agent retry fails keeps the retry from costing the user an
// answer entirely.
func (s *Service) regenerate(
	ctx context.Context,
	userID uuid.UUID,
	userPrompt, skill string,
	viaAgent bool,
) (string, error) {
	if viaAgent {
		if raw, _, err := s.askAgent(ctx, userID, userPrompt, skill); err == nil {
			return raw, nil
		}
	}
	return s.askProvider(ctx, userID, userPrompt)
}

// dietBlockedText is what a user sees instead of an answer that could not be
// made safe. It names the constraint: "something went wrong" would leave them
// unable to tell a bug from a rule working as intended.
func dietBlockedText(violations []diet.Violation) string {
	subjects := blockedSubjects(violations)
	if len(subjects) == 0 {
		return "I couldn't put that together safely — try asking me again."
	}
	labels := make([]string, 0, len(subjects))
	for _, s := range subjects {
		labels = append(labels, strings.ToLower(diet.LabelFor(s)))
	}
	return fmt.Sprintf(
		"I drafted that with %s in it, which you've told me to keep out, so I'm not going to show it. Ask me again and I'll work around it.",
		strings.Join(labels, " and "))
}

func blockedSubjects(violations []diet.Violation) []string {
	out := []string{}
	for _, v := range violations {
		if v.Severity == diet.SeverityBlock {
			out = append(out, v.Subject)
		}
	}
	return out
}
