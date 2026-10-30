package onboarding

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/guardrails"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// ottoChange is the model's JSON. Absent fields mean "no change".
type ottoChange struct {
	ActivityLevel    *string  `json:"activity_level"`
	Goal             *string  `json:"goal"`
	GoalWeightKg     *float64 `json:"goal_weight_kg"`
	PaceKgPerWeek    *float64 `json:"pace_kg_per_week"`
	KcalOverride     *float64 `json:"kcal_override"`
	ProteinOverrideG *float64 `json:"protein_override_g"`

	ClearKcalOverride    bool `json:"clear_kcal_override"`
	ClearProteinOverride bool `json:"clear_protein_override"`
}

type ottoReply struct {
	Reply  string      `json:"reply"`
	Change *ottoChange `json:"change"`
}

// PlanChange is one field that differs between the current and proposed plan.
type PlanChange struct {
	Field string `json:"field"` // activity_level|goal|goal_weight_kg|pace_kg_per_week|kcal|protein_g|carbs_g|fat_g
	From  any    `json:"from"`  // string for enums, number rounded to 1 dp (weight/pace) or 0 dp (kcal, grams)
	To    any    `json:"to"`
}

const ottoSystemPrompt = `You are Otto, Kora's nutrition coach, helping a user adjust their daily plan. You receive JSON with the user's message, their current plan inputs, and the targets Kora calculated. Reply with JSON ONLY, no code fences, exactly matching: {"reply": string, "change": object|null}. "reply" is one to three short, warm sentences in plain language. "change" may contain only these keys: "activity_level" (sedentary|light|moderate|active|very_active), "goal" (fat_loss|maintenance|muscle_gain), "goal_weight_kg" (number), "pace_kg_per_week" (number), "kcal_override" (number), "protein_override_g" (number), "clear_kcal_override" (true), "clear_protein_override" (true). Set "change" to null when the message is a question or nothing should change. When the user gives a range from a professional, use its midpoint rounded to a whole number. Never suggest calories below the "bmr" value in the targets. Never give medical advice; suggest a healthcare professional for medical concerns. Kora checks every number you suggest and may refuse it.`

func parseOttoReply(raw string) (ottoReply, error) {
	var r ottoReply
	if err := json.Unmarshal([]byte(stripFence(raw)), &r); err != nil {
		return ottoReply{}, fmt.Errorf("onboarding: otto reply is not JSON: %w", err)
	}
	if strings.TrimSpace(r.Reply) == "" {
		return ottoReply{}, errors.New("onboarding: otto reply is empty")
	}
	return r, nil
}

// apply returns in with the change laid over it. Unknown enum values are
// ignored; Calculate remains the judge of every number.
func (c ottoChange) apply(in Input) Input {
	if c.ActivityLevel != nil {
		if _, ok := activityFactors[*c.ActivityLevel]; ok {
			in.ActivityLevel = *c.ActivityLevel
		}
	}
	if c.Goal != nil && validGoals[*c.Goal] {
		in.Goal = *c.Goal
	}
	if c.GoalWeightKg != nil {
		in.GoalWeightKg = *c.GoalWeightKg
	}
	if c.PaceKgPerWeek != nil {
		in.PaceKgPerWeek = *c.PaceKgPerWeek
	}
	// Maintenance has no destination; leaving the old one would trip
	// Calculate's direction checks on a later switch back.
	if in.Goal == "maintenance" {
		in.GoalWeightKg, in.PaceKgPerWeek = 0, 0
	}
	if c.ClearKcalOverride {
		in.KcalOverride = nil
	}
	if c.KcalOverride != nil {
		in.KcalOverride = c.KcalOverride
	}
	if c.ClearProteinOverride {
		in.ProteinOverrideG = nil
	}
	if c.ProteinOverrideG != nil {
		in.ProteinOverrideG = c.ProteinOverrideG
	}
	return in
}

func (c *ottoChange) empty() bool {
	return c == nil || *c == ottoChange{}
}

func round0(x float64) float64 { return math.Round(x) }
func round1(x float64) float64 { return math.Round(x*10) / 10 }

// planChanges lists only the fields that differ after rounding, so noise
// below the displayed precision never shows up as a change.
func planChanges(oldIn, newIn Input, oldT, newT Targets) []PlanChange {
	var out []PlanChange
	str := func(field, from, to string) {
		if from != to {
			out = append(out, PlanChange{field, from, to})
		}
	}
	num := func(field string, from, to float64, round func(float64) float64) {
		if f, t := round(from), round(to); f != t {
			out = append(out, PlanChange{field, f, t})
		}
	}
	str("activity_level", oldIn.ActivityLevel, newIn.ActivityLevel)
	str("goal", oldIn.Goal, newIn.Goal)
	num("goal_weight_kg", oldIn.GoalWeightKg, newIn.GoalWeightKg, round1)
	num("pace_kg_per_week", oldIn.PaceKgPerWeek, newIn.PaceKgPerWeek, round1)
	num("kcal", oldT.Kcal, newT.Kcal, round0)
	num("protein_g", oldT.ProteinG, newT.ProteinG, round0)
	num("carbs_g", oldT.CarbsG, newT.CarbsG, round0)
	num("fat_g", oldT.FatG, newT.FatG, round0)
	return out
}

// stripFence removes a ```json … ``` wrapper some models add despite being
// told not to. Anything else is left untouched and will fail to unmarshal.
func stripFence(s string) string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "```") {
		return s
	}
	if i := strings.Index(s, "\n"); i >= 0 {
		s = s[i+1:]
	}
	return strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), "```"))
}

const (
	callTypePlanOtto  = "plan_otto"
	maxOttoMessage    = 500
	ottoTimeout       = 15 * time.Second
	ottoOutOfBounds   = "That would take your plan outside what Kora can safely set, so I've left it as it is."
	ottoAtRiskReply   = "I'll keep your calories where they are for now. If eating feels hard at the moment, it can help to talk it through with someone you trust."
	ottoKcalTolerance = 0.5
)

type ottoProposal struct {
	Draft   Input        `json:"draft"`
	Targets Targets      `json:"targets"`
	Changes []PlanChange `json:"changes"`
}

type ottoResponse struct {
	Reply       string        `json:"reply"`
	Proposal    *ottoProposal `json:"proposal"`
	ShowSupport bool          `json:"show_support"`
}

// Otto asks the model for a plan change and returns it only once Calculate
// has produced every number and the Protective policy allows it. It does not
// require onboarded_at: the Plan page is the last onboarding step.
func (h Handler) Otto(c *gin.Context) {
	if h.provider == nil {
		httpx.Error(c, http.StatusServiceUnavailable, "otto_unavailable", "Otto is not available")
		return
	}
	ctx := c.Request.Context()
	userID, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	var body struct {
		Message string `json:"message"`
		Draft   Input  `json:"draft"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed otto body")
		return
	}
	msg := strings.TrimSpace(body.Message)
	if msg == "" || utf8.RuneCountInString(msg) > maxOttoMessage {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "message must be 1 to 500 characters")
		return
	}
	draft, year := body.Draft, h.now().Year()
	oldT, err := Calculate(draft, year)
	if err != nil {
		// An override the user is still editing can be invalid; Otto can
		// still talk about the plan the rest of the draft gives.
		bare := draft
		bare.KcalOverride, bare.ProteinOverrideG = nil, nil
		if oldT, err = Calculate(bare, year); err != nil {
			httpx.Error(c, http.StatusBadRequest, "invalid_input", err.Error())
			return
		}
	}

	ok, err = h.meter.WithinBudget(ctx, userID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not check AI budget")
		return
	}
	if !ok {
		httpx.Error(c, http.StatusTooManyRequests, "budget_exhausted",
			"You've used your Otto allowance for now. You can still edit the numbers directly.")
		return
	}

	prompt, err := json.Marshal(map[string]any{"message": msg, "inputs": draft, "targets": oldT})
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not build request")
		return
	}
	callCtx, cancel := context.WithTimeout(ctx, ottoTimeout)
	defer cancel()
	callCtx, collector := ai.WithUsageCollector(callCtx)
	raw, usage, err := h.provider.GenerateText(callCtx, ottoSystemPrompt, string(prompt))
	for _, abandoned := range collector.Drain() {
		h.recordOtto(ctx, userID, abandoned, nil)
	}
	h.recordOtto(ctx, userID, usage, err)
	var reply ottoReply
	if err == nil {
		reply, err = parseOttoReply(raw)
	}
	if err != nil {
		slog.WarnContext(ctx, "onboarding: otto failed", "err", err, "user_id", userID)
		httpx.Error(c, http.StatusBadGateway, "otto_failed",
			"Otto couldn't answer. You can still edit the numbers directly.")
		return
	}
	// Every answer carries show_support, as coach chat does, so a text-only
	// reply to an at-risk user still points them at support.
	signals, serr := h.signals.SignalsFor(ctx, userID, user.LocFromContext(c))
	if serr != nil {
		slog.WarnContext(ctx, "onboarding: otto signals failed; treating as at risk", "err", serr, "user_id", userID)
		// Any value AtRisk accepts, so Evaluate fails closed too.
		signals = guardrails.Signals{RecentDeficitPct: 1}
	}
	atRisk := guardrails.AtRisk(signals)
	// The model's prose reaches the user, so it passes the same text gate as
	// coach answers.
	decision := guardrails.Evaluate(guardrails.Nudge{Text: reply.Reply, Restrictive: guardrails.LooksRestrictive(reply.Reply)}, signals)
	if decision.Action == guardrails.Suppress {
		httpx.OK(c, ottoResponse{Reply: ottoAtRiskReply, ShowSupport: true})
		return
	}
	reply.Reply = decision.Text
	if reply.Change.empty() {
		httpx.OK(c, ottoResponse{Reply: reply.Reply, ShowSupport: atRisk})
		return
	}

	newIn := reply.Change.apply(draft)
	newT, err := Calculate(newIn, year)
	if err != nil {
		// Dropped, never clamped: a clamped number is one the user did not ask for.
		httpx.OK(c, ottoResponse{Reply: ottoOutOfBounds, ShowSupport: atRisk})
		return
	}

	lowers := newT.Kcal < oldT.Kcal-ottoKcalTolerance ||
		(newIn.Goal != "maintenance" && newIn.PaceKgPerWeek > draft.PaceKgPerWeek)
	if atRisk && lowers {
		httpx.OK(c, ottoResponse{Reply: ottoAtRiskReply, ShowSupport: true})
		return
	}
	httpx.OK(c, ottoResponse{
		Reply:       reply.Reply,
		Proposal:    &ottoProposal{Draft: newIn, Targets: newT, Changes: planChanges(draft, newIn, oldT, newT)},
		ShowSupport: atRisk,
	})
}

// recordOtto meters one provider call. A metering failure never fails the
// request, matching recipes.Parser.record; the call type is forced so Otto's
// spend is not booked as coach's.
func (h Handler) recordOtto(ctx context.Context, userID uuid.UUID, u ai.Usage, err error) {
	if u.Provider == "" {
		u.Provider = h.provider.Name()
	}
	u.CallType = callTypePlanOtto
	switch {
	case err == nil && u.Outcome == "":
		u.Outcome = ai.OutcomeOK
	case err != nil && errors.Is(err, context.DeadlineExceeded):
		u.Outcome = ai.OutcomeTimeout
	case err != nil:
		u.Outcome = ai.OutcomeError
	}
	_ = h.meter.Record(ctx, userID, u, ai.EstimateCostUSD(u))
}
