package mentor

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
)

const dateLayout = "2006-01-02"

type Service struct {
	repo Repository
	now  func() time.Time
}

func NewService(repo Repository) Service {
	return Service{repo: repo, now: time.Now}
}

type ProfileInput struct {
	Motivation            string `json:"motivation"`
	DietaryPreferences    string `json:"dietary_preferences"`
	Allergies             string `json:"allergies"`
	CoachingStyle         string `json:"coaching_style"`
	ReminderIntensity     string `json:"reminder_intensity"`
	QuietStartMinute      int    `json:"quiet_start_minute"`
	QuietEndMinute        int    `json:"quiet_end_minute"`
	HealthStepsEnabled    bool   `json:"health_steps_enabled"`
	HealthSleepEnabled    bool   `json:"health_sleep_enabled"`
	HealthWorkoutsEnabled bool   `json:"health_workouts_enabled"`
}

func (s Service) Profile(ctx context.Context, userID uuid.UUID) (Profile, error) {
	profile, found, err := s.repo.ProfileForUser(ctx, userID)
	if err != nil {
		return Profile{}, err
	}
	if found {
		return profile, nil
	}
	return Profile{
		UserID:            userID,
		CoachingStyle:     CoachingStyleSupportive,
		ReminderIntensity: ReminderIntensityBalanced,
		QuietStartMinute:  22 * 60,
		QuietEndMinute:    7 * 60,
	}, nil
}

func (s Service) PutProfile(
	ctx context.Context,
	userID uuid.UUID,
	input ProfileInput,
) (Profile, error) {
	input.Motivation = strings.TrimSpace(input.Motivation)
	input.DietaryPreferences = strings.TrimSpace(input.DietaryPreferences)
	input.Allergies = strings.TrimSpace(input.Allergies)
	if utf8.RuneCountInString(input.Motivation) > 500 {
		return Profile{}, validation("motivation must be 500 characters or fewer")
	}
	if utf8.RuneCountInString(input.DietaryPreferences) > 500 {
		return Profile{}, validation("dietary preferences must be 500 characters or fewer")
	}
	if utf8.RuneCountInString(input.Allergies) > 500 {
		return Profile{}, validation("allergies must be 500 characters or fewer")
	}
	if !oneOf(input.CoachingStyle,
		CoachingStyleSupportive, CoachingStyleDirect,
		CoachingStyleEducational, CoachingStyleAccountability) {
		return Profile{}, validation("choose a valid coaching style")
	}
	if !oneOf(input.ReminderIntensity,
		ReminderIntensityLight, ReminderIntensityBalanced, ReminderIntensityFrequent) {
		return Profile{}, validation("choose a valid reminder intensity")
	}
	if !minuteOfDay(input.QuietStartMinute) || !minuteOfDay(input.QuietEndMinute) {
		return Profile{}, validation("quiet hours must be valid times")
	}
	now := s.now().UTC()
	profile := Profile{
		UserID:                userID,
		Motivation:            input.Motivation,
		DietaryPreferences:    input.DietaryPreferences,
		Allergies:             input.Allergies,
		CoachingStyle:         input.CoachingStyle,
		ReminderIntensity:     input.ReminderIntensity,
		QuietStartMinute:      input.QuietStartMinute,
		QuietEndMinute:        input.QuietEndMinute,
		HealthStepsEnabled:    input.HealthStepsEnabled,
		HealthSleepEnabled:    input.HealthSleepEnabled,
		HealthWorkoutsEnabled: input.HealthWorkoutsEnabled,
		ConfirmedAt:           &now,
	}
	if err := s.repo.UpsertProfile(ctx, profile); err != nil {
		return Profile{}, err
	}
	return s.Profile(ctx, userID)
}

type HealthDayInput struct {
	LocalDate      string    `json:"local_date"`
	Timezone       string    `json:"timezone"`
	Steps          *int      `json:"steps"`
	SleepMinutes   *int      `json:"sleep_minutes"`
	WorkoutMinutes *int      `json:"workout_minutes"`
	ObservedAt     time.Time `json:"observed_at"`
}

type HealthDaysInput struct {
	Days []HealthDayInput `json:"days"`
}

func (s Service) PutHealthDays(
	ctx context.Context,
	userID uuid.UUID,
	input HealthDaysInput,
) (int, error) {
	if len(input.Days) == 0 || len(input.Days) > 31 {
		return 0, validation("health sync must contain between 1 and 31 days")
	}
	days := make([]HealthDay, len(input.Days))
	seen := make(map[string]struct{}, len(input.Days))
	for i, item := range input.Days {
		if _, duplicate := seen[item.LocalDate]; duplicate {
			return 0, validation("health sync contains a duplicate local date")
		}
		seen[item.LocalDate] = struct{}{}
		day, err := time.Parse(dateLayout, item.LocalDate)
		if err != nil {
			return 0, validation("health local date must be YYYY-MM-DD")
		}
		zone := strings.TrimSpace(item.Timezone)
		if zone == "" || len(zone) > 64 {
			return 0, validation("health timezone is required")
		}
		if _, err := time.LoadLocation(zone); err != nil {
			return 0, validation("health timezone is invalid")
		}
		if item.ObservedAt.IsZero() {
			return 0, validation("health observed_at is required")
		}
		if item.Steps == nil && item.SleepMinutes == nil && item.WorkoutMinutes == nil {
			return 0, validation("health day must contain at least one measured value")
		}
		if item.Steps != nil && *item.Steps < 0 {
			return 0, validation("health steps cannot be negative")
		}
		if !optionalRange(item.SleepMinutes, 0, 1440) {
			return 0, validation("health sleep minutes must be between 0 and 1440")
		}
		if !optionalRange(item.WorkoutMinutes, 0, 1440) {
			return 0, validation("health workout minutes must be between 0 and 1440")
		}
		days[i] = HealthDay{
			UserID: userID, LocalDate: day, Timezone: zone, Steps: item.Steps,
			SleepMinutes: item.SleepMinutes, WorkoutMinutes: item.WorkoutMinutes,
			Source: HealthSourceHealthKit, ObservedAt: item.ObservedAt.UTC(),
		}
	}
	if err := s.repo.UpsertHealthDays(ctx, userID, days); err != nil {
		return 0, err
	}
	return len(days), nil
}

func (s Service) HealthDays(
	ctx context.Context,
	userID uuid.UUID,
	from string,
) ([]HealthDay, error) {
	var start time.Time
	var err error
	if strings.TrimSpace(from) == "" {
		start = s.now().UTC().AddDate(0, 0, -30)
	} else {
		start, err = time.Parse(dateLayout, from)
		if err != nil {
			return nil, validation("from must be YYYY-MM-DD")
		}
	}
	return s.repo.HealthDaysSince(ctx, userID, start, 31)
}

func (s Service) DeleteHealthDays(ctx context.Context, userID uuid.UUID) error {
	return s.repo.DeleteHealthDays(ctx, userID)
}

type CommitmentInput struct {
	Title           string  `json:"title"`
	Kind            string  `json:"kind"`
	Cadence         string  `json:"cadence"`
	WeekdaysMask    int     `json:"weekdays_mask"`
	StartMinute     int     `json:"start_minute"`
	IntervalMinutes *int    `json:"interval_minutes"`
	EndMinute       *int    `json:"end_minute"`
	Timezone        string  `json:"timezone"`
	StartsOn        string  `json:"starts_on"`
	EndsOn          *string `json:"ends_on"`
	Status          string  `json:"status"`
}

type CommitmentProposalDraft struct {
	Title           string `json:"title"`
	Kind            string `json:"kind"`
	Cadence         string `json:"cadence"`
	WeekdaysMask    int    `json:"weekdays_mask"`
	StartMinute     int    `json:"start_minute"`
	IntervalMinutes *int   `json:"interval_minutes"`
	EndMinute       *int   `json:"end_minute"`
}

func (s Service) PutCommitment(
	ctx context.Context,
	userID, commitmentID uuid.UUID,
	input CommitmentInput,
) (Commitment, error) {
	commitment, err := validateCommitment(userID, commitmentID, input, CommitmentSourceUser, nil)
	if err != nil {
		return Commitment{}, err
	}
	return s.repo.PutCommitment(ctx, commitment)
}

func validateCommitment(
	userID, commitmentID uuid.UUID,
	input CommitmentInput,
	source string,
	agentName *string,
) (Commitment, error) {
	if commitmentID == uuid.Nil {
		return Commitment{}, validation("commitment id is invalid")
	}
	input.Title = strings.TrimSpace(input.Title)
	if n := utf8.RuneCountInString(input.Title); n == 0 || n > 120 {
		return Commitment{}, validation("commitment title must be between 1 and 120 characters")
	}
	if !oneOf(input.Kind,
		CommitmentKindHydration, CommitmentKindWalking,
		CommitmentKindMeal, CommitmentKindCustom) {
		return Commitment{}, validation("commitment kind is invalid")
	}
	if !oneOf(input.Cadence, CadenceFixed, CadenceInterval) {
		return Commitment{}, validation("commitment cadence is invalid")
	}
	if input.WeekdaysMask < 1 || input.WeekdaysMask > 127 {
		return Commitment{}, validation("commitment weekdays are invalid")
	}
	if !minuteOfDay(input.StartMinute) {
		return Commitment{}, validation("commitment start time is invalid")
	}
	if input.Cadence == CadenceFixed && (input.IntervalMinutes != nil || input.EndMinute != nil) {
		return Commitment{}, validation("a fixed commitment has one time")
	}
	if input.Cadence == CadenceInterval {
		if input.IntervalMinutes == nil || *input.IntervalMinutes < 30 || *input.IntervalMinutes > 720 {
			return Commitment{}, validation("commitment interval must be between 30 and 720 minutes")
		}
		if input.EndMinute == nil || !minuteOfDay(*input.EndMinute) || *input.EndMinute <= input.StartMinute {
			return Commitment{}, validation("commitment interval requires an end after its start")
		}
	}
	zone := strings.TrimSpace(input.Timezone)
	if _, err := time.LoadLocation(zone); err != nil {
		return Commitment{}, validation("commitment timezone is invalid")
	}
	startsOn, err := time.Parse(dateLayout, input.StartsOn)
	if err != nil {
		return Commitment{}, validation("commitment start date must be YYYY-MM-DD")
	}
	var endsOn *time.Time
	if input.EndsOn != nil {
		parsed, err := time.Parse(dateLayout, *input.EndsOn)
		if err != nil {
			return Commitment{}, validation("commitment end date must be YYYY-MM-DD")
		}
		if parsed.Before(startsOn) {
			return Commitment{}, validation("commitment end date cannot precede its start")
		}
		endsOn = &parsed
	}
	if !oneOf(input.Status,
		CommitmentStatusActive, CommitmentStatusPaused, CommitmentStatusArchived) {
		return Commitment{}, validation("commitment status is invalid")
	}
	return Commitment{
		ID: commitmentID, UserID: userID, Title: input.Title, Kind: input.Kind,
		Cadence: input.Cadence, WeekdaysMask: input.WeekdaysMask,
		StartMinute: input.StartMinute, IntervalMinutes: input.IntervalMinutes,
		EndMinute: input.EndMinute, Timezone: zone, StartsOn: startsOn, EndsOn: endsOn,
		Status: input.Status, Source: source, AgentName: agentName,
	}, nil
}

func NewCommitmentProposal(
	userID uuid.UUID,
	now time.Time,
	loc *time.Location,
	draft CommitmentProposalDraft,
	agentName, reviewedBy string,
) (*CommitmentProposal, error) {
	if loc == nil {
		loc = time.UTC
	}
	agentName = strings.TrimSpace(agentName)
	reviewedBy = strings.TrimSpace(reviewedBy)
	if agentName == "" || reviewedBy == "" || utf8.RuneCountInString(agentName) > 120 || utf8.RuneCountInString(reviewedBy) > 120 {
		return nil, validation("commitment proposal attribution is invalid")
	}
	commitment, err := validateCommitment(userID, uuid.New(), CommitmentInput{
		Title: draft.Title, Kind: draft.Kind, Cadence: draft.Cadence,
		WeekdaysMask: draft.WeekdaysMask, StartMinute: draft.StartMinute,
		IntervalMinutes: draft.IntervalMinutes, EndMinute: draft.EndMinute,
		Timezone: loc.String(), StartsOn: now.In(loc).Format(dateLayout),
		Status: CommitmentStatusActive,
	}, CommitmentSourceMealPlanner, &agentName)
	if err != nil {
		return nil, err
	}
	return &CommitmentProposal{
		ID: commitment.ID, UserID: userID, Title: commitment.Title,
		Kind: commitment.Kind, Cadence: commitment.Cadence,
		WeekdaysMask: commitment.WeekdaysMask, StartMinute: commitment.StartMinute,
		IntervalMinutes: commitment.IntervalMinutes, EndMinute: commitment.EndMinute,
		Timezone: commitment.Timezone, StartsOn: commitment.StartsOn,
		EndsOn: commitment.EndsOn, Source: commitment.Source,
		AgentName: agentName, ReviewedBy: reviewedBy,
	}, nil
}

func (s Service) Commitments(ctx context.Context, userID uuid.UUID) ([]Commitment, error) {
	return s.repo.ListCommitments(ctx, userID, 100)
}

type ProposalAcceptanceInput struct {
	CommitmentID uuid.UUID `json:"commitment_id"`
	CommitmentInput
}

func (s Service) AcceptProposal(
	ctx context.Context,
	userID, proposalID uuid.UUID,
	input ProposalAcceptanceInput,
) (Commitment, error) {
	if proposalID == uuid.Nil {
		return Commitment{}, validation("proposal id is invalid")
	}
	proposal, err := s.repo.ProposalForUser(ctx, userID, proposalID)
	if err != nil {
		return Commitment{}, err
	}
	input.Status = CommitmentStatusActive
	agentName := proposal.AgentName
	commitment, err := validateCommitment(
		userID, input.CommitmentID, input.CommitmentInput,
		proposal.Source, &agentName,
	)
	if err != nil {
		return Commitment{}, err
	}
	return s.repo.AcceptProposal(ctx, userID, proposalID, commitment)
}

type CheckInInput struct {
	ScheduledFor time.Time  `json:"scheduled_for"`
	LocalDate    string     `json:"local_date"`
	Action       string     `json:"action"`
	SnoozedUntil *time.Time `json:"snoozed_until"`
}

func (s Service) PutCheckIn(
	ctx context.Context,
	userID, commitmentID uuid.UUID,
	input CheckInInput,
) (CheckIn, error) {
	if input.ScheduledFor.IsZero() {
		return CheckIn{}, validation("check-in scheduled time is required")
	}
	localDate, err := time.Parse(dateLayout, input.LocalDate)
	if err != nil {
		return CheckIn{}, validation("check-in local date must be YYYY-MM-DD")
	}
	if !oneOf(input.Action, CheckInActionDone, CheckInActionSkipped, CheckInActionSnoozed) {
		return CheckIn{}, validation("check-in action is invalid")
	}
	if input.Action == CheckInActionSnoozed {
		if input.SnoozedUntil == nil || !input.SnoozedUntil.After(input.ScheduledFor) {
			return CheckIn{}, validation("a snoozed check-in needs a later time")
		}
	} else if input.SnoozedUntil != nil {
		return CheckIn{}, validation("only a snoozed check-in can have a snooze time")
	}
	return s.repo.PutCheckIn(ctx, userID, commitmentID, CheckIn{
		ScheduledFor: input.ScheduledFor.UTC(), LocalDate: localDate,
		Action: input.Action, SnoozedUntil: input.SnoozedUntil,
	})
}

func validation(message string) error { return httpx.ValidationError{Message: message} }

func oneOf(value string, options ...string) bool {
	for _, option := range options {
		if value == option {
			return true
		}
	}
	return false
}

func minuteOfDay(value int) bool { return value >= 0 && value <= 1439 }

func optionalRange(value *int, min, max int) bool {
	return value == nil || (*value >= min && *value <= max)
}

func ParseCommitmentID(raw string) (uuid.UUID, error) {
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, fmt.Errorf("%w", validation("commitment id is invalid"))
	}
	return id, nil
}
