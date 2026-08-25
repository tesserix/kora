// Package user owns the user profile domain.
package user

import (
	"time"

	"github.com/google/uuid"
)

// DefaultTimezone is the timezone assigned to newly-provisioned users when
// none is supplied yet, mirroring the migration's SQL DEFAULT for the
// timezone column. It must be set explicitly in Go (see repository.go) since
// GORM's Create inserts the zero value for unset fields, overriding any SQL
// DEFAULT.
const DefaultTimezone = "Australia/Sydney"

type User struct {
	ID          uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	FirebaseUID string    `gorm:"uniqueIndex" json:"-"`
	Email       string    `json:"email"`
	DisplayName string    `json:"display_name"`
	FriendCode  string    `json:"-"`

	// AppleRefreshToken is a credential and must never be serialised to a
	// client; the json:"-" tag is load-bearing.
	//
	// The column is nullable, but rows created via
	// Repository.UpsertByFirebaseUID (every new user) get '' (empty string),
	// not SQL NULL -- GORM's Create writes the Go zero value for an untouched
	// string field. A presence check MUST be `!= ""`; `IS NULL` matches
	// nothing.
	AppleRefreshToken string `gorm:"column:apple_refresh_token" json:"-"`

	// Handle is what the user typed (trimmed and lowercased); HandleCanonical
	// is that with confusables folded, and is what the unique index and every
	// lookup use. Both are nullable in SQL and '' in Go for a user who has no
	// handle -- a presence check MUST be `!= ""`, the same trap AppleRefreshToken
	// documents above.
	//
	// json:"-" on both: they reach clients only through identity.LookupView and
	// social.FriendView, which are projections chosen field by field. Serialising
	// the model directly is how an email leaks.
	Handle          string `gorm:"column:handle" json:"-"`
	HandleCanonical string `gorm:"column:handle_canonical" json:"-"`

	// AvatarPath is an object path, never a URL. See the column comment in
	// migration 000056.
	AvatarPath string `gorm:"column:avatar_path" json:"-"`

	Sex            string     `json:"sex"`
	BirthYear      int        `json:"birth_year"`
	HeightCm       float64    `json:"height_cm"`
	WeightKg       float64    `json:"weight_kg"`
	ActivityLevel  string     `json:"activity_level"`
	Goal           string     `json:"goal"`
	Timezone       string     `json:"timezone"`
	TargetKcal     float64    `json:"target_kcal"`
	TargetProteinG float64    `json:"target_protein_g"`
	TargetCarbsG   float64    `json:"target_carbs_g"`
	TargetFatG     float64    `json:"target_fat_g"`
	OnboardedAt    *time.Time `json:"onboarded_at"`

	// Destination. Nil/zero means none was set — which is what a
	// maintenance user stores, not an error state.
	GoalWeightKg  float64    `json:"goal_weight_kg"`
	PaceKgPerWeek float64    `json:"pace_kg_per_week"`
	TargetDate    *time.Time `json:"target_date"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}
