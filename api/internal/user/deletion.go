package user

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// ErrNotFound is returned by Delete when no user row has the id. Handlers
// map it to 404; every other error is a 500.
var ErrNotFound = errors.New("user: not found")

// CacheEvicter is the one method Delete needs from ai.Cache.
//
// It is declared HERE, at the consumer, and not taken as an ai.Cache, because
// internal/user cannot import internal/ai at all: ai imports internal/nutrition
// and nutrition imports internal/user, so the direct dependency is an import
// cycle. ai.Cache and ai.NoCache both satisfy this structurally at the wiring
// site, and tests get a two-line fake for free.
type CacheEvicter interface {
	DeleteByUser(ctx context.Context, userID uuid.UUID) error
}

// IdentityDeleter removes the caller's identity from the auth provider. Same
// consumer-declared-interface reason as CacheEvicter, minus the cycle:
// auth.IdentityDeleter satisfies it, and a test fake needs no Firebase.
type IdentityDeleter interface {
	DeleteIdentity(ctx context.Context, firebaseUID string) error
}

// AppleRevoker is the slice of appleid.Client this service needs. Declared
// here so the deletion tests can drive a fake without an Apple client, exactly
// as AppleExchanger is in apple_handler.go. The method name matches
// (*appleid.Client).RevokeRefreshToken so the real client satisfies it
// directly, with no adapter.
type AppleRevoker interface {
	RevokeRefreshToken(ctx context.Context, refreshToken string) error
}

// AuditRecorder writes the admin audit row for a deletion. It MUST write on
// the tx it is handed, so the audit row and the DELETE commit or roll back
// together -- an audit trail that survives a rolled-back delete is worse than
// none.
//
// It is a func rather than a direct call to admin.RecordEvent because
// internal/user cannot import internal/admin: admin -> ai -> nutrition ->
// user is an import cycle (internal/admin/mutations.go imports internal/ai for
// the cache-generation bump, and internal/nutrition/handler.go imports
// internal/user). The wiring site imports both packages and supplies a
// one-line closure:
//
//	func(tx *gorm.DB, actorID, actorEmail string, targetID uuid.UUID) error {
//	    return admin.RecordEvent(tx, admin.Actor{ID: actorID, Email: actorEmail},
//	        admin.ActionUserDeleted, admin.TargetTypeUser, targetID, nil, nil)
//	}
type AuditRecorder func(tx *gorm.DB, actorID, actorEmail string, targetID uuid.UUID) error

// ErrNoAuditRecorder is returned when an ADMIN deletion is attempted on a
// Service that was wired without an AuditRecorder. Failing loudly is the point:
// silently skipping the audit row would make an admin deletion indistinguishable
// from a self-deletion after the fact.
var ErrNoAuditRecorder = errors.New("user: admin deletion requires an audit recorder")

// Service owns user operations that span more than the users table.
//
// apple may be nil: router.go already nil-checks deps.AppleExchanger because
// Apple is not configured in every environment, and Delete must degrade to
// "skip revocation" rather than panic when it is not.
type Service struct {
	db         *gorm.DB
	cache      CacheEvicter
	identities IdentityDeleter
	apple      AppleRevoker
	audit      AuditRecorder
}

// NewService builds the deletion service. Both the admin "delete this user"
// endpoint and the user's own DELETE /v1/me go through the same instance --
// two implementations of an 18-table cascade is the failure this design
// exists to prevent.
func NewService(db *gorm.DB, c CacheEvicter, id IdentityDeleter, a AppleRevoker, audit AuditRecorder) Service {
	return Service{db: db, cache: c, identities: id, apple: a, audit: audit}
}

// DeleteActor identifies who is deleting. IsAdmin drives whether a
// kora_admin_events row is written: that table is scoped to admin actions,
// and a user deleting their own account is not one.
type DeleteActor struct {
	IsAdmin bool
	ID      string
	Email   string
}

// DeleteResult reports what the deletion actually did. FirebaseIdentityRemoved
// is false when the DB delete succeeded but the identity survived -- see the
// comment on Delete.
type DeleteResult struct {
	Transfers               []Transfer `json:"transfers"`
	FirebaseIdentityRemoved bool       `json:"firebase_identity_removed"`
	AppleTokenRevoked       bool       `json:"apple_token_revoked"`
}

// Delete removes a user account. Irreversible; there is no grace period.
//
// The ORDER of these steps is load-bearing and must not be "tidied":
//
//  1. Ownership transfer FIRST -- once the cascade fires the groups are gone.
//  2. Apple revoke BEFORE the DB delete -- the token lives on the users row.
//     NON-FATAL: blocking on a third-party outage would break the one thing
//     Apple requires, that deletion completes in-app.
//  3. DELETE FROM users -- 18 cascades, one statement, inside the transaction
//     that also writes the audit row.
//  4. Redis eviction -- the cached values are the user's own resolutions.
//     Non-fatal.
//  5. Firebase identity LAST. If it fails after the DB delete, the personal
//     data is already gone and the path self-heals for a self-deleting user
//     (they sign in, EnsureUser makes a fresh empty row, they delete again).
//     Reverse the order and a failed DB delete leaves an un-signin-able
//     identity with orphaned personal data and no retry path -- exactly what
//     deletion exists to prevent.
func (s Service) Delete(ctx context.Context, userID uuid.UUID, actor DeleteActor) (DeleteResult, error) {
	var res DeleteResult

	// The row is loaded up front because two later steps need columns that
	// stop existing the moment the DELETE lands: the Apple refresh token and
	// the Firebase uid.
	var u User
	if err := s.db.WithContext(ctx).Where("id = ?", userID).First(&u).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return res, ErrNotFound
		}
		return res, fmt.Errorf("user: load for delete: %w", err)
	}

	// AppleRefreshToken is '' (not NULL) for every row created via
	// UpsertByFirebaseUID -- see model.go. The presence check MUST be != "".
	// s.apple is nil when Apple is not configured for this deployment.
	if u.AppleRefreshToken != "" && s.apple != nil {
		if err := s.apple.RevokeRefreshToken(ctx, u.AppleRefreshToken); err != nil {
			slog.ErrorContext(ctx, "apple token revoke failed; continuing with deletion",
				"user_id", userID, "error", err)
		} else {
			res.AppleTokenRevoked = true
		}
	}

	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		transfers, err := transferOwnership(tx, userID)
		if err != nil {
			return err
		}
		res.Transfers = transfers

		if actor.IsAdmin {
			if s.audit == nil {
				return ErrNoAuditRecorder
			}
			// Written on tx, so audit and delete commit or roll back together.
			if err := s.audit(tx, actor.ID, actor.Email, userID); err != nil {
				return fmt.Errorf("user: record deletion audit: %w", err)
			}
		}

		out := tx.Exec(`DELETE FROM users WHERE id = ?`, userID)
		if out.Error != nil {
			return fmt.Errorf("user: delete row: %w", out.Error)
		}
		if out.RowsAffected == 0 {
			return ErrNotFound
		}
		return nil
	})
	if err != nil {
		// res.Transfers describes work the rolled-back transaction undid, so
		// reporting it alongside the error would be a lie.
		return DeleteResult{}, err
	}

	if err := s.cache.DeleteByUser(ctx, userID); err != nil {
		slog.ErrorContext(ctx, "cache eviction failed after deletion; entries expire on TTL",
			"user_id", userID, "error", err)
	}

	if err := s.identities.DeleteIdentity(ctx, u.FirebaseUID); err != nil {
		slog.ErrorContext(ctx, "firebase identity survived deletion; NEEDS MANUAL CLEANUP",
			"user_id", userID, "firebase_uid", u.FirebaseUID, "error", err)
	} else {
		res.FirebaseIdentityRemoved = true
	}

	return res, nil
}
