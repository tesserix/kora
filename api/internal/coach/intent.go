package coach

import (
	"context"
	"log/slog"
	"strings"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"

	"github.com/tesserix/kora/api/internal/aitrace"
)

// planningSkill is the registry skill id a multi-day plan request routes to.
// Like guidanceSkill it names a CAPABILITY, not an agent: the Kora Meal
// Planner card declares it today, and swapping in a better planner is a
// registry republish rather than a Kora deploy.
const planningSkill = "plan-meals"

// planReviewSkill is the capability that reviews a planner draft before the
// user ever sees it. It is deliberately not guidanceSkill: reviewing a plan
// against someone's targets is a supervisory job with its own contract, and
// separating it lets the registry publish a specialist without changing the
// agent that answers ordinary questions.
const planReviewSkill = "review-meal-plan"

// Routes a message from the capture composer can take. RouteLog is the only
// one that ends in food being written to the diary.
const (
	RouteLog  = "log"
	RoutePlan = "plan"
	RouteAsk  = "ask"
)

// intentSystemPrompt asks for one token and nothing else. The classifier runs
// on every message, so it is deliberately the cheapest call in the path — no
// grounding, no history, no prose.
//
// The log/ask split is the one that matters most: everything used to be
// treated as log, so a question was answered with invented food.
const intentSystemPrompt = `You route a nutrition app user's message.
Answer with exactly one word, lowercase, nothing else:

log   - they are telling you what they ALREADY ate or drank, so it can be recorded
plan  - they want a meal plan, menu, or schedule BUILT for them over one or more days
ask   - anything else: a question, advice, a check-in, or a comment

Examples:
"two eggs and a slice of toast" -> log
"I had a chicken salad for lunch" -> log
"create a meal plan for next week to lose fat" -> plan
"what should I eat for dinner tomorrow and the rest of the week" -> plan
"plan my meals" -> plan
"is brown rice better than white" -> ask
"how am I doing on protein" -> ask
"can you please help create a proper meal plan for the next 1 week to help me reduce my fat" -> plan`

// classifySkill picks the A2A capability a question should route to.
//
// This exists because the alternative — a keyword table — is what produced the
// bug it replaces: "help me build a meal plan" was matched as food and logged
// as if the user had eaten it. Intent is a language judgement, so a language
// model makes it.
//
// Any failure returns guidanceSkill. The coach answering a plan request as
// prose is a worse answer; the planner answering a plain question, or no
// answer at all, is a wrong one.
func (s *Service) classifySkill(ctx context.Context, question string) string {
	// Routing only decides which agent card serves the question. With no
	// runner the direct provider answers either way, so the classifier call
	// would buy nothing and still cost a request.
	if s.runner == nil {
		return guidanceSkill
	}
	if s.ClassifyRoute(ctx, question) == RoutePlan {
		return planningSkill
	}
	return guidanceSkill
}

// ClassifyRoute decides what a message from the capture composer IS, before
// anything acts on it. RouteLog on any failure: the composer's primary job is
// logging food, and a question mis-sent to the resolver is the pre-existing
// behaviour rather than a new one.
func (s *Service) ClassifyRoute(ctx context.Context, text string) string {
	if s.provider == nil {
		return RouteLog
	}
	ctx, span := aitrace.Start(ctx, "intent.classify")
	defer span.End()

	route := RouteLog
	raw, _, err := s.provider.GenerateText(ctx, intentSystemPrompt, text)
	if err != nil {
		slog.WarnContext(ctx, "coach: intent classification failed, treating as a food log", "err", err)
		span.SetStatus(codes.Error, "classification failed")
	} else {
		switch strings.ToLower(strings.TrimSpace(raw)) {
		case RoutePlan:
			route = RoutePlan
		case RouteAsk:
			route = RouteAsk
		}
	}
	span.SetAttributes(attribute.String("kora.intent.route", route))
	return route
}
