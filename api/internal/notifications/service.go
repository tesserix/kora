package notifications

import (
	"context"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/groups"
)

const listLimit = 50

// store is the persistence surface the service needs (Repository satisfies it).
type store interface {
	Create(ctx context.Context, n Notification) error
	ListForUser(ctx context.Context, userID uuid.UUID, limit int) ([]NotificationView, error)
	UnreadCount(ctx context.Context, userID uuid.UUID) (int, error)
	MarkAllRead(ctx context.Context, userID uuid.UUID) (int, error)
}

// memberLister lets the challenge fan-out enumerate a group's members
// (groups.Repository satisfies it).
type memberLister interface {
	ListMembers(ctx context.Context, groupID uuid.UUID) ([]groups.MemberView, error)
}

type Service struct {
	store   store
	members memberLister
}

func NewService(s store, members memberLister) Service {
	return Service{store: s, members: members}
}

func (s Service) FriendRequested(ctx context.Context, recipientID, actorID uuid.UUID) error {
	return s.store.Create(ctx, Notification{UserID: recipientID, ActorID: actorID, Type: TypeFriendRequest})
}

func (s Service) FriendAccepted(ctx context.Context, recipientID, actorID uuid.UUID) error {
	return s.store.Create(ctx, Notification{UserID: recipientID, ActorID: actorID, Type: TypeFriendAccept})
}

func (s Service) AddedToGroup(ctx context.Context, recipientID, actorID, groupID uuid.UUID) error {
	gid := groupID
	return s.store.Create(ctx, Notification{UserID: recipientID, ActorID: actorID, Type: TypeGroupInvite, EntityID: &gid})
}

func (s Service) ChallengeCreated(ctx context.Context, groupID, actorID, challengeID uuid.UUID) error {
	members, err := s.members.ListMembers(ctx, groupID)
	if err != nil {
		return err
	}
	cid := challengeID
	var firstErr error
	for _, m := range members {
		if m.ID == actorID {
			continue
		}
		if err := s.store.Create(ctx, Notification{UserID: m.ID, ActorID: actorID, Type: TypeChallengeCreated, EntityID: &cid}); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (s Service) ChallengeStarted(ctx context.Context, challengeID uuid.UUID, participantIDs []uuid.UUID, creatorID uuid.UUID) error {
	cid := challengeID
	var firstErr error
	for _, uid := range participantIDs {
		if err := s.store.Create(ctx, Notification{UserID: uid, ActorID: creatorID, Type: TypeChallengeStarted, EntityID: &cid}); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (s Service) ChallengeEnded(ctx context.Context, challengeID uuid.UUID, participantIDs []uuid.UUID, winnerID uuid.UUID) error {
	cid := challengeID
	var firstErr error
	for _, uid := range participantIDs {
		if err := s.store.Create(ctx, Notification{UserID: uid, ActorID: winnerID, Type: TypeChallengeEnded, EntityID: &cid}); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (s Service) ChallengePassed(ctx context.Context, challengeID, passedUserID, aheadUserID uuid.UUID) error {
	cid := challengeID
	return s.store.Create(ctx, Notification{UserID: passedUserID, ActorID: aheadUserID, Type: TypeChallengePassed, EntityID: &cid})
}

func (s Service) List(ctx context.Context, userID uuid.UUID) ([]NotificationView, error) {
	return s.store.ListForUser(ctx, userID, listLimit)
}

func (s Service) UnreadCount(ctx context.Context, userID uuid.UUID) (int, error) {
	return s.store.UnreadCount(ctx, userID)
}

func (s Service) MarkAllRead(ctx context.Context, userID uuid.UUID) (int, error) {
	return s.store.MarkAllRead(ctx, userID)
}
