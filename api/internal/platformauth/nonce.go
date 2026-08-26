package platformauth

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Nonce is a single-use marker for a signed platform request.
type Nonce struct {
	Nonce     uuid.UUID `gorm:"column:nonce;type:uuid;primaryKey"`
	SeenAt    time.Time `gorm:"column:seen_at;not null;default:now()"`
	ExpiresAt time.Time `gorm:"column:expires_at;not null"`
}

// TableName pins the table so GORM's pluraliser cannot drift off it.
func (Nonce) TableName() string { return "platform_request_nonces" }

// NonceStore records nonces so a captured request cannot be replayed inside
// its validity window.
type NonceStore interface {
	// Claim records the nonce and reports whether this was its first use.
	// False means replay. An error means the check could not be PERFORMED —
	// callers must treat that as a rejection, never as a pass. That is the
	// whole contract of this interface: there is no third answer.
	Claim(ctx context.Context, nonce string, expiresAt time.Time) (bool, error)
}

type gormNonceStore struct{ db *gorm.DB }

// NewNonceStore builds a Postgres-backed NonceStore. The database is the only
// state shared between kora-api pods, so an in-memory store would let a
// replay through simply by being routed elsewhere.
func NewNonceStore(db *gorm.DB) NonceStore { return &gormNonceStore{db: db} }

// Claim writes the nonce, letting the primary key decide the race.
//
// The federation client emits 128 bits of bare hex rather than a dashed UUID
// (see its randomNonce); uuid.Parse accepts that form, which is why this
// column can be UUID rather than TEXT. A nonce in neither form is a client
// error and is reported as one — never as a successful claim.
func (s *gormNonceStore) Claim(ctx context.Context, nonce string, expiresAt time.Time) (bool, error) {
	parsed, err := uuid.Parse(nonce)
	if err != nil {
		return false, fmt.Errorf("platformauth: nonce must be a uuid: %w", err)
	}

	// ON CONFLICT DO NOTHING makes the unique constraint itself the replay
	// check, so there is no read-then-write race to lose. The database
	// decides who wins.
	res := s.db.WithContext(ctx).
		Clauses(clause.OnConflict{DoNothing: true}).
		Create(&Nonce{Nonce: parsed, ExpiresAt: expiresAt})

	if res.Error != nil {
		return false, fmt.Errorf("platformauth: claim nonce: %w", res.Error)
	}
	return res.RowsAffected == 1, nil
}

// SweepExpiredNonces deletes rows past their expires_at and returns how many
// went.
//
// Safe by construction: expires_at is signedTS + window, exactly the instant
// a request stops being signature-valid (see Middleware), so a row can never
// be deleted while the request it guards is still replayable.
//
// Kora has no cron process, so nothing calls this on a schedule yet. It is
// exported and tested rather than inlined because the table otherwise grows
// without bound, and because a sweep written later — under time pressure,
// by someone who has not read Middleware — is where the "delete anything
// older than a day" mistake gets made.
func SweepExpiredNonces(ctx context.Context, db *gorm.DB) (int64, error) {
	res := db.WithContext(ctx).Where("expires_at < now()").Delete(&Nonce{})
	if res.Error != nil {
		return 0, fmt.Errorf("platformauth: sweep expired nonces: %w", res.Error)
	}
	return res.RowsAffected, nil
}
