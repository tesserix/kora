package social

import (
	"context"
	"crypto/rand"
	"errors"
	"log/slog"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/identity"
	"github.com/tesserix/kora/api/internal/user"
)

type notifier interface {
	FriendRequested(ctx context.Context, recipientID, actorID uuid.UUID) error
	FriendAccepted(ctx context.Context, recipientID, actorID uuid.UUID) error
}

// handleResolver is the narrow surface SendRequest needs from
// identity.Repository: a FOLDED handle to its owner, the exact same lookup
// GET /v1/users/lookup uses. identity.Repository satisfies this directly.
//
// It is an interface (not the concrete identity.Repository, which social
// otherwise could use directly, since internal/identity does not import
// internal/social) so a Service built without WithHandles has a nil-checkable
// zero value instead of a struct wrapping a nil *gorm.DB that would panic on
// first query.
type handleResolver interface {
	FindByCanonical(ctx context.Context, canonical string) (user.User, error)
}

type Service struct {
	repo      Repository
	users     user.Repository
	handles   handleResolver
	notifier  notifier
	avatarURL func(path string) string
}

// NewService takes avatarURL as the composer from a stored object PATH to a
// public URL (same shape as identity.Service's, see internal/identity/service.go).
// ListAccepted returns FriendView.AvatarURL holding the raw path -- ListFriends
// runs it through avatarURL before returning to a handler, so the repository
// itself never has to depend on object storage.
func NewService(repo Repository, users user.Repository, avatarURL func(path string) string) Service {
	return Service{repo: repo, users: users, avatarURL: avatarURL}
}

func (s Service) WithNotifier(n notifier) Service {
	s.notifier = n
	return s
}

// WithHandles wires a handle resolver (identity.Repository in production)
// into SendRequest so a handle third identifier can be resolved. A Service
// built without this call still compiles and runs -- a handle argument to
// SendRequest simply resolves to ErrUserNotFound, same as any other
// unresolvable identifier -- so every existing caller that never mentions
// handles keeps working unchanged.
func (s Service) WithHandles(h handleResolver) Service {
	s.handles = h
	return s
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

// SendRequest resolves exactly one of email, code or handle to a target user
// and sends (or idempotently re-sends) a friend request. handle is resolved
// through the SAME canonical fold GET /v1/users/lookup uses (identity.Canonical
// + a handle_canonical lookup) -- there must be exactly one implementation of
// that fold, and duplicating it here to avoid the identity import would be
// precisely the class of bug this method exists to close (kora#449 task 13b:
// a confusable handle like ada_l vs ada_1 sending a friend request to a
// stranger, who is then invited into a share circle with real body metrics).
func (s Service) SendRequest(ctx context.Context, requesterID uuid.UUID, email, code, handle string) (Friendship, error) {
	var target user.User
	var err error
	switch {
	case email != "" && code == "" && handle == "":
		target, err = s.users.FindByEmail(ctx, email)
	case code != "" && email == "" && handle == "":
		target, err = s.users.FindByCode(ctx, code)
	case handle != "" && email == "" && code == "":
		target, err = s.resolveHandle(ctx, handle)
	default:
		return Friendship{}, ErrBadInput
	}
	if errors.Is(err, gorm.ErrRecordNotFound) || errors.Is(err, identity.ErrNotFound) {
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
			if s.notifier != nil {
				if nerr := s.notifier.FriendAccepted(ctx, existing.RequesterID, requesterID); nerr != nil {
					slog.WarnContext(ctx, "notify friend accept failed", "err", nerr)
				}
			}
		}
		return *existing, nil // accepted or same-direction pending → idempotent
	}
	created, err := s.repo.Create(ctx, Friendship{RequesterID: requesterID, AddresseeID: target.ID, Status: FriendStatusPending})
	if err != nil {
		return Friendship{}, err
	}
	if s.notifier != nil {
		if nerr := s.notifier.FriendRequested(ctx, target.ID, requesterID); nerr != nil {
			slog.WarnContext(ctx, "notify friend request failed", "err", nerr)
		}
	}
	return created, nil
}

// resolveHandle folds raw through identity.Canonical and looks the result up
// by handles.FindByCanonical -- the exact same two steps identity.Service.Lookup
// runs, so a handle sent here always resolves to whoever GET
// /v1/users/lookup would have shown for it.
//
// Every failure mode -- invalid shape, reserved, no such handle, or no
// resolver wired at all -- collapses to identity.ErrNotFound. SendRequest's
// caller then sees ErrUserNotFound, the same answer an unknown email or code
// gets: "that handle can't exist" and "nobody has it" must not be
// distinguishable from outside, or a client could probe handle shapes for
// what's reserved.
func (s Service) resolveHandle(ctx context.Context, raw string) (user.User, error) {
	if s.handles == nil {
		return user.User{}, identity.ErrNotFound
	}
	_, canonical, err := identity.Canonical(raw)
	if err != nil {
		return user.User{}, identity.ErrNotFound
	}
	return s.handles.FindByCanonical(ctx, canonical)
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
	if err := s.repo.UpdateStatus(ctx, f.ID, FriendStatusAccepted); err != nil {
		return err
	}
	if s.notifier != nil {
		if nerr := s.notifier.FriendAccepted(ctx, f.RequesterID, addresseeID); nerr != nil {
			slog.WarnContext(ctx, "notify friend accept failed", "err", nerr)
		}
	}
	return nil
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
	// Unfriending must also revoke circle membership in both directions --
	// otherwise a share_circle_members row outlives the friendship it was
	// predicated on, and cross-user reads (e.g. groups.Progress) keep
	// leaking data through the group path even though the friends path is
	// safe (kora#326 whole-branch review, F2).
	return s.repo.DeleteAndRevokeCircles(ctx, f.ID, userID, otherID)
}

func (s Service) ListFriends(ctx context.Context, userID uuid.UUID) ([]FriendView, error) {
	views, err := s.repo.ListAccepted(ctx, userID)
	if err != nil {
		return nil, err
	}
	for i := range views {
		// Guarded here, not left to the composer: a caller-supplied avatarURL
		// is not guaranteed to treat "" specially (assets.Noop{} and
		// assets.gcsStore.URL do, but a test double need not), and "no
		// picture" must never become a URL pointing at nothing.
		if views[i].AvatarURL != "" {
			views[i].AvatarURL = s.avatarURL(views[i].AvatarURL) // raw path -> composed URL
		}
	}
	return views, nil
}

func (s Service) ListRequests(ctx context.Context, userID uuid.UUID) (incoming, outgoing []RequestView, err error) {
	incoming, outgoing, err = s.repo.ListPending(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	// Same raw-path -> composed-URL step ListFriends performs, and the same
	// "" guard: a caller-supplied avatarURL is not guaranteed to treat ""
	// specially, and "no picture" must never become a URL pointing at nothing.
	for i := range incoming {
		if incoming[i].User.AvatarURL != "" {
			incoming[i].User.AvatarURL = s.avatarURL(incoming[i].User.AvatarURL)
		}
	}
	for i := range outgoing {
		if outgoing[i].User.AvatarURL != "" {
			outgoing[i].User.AvatarURL = s.avatarURL(outgoing[i].User.AvatarURL)
		}
	}
	return incoming, outgoing, nil
}

// FriendshipStatus reports viewerID's relationship to otherID, satisfying
// identity.FriendshipStatusProvider structurally (kora#453) -- identity
// declares that interface rather than taking a *social.Service directly
// because internal/social already imports internal/identity, and the
// reverse import would cycle. See FriendshipStatusProvider's doc comment in
// internal/identity/friendship.go for the full reasoning.
//
// Self is identity's job, not this method's: identity.Service.Lookup checks
// viewerID == otherID BEFORE ever calling this, so a self-lookup never
// reaches here. This method only ever sees two DISTINCT users, which is why
// it can answer purely from FindByPair's Status and RequesterID with no
// extra self-case of its own.
func (s Service) FriendshipStatus(ctx context.Context, viewerID, otherID uuid.UUID) (identity.FriendshipStatus, error) {
	f, err := s.repo.FindByPair(ctx, viewerID, otherID)
	if err != nil {
		return identity.FriendshipNone, err
	}
	if f == nil {
		return identity.FriendshipNone, nil
	}
	switch f.Status {
	case FriendStatusAccepted:
		return identity.FriendshipFriends, nil
	case FriendStatusPending:
		if f.RequesterID == viewerID {
			return identity.FriendshipRequestSent, nil
		}
		return identity.FriendshipRequestReceived, nil
	default:
		return identity.FriendshipNone, nil
	}
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
