package social

import (
	"context"
	"crypto/rand"
	"errors"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/user"
)

type Service struct {
	repo  Repository
	users user.Repository
}

func NewService(repo Repository, users user.Repository) Service {
	return Service{repo: repo, users: users}
}

// Crockford base32 alphabet (no I, L, O, U to avoid ambiguity).
const codeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func generateCode() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	for i := range b {
		b[i] = codeAlphabet[int(b[i])%len(codeAlphabet)]
	}
	return string(b), nil
}

func (s Service) SendRequest(ctx context.Context, requesterID uuid.UUID, email, code string) (Friendship, error) {
	var target user.User
	var err error
	switch {
	case email != "" && code == "":
		target, err = s.users.FindByEmail(ctx, email)
	case code != "" && email == "":
		target, err = s.users.FindByCode(ctx, code)
	default:
		return Friendship{}, ErrBadInput
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return Friendship{}, ErrUserNotFound
	}
	if err != nil {
		return Friendship{}, err
	}
	if target.ID == requesterID {
		return Friendship{}, ErrSelfFriend
	}

	existing, err := s.repo.FindByPair(ctx, requesterID, target.ID)
	if err != nil {
		return Friendship{}, err
	}
	if existing != nil {
		if existing.Status == FriendStatusPending && existing.AddresseeID == requesterID {
			// a reverse pending request exists → accept it
			if err := s.repo.UpdateStatus(ctx, existing.ID, FriendStatusAccepted); err != nil {
				return Friendship{}, err
			}
			existing.Status = FriendStatusAccepted
		}
		return *existing, nil // accepted or same-direction pending → idempotent
	}
	return s.repo.Create(ctx, Friendship{RequesterID: requesterID, AddresseeID: target.ID, Status: FriendStatusPending})
}

func (s Service) Accept(ctx context.Context, addresseeID, requestID uuid.UUID) error {
	f, err := s.repo.FindByID(ctx, requestID)
	if err != nil {
		return err
	}
	if f == nil || f.Status != FriendStatusPending {
		return ErrNotFound
	}
	if f.AddresseeID != addresseeID {
		return ErrForbidden
	}
	return s.repo.UpdateStatus(ctx, f.ID, FriendStatusAccepted)
}

func (s Service) Decline(ctx context.Context, addresseeID, requestID uuid.UUID) error {
	f, err := s.repo.FindByID(ctx, requestID)
	if err != nil {
		return err
	}
	if f == nil || f.Status != FriendStatusPending {
		return ErrNotFound
	}
	if f.AddresseeID != addresseeID {
		return ErrForbidden
	}
	return s.repo.Delete(ctx, f.ID)
}

func (s Service) Unfriend(ctx context.Context, userID, otherID uuid.UUID) error {
	f, err := s.repo.FindByPair(ctx, userID, otherID)
	if err != nil {
		return err
	}
	if f == nil || f.Status != FriendStatusAccepted {
		return ErrNotFound
	}
	return s.repo.Delete(ctx, f.ID)
}

func (s Service) ListFriends(ctx context.Context, userID uuid.UUID) ([]FriendView, error) {
	return s.repo.ListAccepted(ctx, userID)
}

func (s Service) ListRequests(ctx context.Context, userID uuid.UUID) (incoming, outgoing []RequestView, err error) {
	return s.repo.ListPending(ctx, userID)
}

func (s Service) MyCode(ctx context.Context, userID uuid.UUID) (string, string, error) {
	u, err := s.users.ByID(ctx, userID)
	if err != nil {
		return "", "", err
	}
	if u.FriendCode == "" {
		code, err := generateCode()
		if err != nil {
			return "", "", err
		}
		if err := s.users.SetFriendCode(ctx, userID, code); err != nil {
			return "", "", err
		}
		u.FriendCode = code
	}
	return u.FriendCode, "mobile://friend/" + u.FriendCode, nil
}
