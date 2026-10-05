// Command aidecide checks the private Jev route using synthetic data only.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"time"

	"github.com/tesserix/kora/api/internal/ai/decide"
	"github.com/tesserix/kora/api/internal/auth"
)

type CaseResult struct {
	Name      string         `json:"name"`
	Family    string         `json:"family"`
	Expected  string         `json:"expected"`
	Actual    string         `json:"actual,omitempty"`
	Passed    bool           `json:"passed"`
	Error     string         `json:"error,omitempty"`
	LatencyMS int64          `json:"latency_ms"`
	Result    *decide.Result `json:"result,omitempty"`
}
type Report struct {
	SyntheticOnly bool         `json:"synthetic_only"`
	Passed        bool         `json:"passed"`
	Cases         []CaseResult `json:"cases"`
	InputTokens   int          `json:"input_tokens"`
	OutputTokens  int          `json:"output_tokens"`
	P50MS         int64        `json:"p50_ms"`
	P95MS         int64        `json:"p95_ms"`
}

var labelCases = []struct {
	name, state, expected string
	quantity              bool
}{
	{"missing_amount", `{"label":{"basis":"per_100g","energy_kcal":200},"consumed_amount":null}`, "ask_amount", false},
	{"known_mass", `{"label":{"basis":"per_100g","energy_kcal":200},"consumed_amount":{"value":45,"unit":"g"}}`, "calculate", true},
	{"known_servings", `{"label":{"basis":"per_serving","energy_kcal":60},"consumed_amount":{"value":2,"unit":"servings"}}`, "calculate", true},
	{"missing_volume", `{"label":{"basis":"per_100ml","energy_kcal":42},"consumed_amount":null}`, "ask_amount", false},
	{"known_volume", `{"label":{"basis":"per_100ml","energy_kcal":42},"consumed_amount":{"value":250,"unit":"ml"}}`, "calculate", true},
	{"unreadable_label", `{"label":{"basis":null,"energy_kcal":null},"consumed_amount":{"value":50,"unit":"g"}}`, "retake", true},
	{"blank_label", `{"label":{"basis":null,"energy_kcal":null},"consumed_amount":null}`, "retake", false},
	{"vague_portion", `{"label":{"basis":"per_100g","energy_kcal":200},"consumed_amount":"a handful"}`, "ask_amount", false},
}

func run(ctx context.Context, client *decide.Client, out io.Writer) error {
	cases := evaluationCases()
	report := Report{SyntheticOnly: true, Passed: true, Cases: make([]CaseResult, 0, len(cases))}
	latencies := make([]int64, 0, len(cases))
	for _, item := range cases {
		start := time.Now()
		result, err := client.Decide(ctx, json.RawMessage(item.state), item.questions)
		entry := CaseResult{Name: item.name, Family: item.family, Expected: item.expected, LatencyMS: time.Since(start).Milliseconds()}
		if err != nil {
			entry.Error = "decision_unavailable"
		} else {
			entry.Actual = result.Answers[item.answer].Choice
			entry.Passed = entry.Actual == item.expected
			if item.quantity != nil {
				entry.Passed = entry.Passed && (*result.Answers["quantity_present"].Noul >= .5) == *item.quantity
			}
			entry.Result = &result
			report.InputTokens += result.Usage.InputTokens
			report.OutputTokens += result.Usage.OutputTokens
		}
		report.Passed = report.Passed && entry.Passed
		report.Cases = append(report.Cases, entry)
		latencies = append(latencies, entry.LatencyMS)
	}
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	report.P50MS = latencies[(len(latencies)-1)/2]
	report.P95MS = latencies[len(latencies)-1]
	if err := json.NewEncoder(out).Encode(report); err != nil {
		return errors.New("write synthetic report")
	}
	if !report.Passed {
		return errors.New("synthetic decision checks failed")
	}
	return nil
}

func main() {
	client, err := decide.NewClient(os.Getenv("AI_GATEWAY_BASE_URL"), os.Getenv("AI_GATEWAY_API_KEY"), nil)
	token := os.Getenv("KORA_EVAL_END_USER_TOKEN")
	if err != nil || client == nil || token == "" {
		fmt.Fprintln(os.Stderr, "Set private AI_GATEWAY_BASE_URL, AI_GATEWAY_API_KEY and a valid KORA_EVAL_END_USER_TOKEN; credentials are never printed")
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// The gateway verifies the test account token, as it does for cmd/aieval.
	ctx = auth.WithVerifiedToken(ctx, token)
	if err := run(ctx, client, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
