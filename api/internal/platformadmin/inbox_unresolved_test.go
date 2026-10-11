package platformadmin

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/feedback"
	"github.com/tesserix/kora/api/internal/resolveoutcome"
)

type stubUnresolved struct {
	rows  []resolveoutcome.Outcome
	total int64
	err   error
	got   resolveoutcome.TriageParams
}

func (s *stubUnresolved) ListTriage(_ context.Context, p resolveoutcome.TriageParams) ([]resolveoutcome.Outcome, int64, error) {
	s.got = p
	return s.rows, s.total, s.err
}

func outcomeRow(kind resolveoutcome.Kind, phrase string, at time.Time, score *float64) resolveoutcome.Outcome {
	return resolveoutcome.Outcome{
		ID: uuid.New(), Kind: kind, Mode: resolveoutcome.ModeText,
		Phrase: &phrase, TopScore: score, CandidateCount: 3, CreatedAt: at,
	}
}

// TestInboxWithoutAnUnresolvedSourceOmitsTheQueue — "this queue is not
// available" and "this queue is clear" are different facts, and only one of
// them means an operator can stop looking. An absent source must not
// manufacture the second.
func TestInboxWithoutAnUnresolvedSourceOmitsTheQueue(t *testing.T) {
	src := &stubInbox{result: InboxResult{Total: 1, Items: []feedback.Feedback{{
		ID: uuid.New(), Kind: feedback.KindBug, Subject: "s", CreatedAt: time.Now(),
	}}}}

	rec := call(t, http.MethodGet, "/admin/inbox", "/admin/inbox",
		NewInboxHandler(src, nil).List)
	require.Equal(t, http.StatusOK, rec.Code)

	body := decode(t, rec)
	assert.Equal(t, float64(1), body["total"])
	for _, raw := range body["items"].([]any) {
		assert.NotEqual(t, KindUnresolvedFood, raw.(map[string]any)["kind"])
	}
}

func TestInboxMergesBothQueuesOldestFirst(t *testing.T) {
	now := time.Now().UTC()
	feedbackSrc := &stubInbox{result: InboxResult{Total: 1, Items: []feedback.Feedback{{
		ID: uuid.New(), Kind: feedback.KindBug, Subject: "newer feedback",
		CreatedAt: now.Add(-time.Hour),
	}}}}
	score := 0.42
	unresolvedSrc := &stubUnresolved{total: 1, rows: []resolveoutcome.Outcome{
		outcomeRow(resolveoutcome.KindNoMatch, "mcspicy", now.Add(-48*time.Hour), &score),
	}}

	rec := call(t, http.MethodGet, "/admin/inbox", "/admin/inbox",
		NewInboxHandler(feedbackSrc, nil).WithUnresolvedFoods(unresolvedSrc).List)
	require.Equal(t, http.StatusOK, rec.Code)

	body := decode(t, rec)
	assert.Equal(t, float64(2), body["total"], "the total covers both queues")

	items := body["items"].([]any)
	require.Len(t, items, 2)
	first := items[0].(map[string]any)
	assert.Equal(t, KindUnresolvedFood, first["kind"],
		"the older item leads, whichever queue it came from")
	assert.Equal(t, "mcspicy", first["title"], "the phrase IS the title — it is what to fix")
	assert.Contains(t, first["subtitle"], "no_match")
	assert.Contains(t, first["subtitle"], "best 0.42")
}

// TestAnIndexGapOutranksANearMiss — a near-miss at least gave the user
// something to correct; a gap ended the attempt with nothing.
func TestAnIndexGapOutranksANearMiss(t *testing.T) {
	now := time.Now().UTC()
	score := 0.39
	src := &stubUnresolved{total: 2, rows: []resolveoutcome.Outcome{
		outcomeRow(resolveoutcome.KindNoMatch, "mcspicy", now, nil),
		outcomeRow(resolveoutcome.KindBelowFloor, "flat white", now, &score),
	}}

	rec := call(t, http.MethodGet, "/admin/inbox", "/admin/inbox",
		NewInboxHandler(&stubInbox{}, nil).WithUnresolvedFoods(src).List)

	severities := map[string]string{}
	for _, raw := range decode(t, rec)["items"].([]any) {
		item := raw.(map[string]any)
		severities[item["title"].(string)] = item["severity"].(string)
	}
	assert.Equal(t, SeverityHigh, severities["mcspicy"])
	assert.Equal(t, SeverityNormal, severities["flat white"])
}

// TestAFailingQueueFailsTheWholeInbox — a partial inbox is indistinguishable
// from a complete one, and an operator who reads it as complete stops looking.
func TestAFailingQueueFailsTheWholeInbox(t *testing.T) {
	src := &stubUnresolved{err: errors.New("db down")}

	rec := call(t, http.MethodGet, "/admin/inbox", "/admin/inbox",
		NewInboxHandler(&stubInbox{}, nil).WithUnresolvedFoods(src).List)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.NotContains(t, rec.Body.String(), "db down")
}

// TestAPhotoFailureStillHasATitle — a photo resolve carries no phrase, and a
// blank title is a row an operator cannot act on or even identify.
func TestAPhotoFailureStillHasATitle(t *testing.T) {
	row := resolveoutcome.Outcome{
		ID: uuid.New(), Kind: resolveoutcome.KindNoMatch,
		Mode: resolveoutcome.ModePhoto, CreatedAt: time.Now(),
	}
	item := toUnresolvedItem(row)
	assert.NotEmpty(t, item.Title)
}

// TestUnresolvedItemsDeclareNoActions — §8.2's execution endpoint is not
// implemented, and §3.2 says to declare only actions the product can perform.
func TestUnresolvedItemsDeclareNoActions(t *testing.T) {
	item := toUnresolvedItem(outcomeRow(resolveoutcome.KindNoMatch, "x", time.Now(), nil))
	assert.Empty(t, item.Actions)
	assert.Nil(t, item.DueAt, "Kora has no SLA on this queue either")
}

// TestHealthReportsTheBacklogDepth — #459's health consumer. A backlog that
// only reported "reachable" would say nothing about whether anyone is keeping
// up with it.
func TestHealthReportsTheBacklogDepth(t *testing.T) {
	probes := map[string]Probe{
		DepFoodBacklog: func(context.Context) (map[string]int64, error) {
			return map[string]int64{"waiting": 7}, nil
		},
	}

	rec := call(t, http.MethodGet, "/admin/health", "/admin/health",
		NewHealthHandler(probes, nil).Health)
	require.Equal(t, http.StatusOK, rec.Code)

	for _, raw := range decode(t, rec)["data"].(map[string]any)["dependencies"].([]any) {
		row := raw.(map[string]any)
		if row["name"] != DepFoodBacklog {
			continue
		}
		assert.Equal(t, StatusOK, row["status"])
		assert.Equal(t, float64(7), row["metrics"].(map[string]any)["waiting"])
		return
	}
	t.Fatalf("%s is missing from the health payload", DepFoodBacklog)
}

// TestAFailedProbesMetricsAreDiscarded — a count produced by a check that
// errored is not a measurement, and shipping it beside a `down` status invites
// reading it as one.
func TestAFailedProbesMetricsAreDiscarded(t *testing.T) {
	probes := map[string]Probe{
		DepFoodBacklog: func(context.Context) (map[string]int64, error) {
			return map[string]int64{"waiting": 999}, errors.New("db down")
		},
	}

	rec := call(t, http.MethodGet, "/admin/health", "/admin/health",
		NewHealthHandler(probes, nil).Health)

	assert.NotContains(t, rec.Body.String(), "999")
	assert.Contains(t, rec.Body.String(), StatusDown)
}
