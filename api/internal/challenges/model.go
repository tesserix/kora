// Package challenges owns time-boxed group challenges and their participants.
package challenges

import (
	"time"

	"github.com/google/uuid"
)

type Metric string

const (
	MetricOnTarget Metric = "on_target"
	MetricLogged   Metric = "logged"
)

func ValidMetric(m string) bool {
	return m == string(MetricOnTarget) || m == string(MetricLogged)
}

const (
	StatusUpcoming = "upcoming"
	StatusActive   = "active"
	StatusEnded    = "ended"
)

// durationDays maps a preset to the number of days added to today for end_date.
var durationDays = map[string]int{"1w": 7, "2w": 14, "1mo": 30}

type Challenge struct {
	ID        uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	GroupID   uuid.UUID `json:"group_id"`
	CreatorID uuid.UUID `json:"creator_id"`
	Title     string    `json:"title"`
	Metric    Metric    `json:"metric"`
	StartDate time.Time `json:"start_date"`
	EndDate   time.Time `json:"end_date"`
	CreatedAt time.Time `gorm:"autoCreateTime" json:"created_at"`
}

type ChallengeParticipant struct {
	ChallengeID uuid.UUID `gorm:"primaryKey" json:"challenge_id"`
	UserID      uuid.UUID `gorm:"primaryKey" json:"user_id"`
	JoinedAt    time.Time `gorm:"autoCreateTime" json:"joined_at"`
}

// ChallengeSummary is a list row within a group. Status is filled by the service
// (computed from dates), not by SQL.
type ChallengeSummary struct {
	ID               uuid.UUID `json:"id"`
	Title            string    `json:"title"`
	Metric           Metric    `json:"metric"`
	Status           string    `json:"status"`
	StartDate        time.Time `json:"start_date"`
	EndDate          time.Time `json:"end_date"`
	ParticipantCount int       `json:"participant_count"`
	Joined           bool      `json:"joined"`
}

// ScoringRow is one participant's minimal input to WindowScore.
type ScoringRow struct {
	ID          uuid.UUID
	DisplayName string
	TargetKcal  float64
}

type Standing struct {
	UserID      uuid.UUID `json:"user_id"`
	DisplayName string    `json:"display_name"`
	Score       int       `json:"score"`
}

type ChallengeDetail struct {
	ID        uuid.UUID  `json:"id"`
	GroupID   uuid.UUID  `json:"group_id"`
	Title     string     `json:"title"`
	Metric    Metric     `json:"metric"`
	Status    string     `json:"status"`
	StartDate time.Time  `json:"start_date"`
	EndDate   time.Time  `json:"end_date"`
	Joined    bool       `json:"joined"`
	CanDelete bool       `json:"can_delete"`
	Standings []Standing `json:"standings"`
	Winner    *Standing  `json:"winner,omitempty"`
}

// Status is computed from the calendar window vs the viewer's local "today".
// ISO date strings compare correctly lexicographically.
func Status(start, end, now time.Time, loc *time.Location) string {
	today := now.In(loc).Format("2006-01-02")
	s := start.Format("2006-01-02")
	e := end.Format("2006-01-02")
	switch {
	case today < s:
		return StatusUpcoming
	case today > e:
		return StatusEnded
	default:
		return StatusActive
	}
}
