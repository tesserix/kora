package user

import (
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Transfer records one ownership handover, so the caller can report exactly
// what deleting this user did to other people's groups. Deletion is
// irreversible and silently reassigning someone else's group is a surprise
// worth surfacing before and after the fact.
type Transfer struct {
	Kind       string    `json:"kind"` // "group" | "challenge"
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	NewOwnerID uuid.UUID `json:"new_owner_id"`
}

// transferOwnership reassigns every group owned by userID that still has
// another member, to the member with the earliest joined_at.
//
// MUST run before the DELETE: once the cascade fires, groups.owner_id ->
// users(id) ON DELETE CASCADE has already removed the rows.
//
// A group where the departing user is the ONLY member is deliberately left
// alone so the cascade removes it -- transferring it is impossible and
// keeping an ownerless group is worse.
//
// Ties on joined_at break on the member's user id, so the outcome is
// deterministic; two members inserted in the same transaction can share a
// timestamp, and a non-deterministic owner would make this untestable.
//
// Scope note: challenges.creator_id also references users, but reassigning
// challenge ownership is out of scope for this task -- deliberately not
// handled here.
func transferOwnership(tx *gorm.DB, userID uuid.UUID) ([]Transfer, error) {
	var out []Transfer

	rows, err := tx.Raw(`
		SELECT g.id, g.name, m.user_id
		FROM groups g
		JOIN LATERAL (
			SELECT user_id FROM group_members
			WHERE group_id = g.id AND user_id <> ?
			ORDER BY joined_at ASC, user_id ASC
			LIMIT 1
		) m ON TRUE
		WHERE g.owner_id = ?`, userID, userID).Rows()
	if err != nil {
		return nil, fmt.Errorf("user: find transferable groups: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var t Transfer
		if err := rows.Scan(&t.ID, &t.Name, &t.NewOwnerID); err != nil {
			return nil, fmt.Errorf("user: scan group transfer: %w", err)
		}
		t.Kind = "group"
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("user: iterate group transfers: %w", err)
	}

	for _, t := range out {
		if err := tx.Exec(`UPDATE groups SET owner_id = ? WHERE id = ?`,
			t.NewOwnerID, t.ID).Error; err != nil {
			return nil, fmt.Errorf("user: transfer group %s: %w", t.ID, err)
		}
	}
	return out, nil
}
