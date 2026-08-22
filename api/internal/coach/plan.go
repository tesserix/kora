package coach

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
)

// reviewSystemPrompt turns the planner's draft into the message the user
// actually reads. The planner speaks JSON (its card's contract is a machine
// plan: summary + days + meals); showing that verbatim is what this stage
// replaces. The coach checks the draft against the user's own numbers, keeps
// or amends it, justifies each day, and hands the decision back to the user —
// the plan is a proposal until they approve it.
const reviewSystemPrompt = `You are the user's nutrition coach. The meal-planner agent has drafted a plan for them, and your job is to review it against the CONTEXT numbers and present it.

Write one friendly message, plain text (no JSON, no markdown headings or tables):
1. Open with your verdict in one or two sentences: does the draft fit their calorie and protein targets? If you amended anything, say what and why.
2. Then the plan, day by day. Each day: the day name, its meals each on its own line as "- Meal name — one short reason it earns its place" (protein, calories, fibre, satiety — justify against THEIR targets, not generic advice).
3. Close by asking them to confirm: approve it as-is, or tell you any meal or day they want changed, and you will rework it with the planner.

Never invent nutrition numbers that are not in the CONTEXT or the draft. Keep the whole message under 350 words.`

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
