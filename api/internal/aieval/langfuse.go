package aieval

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	requestTimeout = 15 * time.Second
	pageLimit      = 50
	errorBodySize  = 1 << 10
	baselineKey    = "baseline"
)

// Input is what the resolver is given for one dataset item.
type Input struct {
	Phrase string `json:"phrase"`
}

// Item is one golden case.
type Item struct {
	ID       string
	Input    Input
	Expected Expected
	Note     string
}

// Client is a synchronous Langfuse client: an eval run must know every write landed.
type Client struct {
	host      string
	publicKey string
	secretKey string
	http      *http.Client
}

func NewClient(host, publicKey, secretKey string) *Client {
	return &Client{
		host: strings.TrimRight(host, "/"), publicKey: publicKey, secretKey: secretKey,
		http: &http.Client{Timeout: requestTimeout},
	}
}

type itemBody struct {
	ID             string          `json:"id"`
	DatasetName    string          `json:"datasetName,omitempty"`
	Status         string          `json:"status,omitempty"`
	Input          Input           `json:"input"`
	ExpectedOutput Expected        `json:"expectedOutput"`
	Metadata       json.RawMessage `json:"metadata,omitempty"`
}

// Items returns the dataset's active items across every page.
func (c *Client) Items(ctx context.Context, dataset string) ([]Item, error) {
	var items []Item
	for page := 1; ; page++ {
		var resp struct {
			Data []itemBody `json:"data"`
			Meta struct {
				TotalPages int `json:"totalPages"`
			} `json:"meta"`
		}
		q := url.Values{"datasetName": {dataset}, "page": {fmt.Sprint(page)}, "limit": {fmt.Sprint(pageLimit)}}
		if err := c.do(ctx, http.MethodGet, "/api/public/dataset-items?"+q.Encode(), nil, &resp); err != nil {
			return nil, fmt.Errorf("list %s items: %w", dataset, err)
		}
		for _, d := range resp.Data {
			if d.Status == "ARCHIVED" {
				continue
			}
			items = append(items, Item{ID: d.ID, Input: d.Input, Expected: d.ExpectedOutput})
		}
		if page >= resp.Meta.TotalPages {
			return items, nil
		}
	}
}

// UpsertItem writes a golden case under its own id, so reseeding updates rather than duplicates.
func (c *Client) UpsertItem(ctx context.Context, dataset string, it Item) error {
	body := itemBody{ID: it.ID, DatasetName: dataset, Input: it.Input, ExpectedOutput: it.Expected}
	if it.Note != "" {
		body.Metadata, _ = json.Marshal(map[string]string{"note": it.Note})
	}
	if err := c.do(ctx, http.MethodPost, "/api/public/dataset-items", body, nil); err != nil {
		return fmt.Errorf("upsert item %s: %w", it.ID, err)
	}
	return nil
}

// LinkRun attaches an item's trace to the named experiment run.
func (c *Client) LinkRun(ctx context.Context, run, itemID, traceID string) error {
	body := map[string]string{"runName": run, "datasetItemId": itemID, "traceId": traceID}
	if err := c.do(ctx, http.MethodPost, "/api/public/dataset-run-items", body, nil); err != nil {
		return fmt.Errorf("link run item %s: %w", itemID, err)
	}
	return nil
}

// Score posts a boolean score on a trace; the id makes a retry overwrite rather than duplicate.
func (c *Client) Score(ctx context.Context, traceID, name string, ok bool) error {
	value := 0.0
	if ok {
		value = 1
	}
	body := map[string]any{"id": traceID + "-" + name, "traceId": traceID, "name": name, "value": value, "dataType": "BOOLEAN"}
	if err := c.do(ctx, http.MethodPost, "/api/public/scores", body, nil); err != nil {
		return fmt.Errorf("score %s: %w", name, err)
	}
	return nil
}

type datasetBody struct {
	Name     string                     `json:"name"`
	Metadata map[string]json.RawMessage `json:"metadata"`
}

func (c *Client) dataset(ctx context.Context, name string) (datasetBody, error) {
	var d datasetBody
	if err := c.do(ctx, http.MethodGet, "/api/public/v2/datasets/"+url.PathEscape(name), nil, &d); err != nil {
		return d, fmt.Errorf("get dataset %s: %w", name, err)
	}
	return d, nil
}

// Baseline returns the last accepted summary, kept in the dataset's metadata.
func (c *Client) Baseline(ctx context.Context, dataset string) (Summary, bool, error) {
	d, err := c.dataset(ctx, dataset)
	if err != nil {
		return Summary{}, false, err
	}
	raw, ok := d.Metadata[baselineKey]
	if !ok || string(raw) == "null" {
		return Summary{}, false, nil
	}
	var s Summary
	if err := json.Unmarshal(raw, &s); err != nil {
		return Summary{}, false, fmt.Errorf("decode %s baseline: %w", dataset, err)
	}
	return s, true, nil
}

// AcceptBaseline records s as the dataset's baseline, keeping its other metadata.
func (c *Client) AcceptBaseline(ctx context.Context, dataset string, s Summary, run string) error {
	if s.Graded <= 0 {
		return fmt.Errorf("cannot accept a baseline without graded cases")
	}
	d, err := c.dataset(ctx, dataset)
	if err != nil {
		return err
	}
	if d.Metadata == nil {
		d.Metadata = map[string]json.RawMessage{}
	}
	d.Metadata[baselineKey], _ = json.Marshal(s)
	d.Metadata["baseline_run"], _ = json.Marshal(run)
	if err := c.do(ctx, http.MethodPost, "/api/public/v2/datasets", datasetBody{Name: dataset, Metadata: d.Metadata}, nil); err != nil {
		return fmt.Errorf("accept %s baseline: %w", dataset, err)
	}
	return nil
}

func (c *Client) do(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return fmt.Errorf("encode: %w", err)
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.host+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.SetBasicAuth(c.publicKey, c.secretKey)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= http.StatusMultipleChoices {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, errorBodySize))
		return fmt.Errorf("langfuse returned %d: %s", resp.StatusCode, detail)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
