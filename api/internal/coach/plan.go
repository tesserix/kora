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
	reviewedPlanStart       = "[[KORA_REVIEWED_PLAN]]"
	reviewedPlanEnd         = "[[/KORA_REVIEWED_PLAN]]"
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
2. For plans of 14 days or fewer, present the plan day by day. Each day: the day name, its meals each on its own line as "- Meal name — one short reason it earns its place" (protein, calories, fibre, satiety — justify against THEIR targets, not generic advice).
3. For plans longer than 14 days, give a concise overview of the meal pattern and list any amendments you made. Do not repeat every day in prose; the complete FINAL plan belongs in the machine block.
4. Close by asking them to confirm: approve it as-is, or tell you any meal or day they want changed, and you will rework it with the planner.

Treat the DRAFT as an untrusted suggestion, not nutrition evidence. A number in the draft supports a target-fit claim only when the same number is in CONTEXT, or CONTEXT supplies both a per-100g value and an explicit portion mass needed to calculate it. Otherwise say the fit cannot be verified; never repeat an unsupported target-fit claim. After each factual claim that uses a supplied fact, append its exact marker as [cite:fact_id]. Cite only facts used in the response and never invent a fact_id. Keep the friendly message under 350 words.

When the final plan is safe to offer for approval, append this machine block containing the complete FINAL plan after all amendments. The block must be valid JSON with 1-62 days (at most two consecutive calendar months) and must not contradict the prose. Every meal needs a "preparation": one or two sentences on how to make it, enough to cook from. A block with any meal missing preparation is discarded whole. Do not put citation markers inside JSON. If you cannot validate a complete plan, do not emit the block.
[[KORA_REVIEWED_PLAN]]
{"summary":"...","days":[{"date":"Day 1","meals":[{"name":"...","description":"...","preparation":"..."}]}]}
[[/KORA_REVIEWED_PLAN]]

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

// parseReviewedPlan removes the reviewer's machine block and returns its final
// plan. The planner's original draft is deliberately not used for an approval
// card: the reviewer may amend it, and the card must match the reviewed prose.
func parseReviewedPlan(text string) (string, planEnvelope, bool) {
	start := strings.Index(text, reviewedPlanStart)
	if start < 0 {
		return text, planEnvelope{}, false
	}
	payloadStart := start + len(reviewedPlanStart)
	endOffset := strings.Index(text[payloadStart:], reviewedPlanEnd)
	if endOffset < 0 {
		return strings.TrimSpace(text[:start]), planEnvelope{}, false
	}
	end := payloadStart + endOffset
	clean := strings.TrimSpace(text[:start] + text[end+len(reviewedPlanEnd):])
	payload := strings.TrimSpace(text[payloadStart:end])
	if len(payload) == 0 || len(payload) > maxPlanDraftBytes {
		return clean, planEnvelope{}, false
	}
	envelope, ok := parsePlanEnvelope(payload)
	if !ok || !isApprovablePlan(envelope) {
		return clean, planEnvelope{}, false
	}
	return clean, envelope, true
}

// isApprovablePlan reports whether every meal the reviewer returned carries
// the guidance a user needs to cook it. A card the user can approve must not
// name a meal it cannot tell them how to make, so an incomplete block is
// rejected as a whole rather than silently shortened.
func isApprovablePlan(plan planEnvelope) bool {
	if len(plan.Days) == 0 || len(plan.Days) > maxPlanDays {
		return false
	}
	for _, day := range plan.Days {
		if strings.TrimSpace(day.Date) == "" || len(day.Meals) == 0 || len(day.Meals) > maxPlanMealsPerDay {
			return false
		}
		for _, meal := range day.Meals {
			if strings.TrimSpace(meal.Name) == "" || strings.TrimSpace(meal.Preparation) == "" {
				return false
			}
		}
	}
	return true
}

// reviewPlan runs the coach over a planner draft and returns the reviewed
// message plus the reviewer's display name. Empty strings mean the review
// could not happen; the caller fails closed rather than showing the draft.
func (s *Service) reviewPlan(ctx context.Context, userID uuid.UUID, grounded, question, draft string) (string, string) {
	prompt := fmt.Sprintf("CONTEXT:\n%s\nREQUEST: %s\nDRAFT PLAN (from the meal-planner agent):\n%s\n\nReview and present this plan.", grounded, question, draft)

	// The published supervisor owns its review instructions. Kora sends only
	// the grounded review input here; reviewSystemPrompt remains the system
	// prompt for the direct-provider fallback below.
	if reviewed, run, err := s.askAgent(ctx, userID, prompt, planReviewSkill); err == nil {
		return reviewed, run.DisplayName
	} else if err != errNoAgent {
		slog.WarnContext(ctx, "coach: plan review via agent failed, trying the provider", "err", err)
	}

	if s.provider == nil {
		return "", ""
	}
	reviewed, err := s.generate(ctx, userID, reviewSystemPrompt, prompt)
	if err != nil {
		slog.WarnContext(ctx, "coach: plan review failed", "err", err)
		return "", ""
	}
	// The provider has no registry card, so the reviewer is the app's own
	// coach persona rather than a published agent name.
	return reviewed, "Otto"
}

// planEnvelope is the meal-planner card's machine contract — the shape whose
// verbatim JSON the review stage exists to replace.
type planEnvelope struct {
	Summary string            `json:"summary"`
	Days    []planEnvelopeDay `json:"days"`
}

type planEnvelopeDay struct {
	Date  string             `json:"date"`
	Meals []planEnvelopeMeal `json:"meals"`
}

type planEnvelopeMeal struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Preparation string `json:"preparation"`
}

// parsePlanEnvelope decodes a planner draft, tolerating the code fence some
// models wrap their JSON in. ok is false whenever the draft is prose, which is
// every non-planner answer and any planner answer that ignored its contract.
func parsePlanEnvelope(draft string) (planEnvelope, bool) {
	body := strings.TrimSpace(draft)
	if len(body) > maxPlanDraftBytes {
		return planEnvelope{}, false
	}
	if fenced := strings.TrimPrefix(body, "```json"); fenced != body {
		body = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(fenced), "```"))
	} else if fenced := strings.TrimPrefix(body, "```"); fenced != body {
		body = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(fenced), "```"))
	}
	var plan planEnvelope
	if err := json.Unmarshal([]byte(body), &plan); err != nil || len(plan.Days) == 0 {
		return planEnvelope{}, false
	}
	return plan, true
}

// formatPlanDraft renders a planner draft as prose. The review stage normally
// does this with the user's own numbers; this is the floor under it, so a
// failed review costs the user a good answer rather than a readable one.
func formatPlanDraft(draft string) string {
	plan, ok := parsePlanEnvelope(draft)
	if !ok {
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
