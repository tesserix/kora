package coach

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/dashboard"
	"github.com/tesserix/kora/api/internal/diet"
	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/memory"
	"github.com/tesserix/kora/api/internal/mentor"
	"github.com/tesserix/kora/api/internal/tracking"
)

// scriptedProvider answers with a different text per call, which is what a
// retry test needs: the point is that the second attempt differs from the first.
type scriptedProvider struct {
	fakeProvider
	script []string
	seen   []string
}

func (p *scriptedProvider) GenerateText(ctx context.Context, systemPrompt, userPrompt string) (string, ai.Usage, error) {
	p.seen = append(p.seen, userPrompt)
	i := len(p.seen) - 1
	if i >= len(p.script) {
		i = len(p.script) - 1
	}
	return p.script[i], ai.Usage{Provider: "stub", Model: "test-model", CallType: "generate_text"}, nil
}

func gateService(script ...string) (*Service, *scriptedProvider) {
	provider := &scriptedProvider{script: script}
	g := Grounder{}
	return NewService(&g, provider, &stubMeter{withinBudget: true}, nil), provider
}

func blockProfile(t *testing.T, subject string) diet.Profile {
	t.Helper()
	return diet.Compile([]diet.Rule{{
		Subject:  subject,
		Kind:     diet.KindAllergy,
		Severity: diet.SeverityBlock,
		Label:    diet.LabelFor(subject),
		Source:   diet.SourceUser,
	}})
}

func flagProfile(t *testing.T, subject string) diet.Profile {
	t.Helper()
	return diet.Compile([]diet.Rule{{
		Subject:  subject,
		Kind:     diet.KindPreference,
		Severity: diet.SeverityFlag,
		Label:    diet.LabelFor(subject),
		Source:   diet.SourceUser,
	}})
}

func TestScreenDietLeavesACleanAnswerAlone(t *testing.T) {
	svc, provider := gateService("unused")
	answer := "Try a paneer bhurji with a side salad."

	text, flags, blocked := svc.screenDiet(
		context.Background(), uuid.New(), blockProfile(t, "peanut"),
		"prompt", guidanceSkill, answer, false)

	require.Equal(t, answer, text)
	require.Empty(t, flags)
	require.False(t, blocked)
	require.Empty(t, provider.seen, "a clean answer must not cost a second generation")
}

func TestScreenDietDoesNothingWithoutRules(t *testing.T) {
	svc, provider := gateService("unused")
	answer := "Peanut chutney with dosa."

	text, flags, blocked := svc.screenDiet(
		context.Background(), uuid.New(), diet.Profile{},
		"prompt", guidanceSkill, answer, false)

	require.Equal(t, answer, text)
	require.Empty(t, flags)
	require.False(t, blocked)
	require.Empty(t, provider.seen)
}

func TestScreenDietAnnotatesAPreferenceButKeepsTheAnswer(t *testing.T) {
	svc, provider := gateService("unused")
	answer := "A mushroom masala works well here."

	text, flags, blocked := svc.screenDiet(
		context.Background(), uuid.New(), flagProfile(t, "mushroom"),
		"prompt", guidanceSkill, answer, false)

	require.Equal(t, answer, text, "a preference must not cost the user a good answer")
	require.False(t, blocked)
	require.Len(t, flags, 1)
	require.Equal(t, "mushroom", flags[0].Subject)
	require.Equal(t, diet.SeverityFlag, flags[0].Severity)
	require.Empty(t, provider.seen, "a flag is annotated, not regenerated")
}

func TestScreenDietRegeneratesAroundABlockingRule(t *testing.T) {
	svc, provider := gateService("Coconut chutney with your dosa.")

	text, flags, blocked := svc.screenDiet(
		context.Background(), uuid.New(), blockProfile(t, "peanut"),
		"what should I have with dosa?", guidanceSkill,
		"Peanut chutney with your dosa.", false)

	require.Equal(t, "Coconut chutney with your dosa.", text)
	require.False(t, blocked)
	require.Empty(t, flags)
	require.Len(t, provider.seen, 1, "one retry, not a loop")
	require.Contains(t, provider.seen[0], "peanut",
		"the retry must name the constraint it just broke")
}

func TestScreenDietDoesNotBypassAConfiguredAgentWhenItsRetryFails(t *testing.T) {
	svc, provider := gateService("Coconut chutney with your dosa.")
	svc = svc.WithAgents(&fakeRunner{err: errors.New("gateway unreachable")})

	text, flags, blocked := svc.screenDiet(
		context.Background(), uuid.New(), blockProfile(t, "peanut"),
		"what should I have with dosa?", guidanceSkill,
		"Peanut chutney with your dosa.", true)

	require.True(t, blocked)
	require.Empty(t, flags)
	require.Contains(t, strings.ToLower(text), "peanut")
	require.Empty(t, provider.seen, "a failed agent retry must not fall through to a direct provider")
}

func TestScreenDietWithholdsAnAnswerThatStaysUnsafe(t *testing.T) {
	svc, provider := gateService("Still peanut chutney.")

	text, flags, blocked := svc.screenDiet(
		context.Background(), uuid.New(), blockProfile(t, "peanut"),
		"what should I have with dosa?", guidanceSkill, "Peanut chutney.", false)

	require.True(t, blocked)
	require.Empty(t, flags)
	require.NotContains(t, strings.ToLower(text), "chutney",
		"the unsafe draft must not reach the user")
	require.Contains(t, strings.ToLower(text), "peanut",
		"the user must be able to tell a rule from a bug")
	require.Len(t, provider.seen, 1)
}

func TestScreenDietRetriesOnlyOnce(t *testing.T) {
	svc, provider := gateService("Peanut ladoo again.", "Coconut ladoo.")

	_, _, blocked := svc.screenDiet(
		context.Background(), uuid.New(), blockProfile(t, "peanut"),
		"a sweet?", guidanceSkill, "Peanut ladoo.", false)

	require.True(t, blocked)
	require.Len(t, provider.seen, 1,
		"a second retry would trade the user's latency for a guess that already failed")
}

func TestScreenDietMatchesAnAliasNotJustTheSubjectWord(t *testing.T) {
	svc, _ := gateService("Chana masala.")

	text, _, blocked := svc.screenDiet(
		context.Background(), uuid.New(), blockProfile(t, "dairy"),
		"dinner?", guidanceSkill, "Paneer butter masala.", false)

	require.False(t, blocked)
	require.Equal(t, "Chana masala.", text, "paneer must count as dairy")
}

// The end-to-end tests below run the real chain: a rule in the database, read
// by the grounder, rendered into the prompt, and enforced on the answer.

func dietAskService(t *testing.T, provider ai.Provider) (*Service, uuid.UUID) {
	t.Helper()
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	g := NewGrounder(
		dashboard.NewService(logRepo, tracking.NewRepository(db), db),
		logRepo,
		memory.NewService(logRepo),
		fakeWeightSource{},
	).WithMentor(mentor.NewRepository(db))

	mentorSvc := mentor.NewService(mentor.NewRepository(db))
	_, err := mentorSvc.PutFoodRules(context.Background(), userID, []mentor.FoodRuleInput{
		{Subject: "peanut", Kind: diet.KindAllergy},
		{Subject: "mushroom", Kind: diet.KindPreference},
	})
	require.NoError(t, err)

	return NewService(&g, provider, &stubMeter{withinBudget: true}, nil), userID
}

func TestAskPutsConfirmedRulesInThePrompt(t *testing.T) {
	provider := &recordingProvider{answer: "Have some idli."}
	svc, userID := dietAskService(t, provider)

	_, err := svc.Ask(context.Background(), userID,
		time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "what's for dinner?")
	require.NoError(t, err)

	require.Contains(t, strings.ToLower(provider.userPrompt), "peanut",
		"the agent must see the user's constraints before it answers")
}

func TestAskWithholdsAnAnswerThatBreaksAConfirmedAllergy(t *testing.T) {
	provider := &scriptedProvider{script: []string{"Peanut chutney and dosa."}}
	svc, userID := dietAskService(t, provider)

	answer, err := svc.Ask(context.Background(), userID,
		time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "what's for dinner?")
	require.NoError(t, err)

	require.NotContains(t, strings.ToLower(answer.Text), "chutney")
	require.Contains(t, strings.ToLower(answer.Text), "peanut")
	require.Nil(t, answer.Proposal, "a withheld answer must not leave a commitment to approve")
	require.Nil(t, answer.Plan, "a withheld answer must not leave a plan to approve")
}

func TestAskFlagsAPreferenceWithoutWithholdingTheAnswer(t *testing.T) {
	provider := &recordingProvider{answer: "Mushroom risotto tonight."}
	svc, userID := dietAskService(t, provider)

	answer, err := svc.Ask(context.Background(), userID,
		time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "what's for dinner?")
	require.NoError(t, err)

	require.Contains(t, answer.Text, "Mushroom risotto", "a preference must not cost the user an answer")
	require.Len(t, answer.DietFlags, 1)
	require.Equal(t, "mushroom", answer.DietFlags[0].Subject)
	require.Equal(t, diet.SeverityFlag, answer.DietFlags[0].Severity)
}

func TestAskResponseCarriesDietFlagsToTheClient(t *testing.T) {
	provider := &recordingProvider{answer: "Mushroom risotto tonight."}
	svc, userID := dietAskService(t, provider)
	router := newTestRouter(userID, NewHandler(svc))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/coach/ask",
		bytes.NewBufferString(`{"question":"what's for dinner?"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			DietFlags []diet.Violation `json:"diet_flags"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Len(t, body.Data.DietFlags, 1)
	require.Equal(t, "Mushroom", body.Data.DietFlags[0].Label,
		"the client needs the label to say which preference the answer touches")
}

func TestAskExcludesBlockedFoodsFromTheEvidenceItRetrieves(t *testing.T) {
	provider := &recordingProvider{answer: "Have some idli."}
	svc, userID := dietAskService(t, provider)
	references := &stubNutritionReferences{}
	svc = svc.WithNutritionReferences(references)

	_, err := svc.Ask(context.Background(), userID,
		time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "what's for dinner?")
	require.NoError(t, err)

	require.Contains(t, references.excluded, diet.TagFor("peanut"),
		"retrieval must not offer the model evidence the user's rules forbid")
}

func TestAskReturnsARegeneratedAnswerWhenTheRetryIsClean(t *testing.T) {
	provider := &scriptedProvider{script: []string{"Peanut chutney and dosa.", "Coconut chutney and dosa."}}
	svc, userID := dietAskService(t, provider)

	answer, err := svc.Ask(context.Background(), userID,
		time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC), time.UTC, "what's for dinner?")
	require.NoError(t, err)

	require.Contains(t, answer.Text, "Coconut chutney")
}
