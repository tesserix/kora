package coach

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/tesserix/kora/api/internal/mentor"
)

// maxThreadTurns is the number of most-recent turns GET /v1/coach/thread
// replays. The table itself is unbounded; this caps the read.
const maxThreadTurns = 50

// StoredTurn is one replayed turn with its citations attached.
type StoredTurn struct {
	Role      TurnRole
	Text      string
	CreatedAt time.Time
	Citations []Fact
	Proposal  *mentor.CommitmentProposal
	Plan      *PlanProposal
}

// Attachments are the structured artefacts an answer can carry alongside its
// text: a commitment the user can adopt, a plan they can approve. They are one
// struct because both are written in the same transaction as the turn they
// belong to — a proposal whose turn is missing has nothing to attach to.
type Attachments struct {
	Commitment *mentor.CommitmentProposal
	Plan       *PlanProposal
}

// ThreadRepository persists and replays a user's coach thread.
type ThreadRepository struct {
	db *gorm.DB
}

func NewThreadRepository(db *gorm.DB) ThreadRepository { return ThreadRepository{db: db} }

// AppendExchange stores a question and its answer as two turns in ONE
// transaction, so a partial write can never leave a question without an
// answer. citations belong to the answer; a user turn never has any.
func (r ThreadRepository) AppendExchange(
	ctx context.Context,
	userID uuid.UUID,
	question, answer string,
	citations []Fact,
	attach Attachments,
) error {
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		userTurn := Turn{UserID: userID, Role: TurnRoleUser, Text: question}
		if err := tx.Create(&userTurn).Error; err != nil {
			return err
		}
		ottoTurn := Turn{UserID: userID, Role: TurnRoleOtto, Text: answer}
		if err := tx.Create(&ottoTurn).Error; err != nil {
			return err
		}
		if err := insertCitations(tx, ottoTurn.ID, citations); err != nil {
			return err
		}
		if attach.Commitment != nil {
			proposal := *attach.Commitment
			proposal.UserID = userID
			proposal.CoachTurnID = ottoTurn.ID
			if err := tx.Create(&proposal).Error; err != nil {
				return err
			}
		}
		if attach.Plan != nil {
			plan := *attach.Plan
			plan.UserID = userID
			plan.CoachTurnID = ottoTurn.ID
			if err := tx.Create(&plan).Error; err != nil {
				return err
			}
			attach.Plan.ID = plan.ID
			attach.Plan.CreatedAt = plan.CreatedAt
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("coach: append exchange: %w", err)
	}
	return nil
}

func insertCitations(tx *gorm.DB, turnID uuid.UUID, citations []Fact) error {
	if len(citations) == 0 {
		return nil
	}
	rows := make([]TurnCitation, len(citations))
	for i, c := range citations {
		rows[i] = TurnCitation{TurnID: turnID, Label: c.Label, Value: c.Value, Position: i}
	}
	return tx.Create(&rows).Error
}

// ListRecent returns the limit most recent turns for userID, oldest first so
// the client renders top-to-bottom without reversing. A user with more than
// limit turns sees their most recent ones, not their first.
func (r ThreadRepository) ListRecent(ctx context.Context, userID uuid.UUID, limit int) ([]StoredTurn, error) {
	rows := []Turn{}
	if err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("seq DESC").
		Limit(limit).
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("coach: list recent turns: %w", err)
	}

	// Selected newest-first to apply the cap; flip to oldest-first for display.
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}

	cites, err := r.citationsFor(ctx, rows)
	if err != nil {
		return nil, err
	}
	proposals, err := r.proposalsFor(ctx, userID, rows)
	if err != nil {
		return nil, err
	}
	plans, err := r.plansFor(ctx, userID, rows)
	if err != nil {
		return nil, err
	}

	out := make([]StoredTurn, len(rows))
	for i, t := range rows {
		out[i] = StoredTurn{
			Role: t.Role, Text: t.Text, CreatedAt: t.CreatedAt,
			Citations: cites[t.ID], Proposal: proposals[t.ID], Plan: plans[t.ID],
		}
	}
	return out, nil
}

func (r ThreadRepository) proposalsFor(
	ctx context.Context,
	userID uuid.UUID,
	turns []Turn,
) (map[uuid.UUID]*mentor.CommitmentProposal, error) {
	if len(turns) == 0 {
		return map[uuid.UUID]*mentor.CommitmentProposal{}, nil
	}
	ids := make([]uuid.UUID, 0, len(turns))
	for _, turn := range turns {
		ids = append(ids, turn.ID)
	}
	var rows []mentor.CommitmentProposal
	if err := r.db.WithContext(ctx).
		Where("user_id = ? AND coach_turn_id IN ?", userID, ids).
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("coach: list commitment proposals: %w", err)
	}
	out := make(map[uuid.UUID]*mentor.CommitmentProposal, len(rows))
	for i := range rows {
		out[rows[i].CoachTurnID] = &rows[i]
	}
	return out, nil
}

func (r ThreadRepository) plansFor(
	ctx context.Context,
	userID uuid.UUID,
	turns []Turn,
) (map[uuid.UUID]*PlanProposal, error) {
	if len(turns) == 0 {
		return map[uuid.UUID]*PlanProposal{}, nil
	}
	ids := make([]uuid.UUID, 0, len(turns))
	for _, turn := range turns {
		ids = append(ids, turn.ID)
	}
	var rows []PlanProposal
	if err := r.db.WithContext(ctx).
		Where("user_id = ? AND coach_turn_id IN ?", userID, ids).
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("coach: list plan proposals: %w", err)
	}
	out := make(map[uuid.UUID]*PlanProposal, len(rows))
	for i := range rows {
		out[rows[i].CoachTurnID] = &rows[i]
	}
	return out, nil
}

// AcceptPlan records the user's approval of a plan proposal and returns it.
//
// It is idempotent: re-approving keeps the first accepted_at, because the
// timestamp is when the user decided, and a double-tap is not a second
// decision. A plan owned by anybody else is ErrPlanNotFound, not a 403 — the
// caller must not learn that the id exists.
func (r ThreadRepository) AcceptPlan(
	ctx context.Context,
	userID, planID uuid.UUID,
	now time.Time,
) (PlanProposal, error) {
	var out PlanProposal
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ? AND user_id = ?", planID, userID).
			First(&out).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrPlanNotFound
		}
		if err != nil {
			return err
		}
		if out.AcceptedAt != nil {
			return nil
		}
		// Read the stored value back: Postgres keeps microseconds, so echoing
		// the caller's clock would make a second tap look like a new decision.
		return tx.Model(&out).
			Clauses(clause.Returning{Columns: []clause.Column{{Name: "accepted_at"}}}).
			Where("id = ? AND user_id = ?", planID, userID).
			Update("accepted_at", now.UTC()).Error
	})
	if errors.Is(err, ErrPlanNotFound) {
		return PlanProposal{}, err
	}
	if err != nil {
		return PlanProposal{}, fmt.Errorf("coach: accept plan proposal: %w", err)
	}
	return out, nil
}

// citationsFor loads every citation for turns in one query, keyed by turn id,
// so replaying a thread does not issue an N+1 read per turn.
func (r ThreadRepository) citationsFor(ctx context.Context, turns []Turn) (map[uuid.UUID][]Fact, error) {
	if len(turns) == 0 {
		return map[uuid.UUID][]Fact{}, nil
	}
	ids := make([]uuid.UUID, 0, len(turns))
	for _, t := range turns {
		ids = append(ids, t.ID)
	}

	rows := []TurnCitation{}
	if err := r.db.WithContext(ctx).
		Where("turn_id IN ?", ids).
		Order("turn_id, position").
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("coach: list turn citations: %w", err)
	}

	out := make(map[uuid.UUID][]Fact, len(rows))
	for _, c := range rows {
		out[c.TurnID] = append(out[c.TurnID], Fact{Label: c.Label, Value: c.Value})
	}
	return out, nil
}
