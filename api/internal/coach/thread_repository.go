package coach

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
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
}

// ThreadRepository persists and replays a user's coach thread.
type ThreadRepository struct {
	db *gorm.DB
}

func NewThreadRepository(db *gorm.DB) ThreadRepository { return ThreadRepository{db: db} }

// AppendExchange stores a question and its answer as two turns in ONE
// transaction, so a partial write can never leave a question without an
// answer. citations belong to the answer; a user turn never has any.
func (r ThreadRepository) AppendExchange(ctx context.Context, userID uuid.UUID, question, answer string, citations []Fact) error {
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		userTurn := Turn{UserID: userID, Role: TurnRoleUser, Text: question}
		if err := tx.Create(&userTurn).Error; err != nil {
			return err
		}
		ottoTurn := Turn{UserID: userID, Role: TurnRoleOtto, Text: answer}
		if err := tx.Create(&ottoTurn).Error; err != nil {
			return err
		}
		return insertCitations(tx, ottoTurn.ID, citations)
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

	out := make([]StoredTurn, len(rows))
	for i, t := range rows {
		out[i] = StoredTurn{Role: t.Role, Text: t.Text, CreatedAt: t.CreatedAt, Citations: cites[t.ID]}
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
