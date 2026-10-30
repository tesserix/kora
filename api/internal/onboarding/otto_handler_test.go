package onboarding

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/guardrails"
	"github.com/tesserix/kora/api/internal/user"
)

// fakeOttoProvider answers GenerateText only; the embedded nil Provider
// panics if the handler ever calls anything else.
type fakeOttoProvider struct {
	ai.Provider
	out   string
	err   error
	calls int
}

func (p *fakeOttoProvider) GenerateText(context.Context, string, string) (string, ai.Usage, error) {
	p.calls++
	return p.out, ai.Usage{Provider: "fake"}, p.err
}

func (p *fakeOttoProvider) Name() string { return "fake" }

type fakeOttoMeter struct {
	within    bool
	records   []ai.Usage
	recordErr error
}

func (m *fakeOttoMeter) WithinBudget(context.Context, uuid.UUID) (bool, error) { return m.within, nil }
func (m *fakeOttoMeter) Record(_ context.Context, _ uuid.UUID, u ai.Usage, _ float64) error {
	m.records = append(m.records, u)
	return m.recordErr
}

type fakeSignals struct {
	signals guardrails.Signals
	err     error
}

func (s fakeSignals) SignalsFor(context.Context, uuid.UUID, *time.Location) (guardrails.Signals, error) {
	return s.signals, s.err
}

var atRiskSignals = guardrails.Signals{AvgIntakeKcal: 1000}

type ottoEnv struct {
	planEnv
	provider *fakeOttoProvider
	meter    *fakeOttoMeter
}

// newOttoEnv wires Otto for a provisioned user who has not onboarded, which
// is the Plan page's own situation as the last onboarding step.
func newOttoEnv(t *testing.T, reply string, signals fakeSignals) ottoEnv {
	t.Helper()
	e := newPlanEnv(t)
	p := &fakeOttoProvider{out: reply}
	m := &fakeOttoMeter{within: true}
	h := Handler{now: func() time.Time { return referenceNow(t) }}.WithOtto(p, m, signals)
	e.r.POST("/v1/me/plan/otto", append(e.mw, h.Otto)...)
	return ottoEnv{planEnv: e, provider: p, meter: m}
}

const ottoDraftJSON = `{"sex":"female","birth_year":1990,"height_cm":160,"weight_kg":73,` +
	`"activity_level":"moderate","goal":"fat_loss","goal_weight_kg":68,"pace_kg_per_week":0.5`

func ottoBody(message, extraDraft string) string {
	d := ottoDraftJSON
	if extraDraft != "" {
		d += "," + extraDraft
	}
	b, _ := json.Marshal(message)
	return `{"message":` + string(b) + `,"draft":` + d + `}}`
}

type ottoResp struct {
	Data struct {
		Reply    string `json:"reply"`
		Proposal *struct {
			Draft   Input        `json:"draft"`
			Targets Targets      `json:"targets"`
			Changes []PlanChange `json:"changes"`
		} `json:"proposal"`
		ShowSupport bool `json:"show_support"`
	} `json:"data"`
	Error string `json:"error"`
}

func (e ottoEnv) ask(t *testing.T, body string, wantCode int) ottoResp {
	t.Helper()
	w := e.do(t, http.MethodPost, "/v1/me/plan/otto", body)
	require.Equal(t, wantCode, w.Code, w.Body.String())
	var r ottoResp
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &r))
	return r
}

const (
	outOfBoundsReply = "That would take your plan outside what Kora can safely set, so I've left it as it is."
	atRiskReply      = "I'll keep your calories where they are for now. If eating feels hard at the moment, it can help to talk it through with someone you trust."
)

func TestOttoProposesProtein(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"Got it","change":{"protein_override_g":125}}`, fakeSignals{})
	r := e.ask(t, ottoBody("my dietitian says 120-130g protein", ""), http.StatusOK)
	require.Equal(t, "Got it", r.Data.Reply)
	require.NotNil(t, r.Data.Proposal)
	require.Equal(t, 125.0, r.Data.Proposal.Targets.ProteinG)
	require.NotNil(t, r.Data.Proposal.Draft.ProteinOverrideG)
	require.Equal(t, 125.0, *r.Data.Proposal.Draft.ProteinOverrideG)
	var fields []string
	for _, c := range r.Data.Proposal.Changes {
		fields = append(fields, c.Field)
	}
	require.Contains(t, fields, "protein_g")
	require.False(t, r.Data.ShowSupport)
	require.Len(t, e.meter.records, 1)
	require.Equal(t, "plan_otto", e.meter.records[0].CallType)
	require.Equal(t, ai.OutcomeOK, e.meter.records[0].Outcome)
}

func TestOttoTextOnly(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"Protein helps you stay full.","change":null}`, fakeSignals{})
	r := e.ask(t, ottoBody("why protein?", ""), http.StatusOK)
	require.Equal(t, "Protein helps you stay full.", r.Data.Reply)
	require.Nil(t, r.Data.Proposal)
	require.False(t, r.Data.ShowSupport)
}

func TestOttoAtRiskTextOnlyShowsSupport(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"Protein helps you stay full.","change":null}`, fakeSignals{signals: atRiskSignals})
	r := e.ask(t, ottoBody("why protein?", ""), http.StatusOK)
	require.Equal(t, "Protein helps you stay full.", r.Data.Reply)
	require.Nil(t, r.Data.Proposal)
	require.True(t, r.Data.ShowSupport)
}

func TestOttoSignalsErrorTextOnlyShowsSupport(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"Hi","change":null}`, fakeSignals{err: errors.New("db down")})
	r := e.ask(t, ottoBody("hi", ""), http.StatusOK)
	require.True(t, r.Data.ShowSupport)
}

func TestOttoAtRiskOutOfBoundsShowsSupport(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"Sure","change":{"kcal_override":900}}`, fakeSignals{signals: atRiskSignals})
	r := e.ask(t, ottoBody("900 calories please", ""), http.StatusOK)
	require.Equal(t, outOfBoundsReply, r.Data.Reply)
	require.True(t, r.Data.ShowSupport)
}

func TestOttoDropsOutOfBounds(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"Sure","change":{"kcal_override":900}}`, fakeSignals{})
	r := e.ask(t, ottoBody("900 calories please", ""), http.StatusOK)
	require.Nil(t, r.Data.Proposal)
	require.Equal(t, outOfBoundsReply, r.Data.Reply)
	require.False(t, r.Data.ShowSupport)
}

func TestOttoAtRiskDropsLowerKcal(t *testing.T) {
	// 1500 is below the 1603 kcal the draft gives and above its 1389 BMR.
	e := newOttoEnv(t, `{"reply":"Sure","change":{"kcal_override":1500}}`, fakeSignals{signals: atRiskSignals})
	r := e.ask(t, ottoBody("lower my calories", ""), http.StatusOK)
	require.Nil(t, r.Data.Proposal)
	require.Equal(t, atRiskReply, r.Data.Reply)
	require.True(t, r.Data.ShowSupport)
}

func TestOttoAtRiskAllowsHigherProtein(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"Got it","change":{"protein_override_g":125}}`, fakeSignals{signals: atRiskSignals})
	r := e.ask(t, ottoBody("more protein", ""), http.StatusOK)
	require.NotNil(t, r.Data.Proposal)
	require.True(t, r.Data.ShowSupport)
}

func TestOttoAtRiskDropsFasterPace(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"Sure","change":{"pace_kg_per_week":0.7}}`, fakeSignals{signals: atRiskSignals})
	r := e.ask(t, ottoBody("faster", ""), http.StatusOK)
	require.Nil(t, r.Data.Proposal)
	require.Equal(t, atRiskReply, r.Data.Reply)
}

func TestOttoSignalsErrorFailsClosed(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"Sure","change":{"kcal_override":1500}}`, fakeSignals{err: errors.New("db down")})
	r := e.ask(t, ottoBody("lower my calories", ""), http.StatusOK)
	require.Nil(t, r.Data.Proposal)
	require.Equal(t, atRiskReply, r.Data.Reply)
	require.True(t, r.Data.ShowSupport)
}

func TestOttoBudgetExhausted(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"x"}`, fakeSignals{})
	e.meter.within = false
	r := e.ask(t, ottoBody("hi", ""), http.StatusTooManyRequests)
	require.Equal(t, "budget_exhausted", r.Error)
	require.Zero(t, e.provider.calls)
}

func TestOttoProviderError(t *testing.T) {
	e := newOttoEnv(t, "", fakeSignals{})
	e.provider.err = errors.New("upstream")
	r := e.ask(t, ottoBody("hi", ""), http.StatusBadGateway)
	require.Equal(t, "otto_failed", r.Error)
	require.Len(t, e.meter.records, 1)
	require.Equal(t, ai.OutcomeError, e.meter.records[0].Outcome)
}

func TestOttoUnparsable(t *testing.T) {
	e := newOttoEnv(t, "Sure! I'd suggest more protein.", fakeSignals{})
	r := e.ask(t, ottoBody("hi", ""), http.StatusBadGateway)
	require.Equal(t, "otto_failed", r.Error)
	require.Len(t, e.meter.records, 1)
}

func TestOttoNoProvider(t *testing.T) {
	e := newPlanEnv(t)
	h := Handler{now: func() time.Time { return referenceNow(t) }}
	e.r.POST("/v1/me/plan/otto", append(e.mw, h.Otto)...)
	w := e.do(t, http.MethodPost, "/v1/me/plan/otto", ottoBody("hi", ""))
	require.Equal(t, http.StatusServiceUnavailable, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "otto_unavailable")
}

func TestOttoMessageValidation(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"x"}`, fakeSignals{})
	for _, msg := range []string{"   ", strings.Repeat("é", 501)} {
		r := e.ask(t, ottoBody(msg, ""), http.StatusBadRequest)
		require.Equal(t, "invalid_input", r.Error)
	}
	// 500 runes is the limit, not over it.
	e.ask(t, ottoBody(strings.Repeat("é", 500), ""), http.StatusOK)
	e.ask(t, `{"message":`, http.StatusBadRequest)
	require.Equal(t, 1, e.provider.calls)
}

func TestOttoUncomputableDraft(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"x"}`, fakeSignals{})
	r := e.ask(t, `{"message":"hi","draft":{"sex":"other"}}`, http.StatusBadRequest)
	require.Equal(t, "invalid_input", r.Error)
}

func TestOttoInvalidCurrentOverride(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"Here's why.","change":null}`, fakeSignals{})
	r := e.ask(t, ottoBody("why?", `"target_kcal_override":900`), http.StatusOK)
	require.Equal(t, "Here's why.", r.Data.Reply)
	require.Nil(t, r.Data.Proposal)
}

func TestOttoNotOnboarded(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"Hi","change":null}`, fakeSignals{})
	u, err := user.NewRepository(e.db).ByID(t.Context(), e.uid)
	require.NoError(t, err)
	require.Nil(t, u.OnboardedAt)
	r := e.ask(t, ottoBody("hi", ""), http.StatusOK)
	require.Equal(t, "Hi", r.Data.Reply)
}

func TestOttoAtRiskRestrictiveTextSuppressed(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"You should eat less","change":null}`, fakeSignals{signals: atRiskSignals})
	r := e.ask(t, ottoBody("what should I do?", ""), http.StatusOK)
	require.Equal(t, atRiskReply, r.Data.Reply)
	require.Nil(t, r.Data.Proposal)
	require.True(t, r.Data.ShowSupport)
}

func TestOttoRestrictiveTextSoftened(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"You should eat less","change":null}`, fakeSignals{})
	r := e.ask(t, ottoBody("what should I do?", ""), http.StatusOK)
	require.Equal(t, "Nice work today — you're on track.", r.Data.Reply)
	require.Nil(t, r.Data.Proposal)
	require.False(t, r.Data.ShowSupport)
}

func TestOttoSignalsErrorRestrictiveTextSuppressed(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"You should eat less","change":null}`, fakeSignals{err: errors.New("db down")})
	r := e.ask(t, ottoBody("what should I do?", ""), http.StatusOK)
	require.Equal(t, atRiskReply, r.Data.Reply)
	require.Nil(t, r.Data.Proposal)
	require.True(t, r.Data.ShowSupport)
}

func TestOttoAtRiskRestrictiveProposalSuppressed(t *testing.T) {
	e := newOttoEnv(t, `{"reply":"Cut back on snacks and add protein","change":{"protein_override_g":125}}`, fakeSignals{signals: atRiskSignals})
	r := e.ask(t, ottoBody("more protein", ""), http.StatusOK)
	require.Equal(t, atRiskReply, r.Data.Reply)
	require.Nil(t, r.Data.Proposal)
	require.True(t, r.Data.ShowSupport)
}

func TestOttoRecordFailureIsLoggedNotFatal(t *testing.T) {
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	e := newOttoEnv(t, `{"reply":"Hi","change":null}`, fakeSignals{})
	e.meter.recordErr = errors.New("meter down")
	r := e.ask(t, ottoBody("hi", ""), http.StatusOK)
	require.Equal(t, "Hi", r.Data.Reply)
	require.Contains(t, logs.String(), "level=WARN")
	require.Contains(t, logs.String(), "meter down")
}
