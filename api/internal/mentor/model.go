package mentor

import (
	"time"

	"github.com/google/uuid"
)

const (
	CoachingStyleSupportive     = "supportive"
	CoachingStyleDirect         = "direct"
	CoachingStyleEducational    = "educational"
	CoachingStyleAccountability = "accountability"

	ReminderIntensityLight    = "light"
	ReminderIntensityBalanced = "balanced"
	ReminderIntensityFrequent = "frequent"

	HealthSourceHealthKit = "healthkit"

	CommitmentKindHydration = "hydration"
	CommitmentKindWalking   = "walking"
	CommitmentKindMeal      = "meal"
	CommitmentKindCustom    = "custom"

	CadenceFixed    = "fixed"
	CadenceInterval = "interval"

	CommitmentStatusActive   = "active"
	CommitmentStatusPaused   = "paused"
	CommitmentStatusArchived = "archived"

	CommitmentSourceUser         = "user"
	CommitmentSourceCoach        = "coach"
	CommitmentSourceNutritionist = "nutritionist"
	CommitmentSourceMealPlanner  = "meal_planner"

	CheckInActionDone    = "done"
	CheckInActionSkipped = "skipped"
	CheckInActionSnoozed = "snoozed"
)

type Profile struct {
	UserID                uuid.UUID  `gorm:"type:uuid;primaryKey" json:"-"`
	Motivation            string     `json:"motivation"`
	DietaryPreferences    string     `json:"dietary_preferences"`
	Allergies             string     `json:"allergies"`
	DietPattern           string     `json:"diet_pattern"`
	CoachingStyle         string     `json:"coaching_style"`
	ReminderIntensity     string     `json:"reminder_intensity"`
	QuietStartMinute      int        `json:"quiet_start_minute"`
	QuietEndMinute        int        `json:"quiet_end_minute"`
	HealthStepsEnabled    bool       `json:"health_steps_enabled"`
	HealthSleepEnabled    bool       `json:"health_sleep_enabled"`
	HealthWorkoutsEnabled bool       `json:"health_workouts_enabled"`
	ConfirmedAt           *time.Time `json:"confirmed_at"`
	CreatedAt             time.Time  `json:"created_at"`
	UpdatedAt             time.Time  `json:"updated_at"`
}

func (Profile) TableName() string { return "mentor_profiles" }

type HealthDay struct {
	UserID         uuid.UUID `gorm:"type:uuid;primaryKey" json:"-"`
	LocalDate      time.Time `gorm:"type:date;primaryKey" json:"local_date"`
	Timezone       string    `json:"timezone"`
	Steps          *int      `json:"steps"`
	SleepMinutes   *int      `json:"sleep_minutes"`
	WorkoutMinutes *int      `json:"workout_minutes"`
	Source         string    `json:"source"`
	ObservedAt     time.Time `json:"observed_at"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

func (HealthDay) TableName() string { return "health_daily_summaries" }

type Commitment struct {
	ID              uuid.UUID  `gorm:"type:uuid;primaryKey" json:"id"`
	UserID          uuid.UUID  `gorm:"type:uuid;not null;index" json:"-"`
	Title           string     `json:"title"`
	Kind            string     `json:"kind"`
	Cadence         string     `json:"cadence"`
	WeekdaysMask    int        `json:"weekdays_mask"`
	StartMinute     int        `json:"start_minute"`
	IntervalMinutes *int       `json:"interval_minutes"`
	EndMinute       *int       `json:"end_minute"`
	Timezone        string     `json:"timezone"`
	StartsOn        time.Time  `gorm:"type:date" json:"starts_on"`
	EndsOn          *time.Time `gorm:"type:date" json:"ends_on"`
	Status          string     `json:"status"`
	Source          string     `json:"source"`
	AgentName       *string    `json:"agent_name"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

func (Commitment) TableName() string { return "mentor_commitments" }

type CommitmentProposal struct {
	ID                   uuid.UUID  `gorm:"type:uuid;primaryKey" json:"id"`
	UserID               uuid.UUID  `gorm:"type:uuid;not null;index" json:"-"`
	CoachTurnID          uuid.UUID  `gorm:"type:uuid;not null;uniqueIndex" json:"-"`
	Title                string     `json:"title"`
	Kind                 string     `json:"kind"`
	Cadence              string     `json:"cadence"`
	WeekdaysMask         int        `json:"weekdays_mask"`
	StartMinute          int        `json:"start_minute"`
	IntervalMinutes      *int       `json:"interval_minutes"`
	EndMinute            *int       `json:"end_minute"`
	Timezone             string     `json:"timezone"`
	StartsOn             time.Time  `gorm:"type:date" json:"starts_on"`
	EndsOn               *time.Time `gorm:"type:date" json:"ends_on"`
	Source               string     `json:"source"`
	AgentName            string     `json:"agent_name"`
	ReviewedBy           string     `json:"reviewed_by"`
	AcceptedCommitmentID *uuid.UUID `gorm:"type:uuid" json:"accepted_commitment_id"`
	AcceptedAt           *time.Time `json:"accepted_at"`
	CreatedAt            time.Time  `json:"created_at"`
}

func (CommitmentProposal) TableName() string { return "mentor_commitment_proposals" }

type CheckIn struct {
	ID           uuid.UUID  `gorm:"type:uuid;primaryKey" json:"id"`
	UserID       uuid.UUID  `gorm:"type:uuid;not null;index" json:"-"`
	CommitmentID uuid.UUID  `gorm:"type:uuid;not null;index" json:"commitment_id"`
	ScheduledFor time.Time  `json:"scheduled_for"`
	LocalDate    time.Time  `gorm:"type:date" json:"local_date"`
	Action       string     `json:"action"`
	SnoozedUntil *time.Time `json:"snoozed_until"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

func (CheckIn) TableName() string { return "mentor_check_ins" }

// FoodRule is one structured dietary constraint. It is the enforceable form of
// what the profile's free-text fields describe, and only a rule with
// ConfirmedAt set is in force.
type FoodRule struct {
	ID          uuid.UUID  `gorm:"type:uuid;primaryKey" json:"id"`
	UserID      uuid.UUID  `gorm:"type:uuid;not null;index" json:"-"`
	Subject     string     `json:"subject"`
	Kind        string     `json:"kind"`
	Severity    string     `json:"severity"`
	Label       string     `json:"label"`
	Source      string     `json:"source"`
	ConfirmedAt *time.Time `json:"confirmed_at"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

func (FoodRule) TableName() string { return "mentor_food_rules" }
