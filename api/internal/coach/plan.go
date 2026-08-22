package coach

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/mentor"
)

const (
	commitmentProposalStart = "[[KORA_COMMITMENT]]"
	commitmentProposalEnd   = "[[/KORA_COMMITMENT]]"
	maxCommitmentProposal   = 2048
)

// reviewSystemPrompt turns the planner's draft into the message the user
// actually reads. The planner speaks JSON (its card's contract is a machine
// plan: summary + days + meals); showing that verbatim is what this stage
// replaces. The coach checks the draft against the user's own numbers, keeps
// or amends it, justifies each day, and hands the decision back to the user —
// the plan is a proposal until they approve it.
const reviewSystemPrompt = `You are the user's nutrition coach. The meal-planner agent has drafted a plan for them, and your job is to review it against the CONTEXT numbers and present it.

Write one friendly message, plain text (no markdown headings or tables):
1. Open with your verdict in one or two sentences: does the draft fit their calorie and protein targets? If you amended anything, say what and why.
2. Then the plan, day by day. Each day: the day name, its meals each on its own line as "- Meal name — one short reason it earns its place" (protein, calories, fibre, satiety — justify against THEIR targets, not generic advice).
3. Close by asking them to confirm: approve it as-is, or tell you any meal or day they want changed, and you will rework it with the planner.

Never invent nutrition numbers that are not in the CONTEXT or the draft. Keep the friendly message under 350 words.

If and only if the user explicitly requested a repeatable action or reminder and its exact schedule is present in their request or the draft, append this machine block after the friendly message:
[[KORA_COMMITMENT]]
{"title":"...","kind":"hydration|walking|meal|custom","cadence":"fixed|interval","weekdays_mask":1-127,"start_minute":0-1439,"interval_minutes":null or 30-720,"end_minute":null or 0-1439}
[[/KORA_COMMITMENT]]
For fixed cadence, interval_minutes and end_minute must be null. For interval cadence, both are required and end_minute must be after start_minute. Never guess a time, frequency, or weekday. Do not emit the block for a meal plan alone. Emit at most one block.`

func parseReviewedCommitment(
	text string,
	userID uuid.UUID,
	now time.Time,
	loc *time.Location,
	agentName, reviewedBy string,
) (string, *mentor.CommitmentProposal) {
	start := strings.Index(text, commitmentProposalStart)
	if start < 0 {
		return text, nil
	}
	payloadStart := start + len(commitmentProposalStart)
	endOffset := strings.Index(text[payloadStart:], commitmentProposalEnd)
	if endOffset < 0 {
		return strings.TrimSpace(text[:start]), nil
	}
	end := payloadStart + endOffset
	clean := strings.TrimSpace(text[:start] + text[end+len(commitmentProposalEnd):])
	payload := strings.TrimSpace(text[payloadStart:end])
	if len(payload) == 0 || len(payload) > maxCommitmentProposal {
		return clean, nil
	}
	var draft mentor.CommitmentProposalDraft
	decoder := json.NewDecoder(strings.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&draft); err != nil {
		return clean, nil
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return clean, nil
	}
	proposal, err := mentor.NewCommitmentProposal(userID, now, loc, draft, agentName, reviewedBy)
	if err != nil {
		return clean, nil
	}
	return clean, proposal
}

// reviewPlan runs the coach over a planner draft and returns the reviewed
// message plus the reviewer's display name. Empty strings mean the review
// could not happen — the caller keeps the draft, because a raw draft is a
// worse answer than a reviewed one but still an answer.
func (s *Service) reviewPlan(ctx context.Context, userID uuid.UUID, grounded, question, draft string) (string, string) {
	prompt := fmt.Sprintf("CONTEXT:\n%s\nREQUEST: %s\nDRAFT PLAN (from the meal-planner agent):\n%s\n\nReview and present this plan.", grounded, question, draft)

	// The reviewer is whichever published agent carries the guidance skill —
	// the same routing Q&A uses, so a registry republish swaps the coach here
	// too. Its published system prompt is bypassed on purpose: this call is a
	// review, not a Q&A turn, so the review instructions ride in the body.
	if reviewed, run, err := s.askAgent(ctx, userID, reviewSystemPrompt+"\n\n"+prompt, guidanceSkill); err == nil {
		return reviewed, run.DisplayName
	} else if err != errNoAgent {
		slog.WarnContext(ctx, "coach: plan review via agent failed, trying the provider", "err", err)
	}

	if s.provider == nil {
		return "", ""
	}
	reviewed, err := s.generate(ctx, userID, reviewSystemPrompt, prompt)
	if err != nil {
		slog.WarnContext(ctx, "coach: plan review failed, returning the draft", "err", err)
		return "", ""
	}
	// The provider has no registry card, so the reviewer is the app's own
	// coach persona rather than a published agent name.
	return reviewed, "Otto"
}

// planEnvelope is the meal-planner card's machine contract — the shape whose
// verbatim JSON the review stage exists to replace.
type planEnvelope struct {
	Summary string `json:"summary"`
	Days    []struct {
		Date  string `json:"date"`
		Meals []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"meals"`
	} `json:"days"`
}

// formatPlanDraft renders a planner draft as prose. The review stage normally
// does this with the user's own numbers; this is the floor under it, so a
// failed review costs the user a good answer rather than a readable one.
func formatPlanDraft(draft string) string {
	body := strings.TrimSpace(draft)
	if fenced := strings.TrimPrefix(body, "```json"); fenced != body {
		body = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(fenced), "```"))
	} else if fenced := strings.TrimPrefix(body, "```"); fenced != body {
		body = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(fenced), "```"))
	}
	var plan planEnvelope
	if err := json.Unmarshal([]byte(body), &plan); err != nil || len(plan.Days) == 0 {
		return draft
	}

	var out strings.Builder
	if summary := strings.TrimSpace(plan.Summary); summary != "" {
		out.WriteString(summary)
	}
	for _, day := range plan.Days {
		if out.Len() > 0 {
			out.WriteString("\n\n")
		}
		if date := strings.TrimSpace(day.Date); date != "" {
			out.WriteString(date)
		}
		for _, meal := range day.Meals {
			name := strings.TrimSpace(meal.Name)
			if name == "" {
				continue
			}
			if out.Len() > 0 {
				out.WriteString("\n")
			}
			out.WriteString("- " + name)
			if desc := strings.TrimSpace(meal.Description); desc != "" {
				out.WriteString(" — " + desc)
			}
		}
	}
	return out.String()
}
