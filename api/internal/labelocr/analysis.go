package labelocr

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/tesserix/kora/api/internal/ai"
)

var ErrBudgetExhausted = errors.New("label analysis budget exhausted")

// Reviewer performs one independent image reading using the stronger gateway route.
type Reviewer interface {
	Review(context.Context, []byte, string) (Read, ai.Usage, error)
}

type Analysis struct {
	Status              string `json:"status"`
	Summary             string `json:"summary"`
	Escalated           bool   `json:"escalated"`
	ReviewOutcome       string `json:"review_outcome"`
	ConsumedAmountKnown bool   `json:"consumed_amount_known"`
}

type LabelResponse struct {
	Label
	Analysis    Analysis         `json:"analysis"`
	ImageSHA256 string           `json:"image_sha256"`
	JobID       string           `json:"job_id,omitempty"`
	Fields      map[string]Field `json:"fields"`
}

type Analyzer struct {
	reader   Reader
	reviewer Reviewer
	budget   Budget
}

func NewAnalyzer(reader Reader, reviewer Reviewer, budget Budget) Analyzer {
	return Analyzer{reader: reader, reviewer: reviewer, budget: budget}
}

func checkedRead(read Read) (Label, error) {
	label, err := Check(read.Fields, read.Failures)
	if err == nil && (label.Per100.ProteinG == nil || label.Per100.FatG == nil || label.Per100.CarbohydrateG == nil) {
		label.addIssue("incomplete_nutrition")
		label.NeedsReview = true
	}
	if read.Status != "" && read.Status != "completed" {
		label.addIssue("ocr_" + read.Status)
		label.NeedsReview = true
	}
	return label, err
}

// Analyze returns label facts only; an image is not evidence of consumption.
func (a Analyzer) Analyze(ctx context.Context, uid uuid.UUID, photo []byte, mime string) (LabelResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 22*time.Second)
	defer cancel()
	within, err := a.budget.WithinBudget(ctx, uid)
	if err != nil {
		return LabelResponse{}, err
	}
	if !within {
		return LabelResponse{}, ErrBudgetExhausted
	}
	started := time.Now()
	primaryCtx, primaryCancel := context.WithTimeout(ctx, 14*time.Second)
	read, readErr := a.reader.Read(primaryCtx, photo, mime)
	primaryCancel()
	label, checkErr := checkedRead(read)
	if readErr == nil {
		readErr = checkErr
	}
	recordErr := a.record(ctx, uid, ai.Usage{Provider: "document-intelligence", CallType: "read_label", LatencyMs: int(time.Since(started).Milliseconds())}, read.CostUSD, readErr)
	analysis := Analysis{ReviewOutcome: "not_needed"}
	if readErr != nil || label.NeedsReview {
		analysis.ReviewOutcome = "unavailable"
		if recordErr != nil {
			analysis.ReviewOutcome = "usage_unavailable"
		}
		if a.reviewer != nil && ctx.Err() == nil && recordErr == nil {
			within, budgetErr := a.budget.WithinBudget(ctx, uid)
			if budgetErr != nil || !within {
				analysis.ReviewOutcome = "budget_unavailable"
			} else {
				analysis.Escalated = true
				reviewCtx, reviewCancel := context.WithTimeout(ctx, 12*time.Second)
				review, usage, reviewErr := a.reviewer.Review(reviewCtx, photo, mime)
				reviewCancel()
				reviewLabel, validationErr := checkedRead(review)
				if reviewErr == nil {
					reviewErr = validationErr
				}
				usage.CallType = "read_label_review"
				if err := a.record(ctx, uid, usage, ai.EstimateCostUSD(usage), reviewErr); err != nil {
					analysis.ReviewOutcome = "usage_unavailable"
				}
				if reviewErr == nil {
					analysis.ReviewOutcome = "reviewed"
					if readErr != nil {
						read.Fields, label, readErr = review.Fields, reviewLabel, nil
					} else {
						for name, field := range review.Fields {
							original, exists := read.Fields[name]
							if !exists || bytes.Equal(bytes.TrimSpace(original.Value), []byte("null")) {
								read.Fields[name] = field
							} else if !bytes.Equal(original.Value, field.Value) && !bytes.Equal(bytes.TrimSpace(field.Value), []byte("null")) {
								label.addIssue("review_disagreement")
							}
						}
						updated, e := Check(read.Fields, read.Failures)
						if e == nil {
							updated.Issues = append(updated.Issues, label.Issues...)
							label = updated
						}
					}
					label.addIssue("vision_review")
					label.NeedsReview = true
				}
			}
		}
	}
	if readErr != nil {
		return LabelResponse{}, readErr
	}
	analysis.Status = "ready"
	analysis.Summary = "Nutrition values are shown as printed on the label. The amount eaten cannot be determined from this image."
	if label.NeedsReview {
		analysis.Status = "review_required"
		analysis.Summary = "Some label details remain uncertain. The readable values are shown; upload a clearer image for a more reliable reading. The amount eaten is unknown."
	}
	digest := sha256.Sum256(photo)
	return LabelResponse{Label: label, Analysis: analysis, Fields: read.Fields, JobID: read.JobID, ImageSHA256: hex.EncodeToString(digest[:])}, nil
}

func (a Analyzer) record(ctx context.Context, uid uuid.UUID, usage ai.Usage, cost float64, err error) error {
	usage.Outcome = ai.OutcomeOK
	if errors.Is(err, context.DeadlineExceeded) {
		usage.Outcome = ai.OutcomeTimeout
	} else if err != nil {
		usage.Outcome = ai.OutcomeError
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	return a.budget.Record(ctx, uid, usage, cost)
}
