package push

import (
	"github.com/tesserix/kora/api/internal/notifications"
)

const pushTitle = "Kora"

// body mirrors the in-app message() copy in app/notifications.tsx verbatim.
func body(nType, actor string) string {
	switch nType {
	case notifications.TypeFriendRequest:
		return actor + " sent you a friend request"
	case notifications.TypeFriendAccept:
		return actor + " accepted your friend request"
	case notifications.TypeGroupInvite:
		return actor + " added you to a group"
	case notifications.TypeChallengeCreated:
		return actor + " started a challenge"
	case notifications.TypeChallengeStarted:
		return "A challenge you joined has started"
	case notifications.TypeChallengeEnded:
		return actor + " won a challenge"
	case notifications.TypeChallengePassed:
		return actor + " passed you in a challenge"
	default:
		return actor
	}
}

// dataFor carries the deep-link payload the mobile responder reads.
func dataFor(p notifications.PendingPush) map[string]any {
	d := map[string]any{"type": p.Type}
	if p.EntityID != nil {
		d["entity_id"] = p.EntityID.String()
	}
	return d
}
