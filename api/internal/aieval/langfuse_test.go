package aieval

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type fakeLangfuse struct {
	mu       sync.Mutex
	items    []map[string]any
	metadata map[string]any
	posts    map[string][]map[string]any
}

func newFakeLangfuse(t *testing.T, items int) (*fakeLangfuse, *Client) {
	f := &fakeLangfuse{posts: map[string][]map[string]any{}}
	for i := range items {
		f.items = append(f.items, map[string]any{
			"id": fmt.Sprintf("item-%d", i), "status": "ACTIVE",
			"input":          map[string]any{"phrase": fmt.Sprintf("phrase %d", i)},
			"expectedOutput": map[string]any{"name": "Egg"},
		})
	}
	f.items = append(f.items, map[string]any{"id": "archived", "status": "ARCHIVED", "input": map[string]any{"phrase": "old"}})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if user, pass, ok := r.BasicAuth(); !ok || user != "pk" || pass != "sk" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/public/dataset-items":
			if r.URL.Query().Get("datasetName") != "kora-capture-text" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			var page int
			_, _ = fmt.Sscan(r.URL.Query().Get("page"), &page)
			limit := 2
			start := min((page-1)*limit, len(f.items))
			end := min(start+limit, len(f.items))
			pages := (len(f.items) + limit - 1) / limit
			_ = json.NewEncoder(w).Encode(map[string]any{"data": f.items[start:end], "meta": map[string]any{"page": page, "totalPages": pages}})
		case r.Method == http.MethodGet && r.URL.Path == "/api/public/v2/datasets/kora-capture-text":
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "kora-capture-text", "metadata": f.metadata})
		case r.Method == http.MethodPost:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.posts[r.URL.Path] = append(f.posts[r.URL.Path], body)
			if r.URL.Path == "/api/public/v2/datasets" {
				f.metadata, _ = body["metadata"].(map[string]any)
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return f, NewClient(srv.URL+"/", "pk", "sk")
}

func TestItemsPagesThroughActiveItems(t *testing.T) {
	_, c := newFakeLangfuse(t, 3)
	items, err := c.Items(t.Context(), "kora-capture-text")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 {
		t.Fatalf("got %d items, want the 3 active ones", len(items))
	}
	if items[2].ID != "item-2" || items[2].Input.Phrase != "phrase 2" || items[2].Expected.Name != "Egg" {
		t.Fatalf("got %+v", items[2])
	}
}

func TestItemsReportsAnUnknownDataset(t *testing.T) {
	_, c := newFakeLangfuse(t, 1)
	if _, err := c.Items(t.Context(), "nope"); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("got %v", err)
	}
}

func TestBaselineIsAbsentUntilAccepted(t *testing.T) {
	_, c := newFakeLangfuse(t, 1)
	_, ok, err := c.Baseline(t.Context(), "kora-capture-text")
	if err != nil || ok {
		t.Fatalf("got ok=%v err=%v", ok, err)
	}
}

func TestAcceptedBaselineRoundTrips(t *testing.T) {
	f, c := newFakeLangfuse(t, 1)
	f.metadata = map[string]any{"owner": "kora"}
	want := Summary{Cases: 5, Graded: 4, Top1: 0.75, AutoPrecision: 1, CalibrationError: 0.1}
	if err := c.AcceptBaseline(t.Context(), "kora-capture-text", want, "nightly-1"); err != nil {
		t.Fatal(err)
	}
	if f.metadata["owner"] != "kora" {
		t.Fatalf("accepting a baseline dropped other metadata: %v", f.metadata)
	}
	got, ok, err := c.Baseline(t.Context(), "kora-capture-text")
	if err != nil || !ok || got != want {
		t.Fatalf("got %+v ok=%v err=%v", got, ok, err)
	}
}

func TestLinkRunPostsTheRunItem(t *testing.T) {
	f, c := newFakeLangfuse(t, 1)
	if err := c.LinkRun(t.Context(), "nightly-1", "item-0", "trace-1"); err != nil {
		t.Fatal(err)
	}
	got := f.posts["/api/public/dataset-run-items"]
	if len(got) != 1 || got[0]["runName"] != "nightly-1" || got[0]["datasetItemId"] != "item-0" || got[0]["traceId"] != "trace-1" {
		t.Fatalf("got %v", got)
	}
}

func TestScorePostsABooleanOnTheTrace(t *testing.T) {
	f, c := newFakeLangfuse(t, 1)
	if err := c.Score(t.Context(), "trace-1", "eval.top1_correct", true); err != nil {
		t.Fatal(err)
	}
	got := f.posts["/api/public/scores"]
	if len(got) != 1 || got[0]["traceId"] != "trace-1" || got[0]["value"] != 1.0 || got[0]["dataType"] != "BOOLEAN" {
		t.Fatalf("got %v", got)
	}
}

func TestUpsertItemUsesTheGivenID(t *testing.T) {
	f, c := newFakeLangfuse(t, 0)
	err := c.UpsertItem(t.Context(), "kora-capture-text", Item{ID: "x", Input: Input{Phrase: "egg"}, Expected: Expected{Name: "Egg"}})
	if err != nil {
		t.Fatal(err)
	}
	got := f.posts["/api/public/dataset-items"]
	if len(got) != 1 || got[0]["id"] != "x" || got[0]["datasetName"] != "kora-capture-text" {
		t.Fatalf("got %v", got)
	}
}

func TestRequestsWithBadKeysFail(t *testing.T) {
	_, c := newFakeLangfuse(t, 1)
	c.secretKey = "wrong"
	if _, err := c.Items(t.Context(), "kora-capture-text"); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("got %v", err)
	}
}

func TestAcceptBaselineRejectsAnUngradedRun(t *testing.T) {
	f, c := newFakeLangfuse(t, 0)
	if err := c.AcceptBaseline(t.Context(), "kora-capture-text", Summary{Cases: 3}, "nightly"); err == nil {
		t.Fatal("accepted a baseline with no graded cases")
	}
	if len(f.posts["/api/public/v2/datasets"]) != 0 {
		t.Fatal("ungraded baseline was persisted")
	}
}
