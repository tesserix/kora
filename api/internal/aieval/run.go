package aieval

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel/attribute"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/aitrace"
)

const (
	ScoreTop1 = "eval.top1_correct"
	ScoreKcal = "eval.kcal_within"
	traceName = "eval.capture.text"
)

// TextResolver is the slice of ai.Resolver a capture-text run exercises.
type TextResolver interface {
	ResolveText(ctx context.Context, userID uuid.UUID, phrase string) (ai.Resolution, error)
}

// Run resolves every item under its own trace, links it to the run and scores it.
// A resolve error is graded as a miss; a recording failure makes the run incomplete.
func Run(ctx context.Context, resolver TextResolver, lf *Client, run string, items []Item) ([]Result, error) {
	user := uuid.New()
	results := make([]Result, 0, len(items))
	for _, it := range items {
		result, err := runItem(ctx, resolver, lf, run, user, it)
		if err != nil {
			return results, err
		}
		results = append(results, result)
	}
	return results, nil
}

func runItem(ctx context.Context, resolver TextResolver, lf *Client, run string, user uuid.UUID, it Item) (Result, error) {
	ctx, span := aitrace.Start(ctx, traceName,
		attribute.String("langfuse.trace.name", traceName),
		attribute.String("langfuse.trace.metadata.dataset_item_id", it.ID),
		attribute.String("langfuse.trace.metadata.run", run),
	)
	defer span.End()
	traceID := span.SpanContext().TraceID().String()

	res, err := resolver.ResolveText(ctx, user, it.Input.Phrase)
	if err != nil {
		slog.WarnContext(ctx, "aieval: resolve failed, graded as a miss", "item", it.ID, "err", err)
	}
	r := Grade(res, it.Expected)

	if err := lf.LinkRun(ctx, run, it.ID, traceID); err != nil {
		return r, fmt.Errorf("record experiment item: %w", err)
	}
	if !r.Graded {
		return r, nil
	}
	scores := map[string]bool{ScoreTop1: r.Top1Correct}
	if r.KcalWithin != nil {
		scores[ScoreKcal] = *r.KcalWithin
	}
	for name, ok := range scores {
		if err := lf.Score(ctx, traceID, name, ok); err != nil {
			return r, fmt.Errorf("record experiment score: %w", err)
		}
	}
	return r, nil
}
