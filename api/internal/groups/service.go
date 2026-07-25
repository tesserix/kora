package groups

import (
	"context"

	"github.com/google/uuid"
)

type friendChecker interface {
	AreFriends(ctx context.Context, a, b uuid.UUID) (bool, error)
}

type Service struct {
	repo    Repository
	friends friendChecker
	newCode func() (string, error)
}

func NewService(repo Repository, friends friendChecker, newCode func() (string, error)) Service {
	return Service{repo: repo, friends: friends, newCode: newCode}
}

type GroupDetail struct {
	ID         uuid.UUID    `json:"id"`
	Name       string       `json:"name"`
	InviteCode string       `json:"invite_code"`
	MyRole     Role         `json:"my_role"`
	Members    []MemberView `json:"members"`
}

func (s Service) Create(ctx context.Context, ownerID uuid.UUID, name string) (Group, error) {
	if name == "" {
		return Group{}, ErrBadInput
	}
	code, err := s.newCode()
	if err != nil {
		return Group{}, err
	}
	return s.repo.CreateGroup(ctx, ownerID, name, code)
}

func (s Service) JoinByCode(ctx context.Context, userID uuid.UUID, code string) (Group, error) {
	g, err := s.repo.FindByInviteCode(ctx, code)
	if err != nil {
		return Group{}, err
	}
	if g == nil {
		return Group{}, ErrNotFound
	}
	if err := s.repo.AddMember(ctx, g.ID, userID, RoleMember); err != nil {
		return Group{}, err
	}
	return *g, nil
}

func (s Service) InviteFriend(ctx context.Context, ownerID, groupID, friendID uuid.UUID) error {
	if err := s.requireOwner(ctx, ownerID, groupID); err != nil {
		return err
	}
	ok, err := s.friends.AreFriends(ctx, ownerID, friendID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFriends
	}
	return s.repo.AddMember(ctx, groupID, friendID, RoleMember)
}

func (s Service) Leave(ctx context.Context, userID, groupID uuid.UUID) error {
	role, ok, err := s.repo.RoleOf(ctx, groupID, userID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	if role == RoleOwner {
		return ErrOwnerCannotLeave
	}
	return s.repo.RemoveMember(ctx, groupID, userID)
}

func (s Service) RemoveMember(ctx context.Context, ownerID, groupID, memberID uuid.UUID) error {
	if err := s.requireOwner(ctx, ownerID, groupID); err != nil {
		return err
	}
	if memberID == ownerID {
		return ErrForbidden // owner can't remove themselves; delete instead
	}
	return s.repo.RemoveMember(ctx, groupID, memberID)
}

func (s Service) Rename(ctx context.Context, ownerID, groupID uuid.UUID, name string) error {
	if name == "" {
		return ErrBadInput
	}
	if err := s.requireOwner(ctx, ownerID, groupID); err != nil {
		return err
	}
	return s.repo.Rename(ctx, groupID, name)
}

func (s Service) Delete(ctx context.Context, ownerID, groupID uuid.UUID) error {
	if err := s.requireOwner(ctx, ownerID, groupID); err != nil {
		return err
	}
	return s.repo.DeleteGroup(ctx, groupID)
}

func (s Service) ListGroups(ctx context.Context, userID uuid.UUID) ([]GroupSummary, error) {
	return s.repo.ListForUser(ctx, userID)
}

func (s Service) Detail(ctx context.Context, userID, groupID uuid.UUID) (GroupDetail, error) {
	role, ok, err := s.repo.RoleOf(ctx, groupID, userID)
	if err != nil {
		return GroupDetail{}, err
	}
	if !ok {
		return GroupDetail{}, ErrForbidden
	}
	g, err := s.repo.FindByID(ctx, groupID)
	if err != nil {
		return GroupDetail{}, err
	}
	if g == nil {
		return GroupDetail{}, ErrNotFound
	}
	members, err := s.repo.ListMembers(ctx, groupID)
	if err != nil {
		return GroupDetail{}, err
	}
	return GroupDetail{ID: g.ID, Name: g.Name, InviteCode: g.InviteCode, MyRole: role, Members: members}, nil
}

func (s Service) requireOwner(ctx context.Context, userID, groupID uuid.UUID) error {
	role, ok, err := s.repo.RoleOf(ctx, groupID, userID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrForbidden
	}
	if role != RoleOwner {
		return ErrForbidden
	}
	return nil
}
