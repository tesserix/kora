package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/ai/decide"
	"github.com/tesserix/kora/api/internal/auth"
)

func TestSyntheticSuitePreservesFailuresAndRejectsFalseSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"model":"jev-1.13.0","answers":{"next_action":{"type":"choice","choice":"calculate","confidence":1,"probabilities":{"ask_amount":0,"calculate":1,"retake":0}},"quantity_present":{"type":"noul","noul":1}},"usage":{"input_tokens":400,"output_tokens":50}}`))
	}))
	t.Cleanup(server.Close)
	client, err := decide.NewClient(server.URL, "test-key", server.Client())
	require.NoError(t, err)
	var output bytes.Buffer
	err = run(auth.WithVerifiedToken(t.Context(), "verified"), client, &output)
	require.Error(t, err)
	var report Report
	require.NoError(t, json.Unmarshal(output.Bytes(), &report))
	require.Equal(t, 80, len(report.Cases))
	require.False(t, report.Passed)
	require.Equal(t, "ask_amount", report.Cases[0].Expected)
	require.Equal(t, "calculate", report.Cases[0].Actual)
	require.False(t, report.Cases[0].Passed)
	require.Equal(t, 3200, report.InputTokens)
}

func TestSyntheticSuiteExercisesIntentAndCandidateDecisions(t *testing.T) {
	seen := map[string]bool{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Questions map[string]json.RawMessage `json:"questions"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		for name := range body.Questions {
			seen[name] = true
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(server.Close)
	client, err := decide.NewClient(server.URL, "test-key", server.Client())
	require.NoError(t, err)
	var output bytes.Buffer
	require.Error(t, run(auth.WithVerifiedToken(t.Context(), "verified"), client, &output))
	require.True(t, seen["intent"], "must exercise agent routing")
	require.True(t, seen["candidate"], "must exercise candidate ambiguity")
	var report Report
	require.NoError(t, json.Unmarshal(output.Bytes(), &report))
	require.Len(t, report.Cases, 80)
	for _, item := range report.Cases {
		require.False(t, item.Passed)
		require.Equal(t, "decision_unavailable", item.Error)
	}
}

func TestSyntheticSuiteAcceptsCompleteCorrectResponses(t *testing.T) {
	fixtures := evaluationCases()
	index := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			State json.RawMessage `json:"state"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		require.Less(t, index, len(fixtures))
		fixture := fixtures[index]
		index++
		require.JSONEq(t, fixture.state, string(body.State))
		confidence := 1.0
		probabilities := map[string]float64{}
		for key := range fixture.questions[fixture.answer].(decide.Choice).Criteria {
			probabilities[key] = 0
		}
		probabilities[fixture.expected] = 1
		answers := map[string]decide.Answer{fixture.answer: {Type: "choice", Choice: fixture.expected, Confidence: &confidence, Probabilities: probabilities}}
		if fixture.quantity != nil {
			quantity := 0.0
			if *fixture.quantity {
				quantity = 1
			}
			answers["quantity_present"] = decide.Answer{Type: "noul", Noul: &quantity}
		}
		require.NoError(t, json.NewEncoder(w).Encode(decide.Result{Model: "jev-1.13.0", Answers: answers, Usage: decide.Usage{InputTokens: 400}}))
	}))
	t.Cleanup(server.Close)
	client, err := decide.NewClient(server.URL, "test-key", server.Client())
	require.NoError(t, err)
	var output bytes.Buffer
	require.NoError(t, run(auth.WithVerifiedToken(t.Context(), "verified"), client, &output))
	var report Report
	require.NoError(t, json.Unmarshal(output.Bytes(), &report))
	require.True(t, report.Passed)
	require.Len(t, report.Cases, 80)
	require.Equal(t, 32000, report.InputTokens)
}

func TestLatencyPercentilesDoNotReportMaximumAsP95(t *testing.T) {
	latencies := make([]int64, 26)
	for i := range latencies {
		latencies[i] = 10
	}
	latencies[0] = 1000
	p50, p95 := latencyPercentiles(latencies)
	require.Equal(t, int64(10), p50)
	require.Equal(t, int64(10), p95)
}

func TestGuardedLabelsPreserveRawModelFailures(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(server.Close)
	client, err := decide.NewClient(server.URL, "test-key", server.Client())
	require.NoError(t, err)
	var output bytes.Buffer
	require.Error(t, run(auth.WithVerifiedToken(t.Context(), "verified"), client, &output))
	var report Report
	require.NoError(t, json.Unmarshal(output.Bytes(), &report))
	require.Len(t, report.Cases, 80)
	labels := 0
	for _, item := range report.Cases {
		require.False(t, item.Passed, "a guarded result must not erase a provider failure")
		if item.Family == "label" {
			labels++
			require.NotNil(t, item.Guarded)
			require.Equal(t, item.Expected, item.Guarded.Action, item.Name)
			require.True(t, item.GuardPassed, item.Name)
		}
	}
	require.Equal(t, 22, labels)
}
