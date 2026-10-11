package labelocr

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/ai/decide"
)

type photoEvidenceKey struct{}

var ErrDecisionUnavailable = errors.New("photo decision unavailable")

type PhotoDecider interface {
	Decide(context.Context, json.RawMessage, map[string]decide.Question) (decide.Result, error)
}

type PhotoVision interface {
	ResolvePhoto(context.Context, uuid.UUID, []byte, string) (ai.Resolution, error)
}

type PhotoResolver struct {
	reader   Reader
	decision PhotoDecider
	reviewer Reviewer
	vision   PhotoVision
	budget   Budget
}

func NewPhotoResolver(reader Reader, decision PhotoDecider, reviewer Reviewer, vision PhotoVision, budget Budget) PhotoResolver {
	return PhotoResolver{reader: reader, decision: decision, reviewer: reviewer, vision: vision, budget: budget}
}

func (p PhotoResolver) ResolvePhoto(ctx context.Context, uid uuid.UUID, image []byte, mime string) (ai.Resolution, error) {
	ctx, cancel := context.WithTimeout(ctx, 22*time.Second)
	defer cancel()
	if err := p.allowed(ctx, uid); err != nil {
		return ai.Resolution{}, err
	}
	started := time.Now()
	ocrCtx, ocrCancel := context.WithTimeout(ctx, 5*time.Second)
	read, readErr := p.reader.Read(ocrCtx, image, mime)
	ocrCancel()
	label, checkErr := checkedRead(read)
	if readErr == nil {
		readErr = checkErr
	}
	recorder := Analyzer{budget: p.budget}
	if err := recorder.record(ctx, uid, ai.Usage{Provider: "document-intelligence", CallType: "photo_ocr", LatencyMs: int(time.Since(started).Milliseconds())}, read.CostUSD, readErr); err != nil {
		return ai.Resolution{}, err
	}
	if err := ctx.Err(); err != nil {
		return ai.Resolution{}, err
	}
	evidence := &ai.PhotoEvidence{PolicyVersion: "photo-evidence-v1", OCRJobID: read.JobID, OCRStatus: read.Status}
	evidence.OCRFields, _ = json.Marshal(read.Fields)
	evidence.OCROutcome = "ok"
	if readErr != nil {
		evidence.OCROutcome = "unreadable_or_unavailable"
	}
	// Only validated status flags cross into Jev; OCR strings are untrusted content.
	state, _ := json.Marshal(map[string]any{"label_readable": readErr == nil, "review_required": label.NeedsReview, "has_extracted_fields": hasLabelFields(read.Fields), "consumed_amount_known": false})
	if err := p.allowed(ctx, uid); err != nil {
		return ai.Resolution{}, err
	}
	started = time.Now()
	decision, decisionErr := p.decision.Decide(ctx, state, map[string]decide.Question{"route": decide.Choice{
		Instructions: "Choose the next image processing operation from the evidence flags. Never infer consumption or authorize a diary write.",
		Criteria:     map[string]string{"label": "Readable nutrition label without review issues; report label facts only.", "review": "Extracted label evidence is incomplete or requires independent vision review.", "vision": "No usable label evidence; identify food using the normal vision model.", "retake": "Evidence cannot support either interpretation; request a clearer image."},
	}})
	usage := ai.Usage{Provider: "typesafe", Model: decision.Model, CallType: "photo_decide", TokensIn: decision.Usage.InputTokens, TokensOut: decision.Usage.OutputTokens, LatencyMs: int(time.Since(started).Milliseconds())}
	if err := recorder.record(ctx, uid, usage, ai.EstimateCostUSD(usage), decisionErr); err != nil {
		return ai.Resolution{}, err
	}
	if decisionErr != nil {
		return ai.Resolution{PhotoEvidence: evidence}, ErrDecisionUnavailable
	}
	evidence.DecisionModel = decision.Model
	route := decision.Answers["route"].Choice
	// The model cannot bypass numerical checks or turn a serving into consumption.
	if route == "label" && (readErr != nil || label.NeedsReview) {
		route = "retake"
	}
	if route == "vision" && readErr == nil {
		route = "review"
	}
	evidence.Route = route
	switch route {
	case "label":
		return photoLabelResult(label, evidence), nil
	case "review":
		if p.reviewer == nil {
			return photoRetake(evidence), nil
		}
		if err := p.allowed(ctx, uid); err != nil {
			return ai.Resolution{}, err
		}
		reviewCtx, reviewCancel := context.WithTimeout(ctx, 10*time.Second)
		reviewed, u, reviewErr := p.reviewer.Review(reviewCtx, image, mime)
		reviewCancel()
		checked, err := checkedRead(reviewed)
		if reviewErr == nil {
			reviewErr = err
		}
		u.CallType = "photo_label_review"
		if err := recorder.record(ctx, uid, u, ai.EstimateCostUSD(u), reviewErr); err != nil {
			return ai.Resolution{}, err
		}
		if reviewErr != nil || slices.Contains(checked.Issues, IssueOutOfRange) || slices.Contains(checked.Issues, IssueAtwaterMismatch) {
			return photoRetake(evidence), nil
		}
		if readErr == nil {
			for name, f := range read.Fields {
				if other, ok := reviewed.Fields[name]; ok && !bytes.Equal(bytes.TrimSpace(f.Value), []byte("null")) && !bytes.Equal(bytes.TrimSpace(other.Value), []byte("null")) && !sameFieldValue(f.Value, other.Value) {
					return photoRetake(evidence), nil
				}
			}
		}
		checked.NeedsReview = true
		checked.addIssue("vision_review")
		return photoLabelResult(checked, evidence), nil
	case "vision":
		res, err := p.vision.ResolvePhoto(context.WithValue(ctx, photoEvidenceKey{}, evidence), uid, image, mime)
		res.PhotoEvidence = evidence
		if len(res.Candidates) > 0 {
			if res.Tier == ai.TierAuto {
				res.Tier = ai.TierConfirm
			}
			for i := range res.Candidates {
				res.Candidates[i].PortionAssumed = true
				if res.Candidates[i].Tier == ai.TierAuto {
					res.Candidates[i].Tier = ai.TierConfirm
				}
			}
		}
		return res, err
	case "retake":
		return photoRetake(evidence), nil
	default:
		return ai.Resolution{PhotoEvidence: evidence}, ErrDecisionUnavailable
	}
}

func (p PhotoResolver) allowed(ctx context.Context, uid uuid.UUID) error {
	ok, err := p.budget.WithinBudget(ctx, uid)
	if err != nil {
		return err
	}
	if !ok {
		return ErrBudgetExhausted
	}
	return nil
}

func photoRetake(e *ai.PhotoEvidence) ai.Resolution {
	return ai.Resolution{Tier: ai.TierFollowUp, Provenance: "label_ocr", PhotoEvidence: e, FollowUpQuestion: "I couldn't verify the image details. Upload a clearer photo showing the whole dish or, for packaged food, the nutrition label. The amount eaten is unknown."}
}

func photoLabelResult(label Label, e *ai.PhotoEvidence) ai.Resolution {
	e.Label, _ = json.Marshal(label)
	unit := "g"
	if label.Basis == BasisPer100ml {
		unit = "ml"
	}
	summary := fmt.Sprintf("The label reads %.1f kcal per 100 %s. This is label information, not calories eaten; the amount consumed is unknown.", *label.Per100.EnergyKcal, unit)
	if label.NeedsReview {
		summary = "An independent image reading suggests these label values, but they remain unverified. " + summary
	}
	return ai.Resolution{Tier: ai.TierFollowUp, Provenance: "label_ocr", PhotoEvidence: e, FollowUpQuestion: summary}
}

func hasLabelFields(fields map[string]Field) bool {
	for _, field := range fields {
		value := bytes.TrimSpace(field.Value)
		if len(value) > 0 && !bytes.Equal(value, []byte("null")) {
			return true
		}
	}
	return false
}
