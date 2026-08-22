package mentor

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"gorm.io/gorm/clause"

	"github.com/tesserix/kora/api/internal/diet"
)

// FoodRulesForUser returns every rule, confirmed or proposed. The client needs
// both: proposals are what it asks the user to accept.
func (r Repository) FoodRulesForUser(ctx context.Context, userID uuid.UUID) ([]FoodRule, error) {
	out := []FoodRule{}
	err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("subject ASC").
		Find(&out).Error
	if err != nil {
		return nil, fmt.Errorf("mentor: list food rules: %w", err)
	}
	return out, nil
}

// ConfirmedFoodRules returns only the rules in force, which is what every
// enforcement gate compiles.
func (r Repository) ConfirmedFoodRules(ctx context.Context, userID uuid.UUID) ([]FoodRule, error) {
	out := []FoodRule{}
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND confirmed_at IS NOT NULL", userID).
		Order("subject ASC").
		Find(&out).Error
	if err != nil {
		return nil, fmt.Errorf("mentor: list confirmed food rules: %w", err)
	}
	return out, nil
}

// UpsertFoodRules writes rules by (user_id, subject).
//
// keepConfirmation exists because the two writers want opposite things: a user
// editing their rules confirms them, while a pattern expansion or a coach
// extraction must not silently promote a subject the user has not seen. When
// true, an existing row's confirmed_at survives the write.
func (r Repository) UpsertFoodRules(ctx context.Context, rules []FoodRule, keepConfirmation bool) error {
	if len(rules) == 0 {
		return nil
	}
	now := time.Now().UTC()
	for i := range rules {
		if rules[i].ID == uuid.Nil {
			rules[i].ID = uuid.New()
		}
		rules[i].CreatedAt = now
		rules[i].UpdatedAt = now
	}

	assign := []string{"kind", "severity", "label", "source", "updated_at"}
	if !keepConfirmation {
		assign = append(assign, "confirmed_at")
	}
	err := r.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "user_id"}, {Name: "subject"}},
		DoUpdates: clause.AssignmentColumns(assign),
	}).Create(&rules).Error
	if err != nil {
		return fmt.Errorf("mentor: upsert food rules: %w", err)
	}
	return nil
}

// DeleteFoodRule removes one rule. Scoped by user so a guessed id reveals
// nothing about another account.
func (r Repository) DeleteFoodRule(ctx context.Context, userID uuid.UUID, subject string) error {
	result := r.db.WithContext(ctx).
		Where("user_id = ? AND subject = ?", userID, subject).
		Delete(&FoodRule{})
	if result.Error != nil {
		return fmt.Errorf("mentor: delete food rule: %w", result.Error)
	}
	if result.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteFoodRulesBySource clears the rules one writer owns, so re-expanding a
// changed diet pattern does not leave the previous pattern's rules behind.
func (r Repository) DeleteFoodRulesBySource(ctx context.Context, userID uuid.UUID, source string) error {
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND source = ?", userID, source).
		Delete(&FoodRule{}).Error
	if err != nil {
		return fmt.Errorf("mentor: delete food rules by source: %w", err)
	}
	return nil
}

// FoodRuleInput is one rule as the client states it.
type FoodRuleInput struct {
	Subject  string `json:"subject"`
	Kind     string `json:"kind"`
	Severity string `json:"severity"`
	Label    string `json:"label"`
}

// FoodRules lists a user's rules.
func (s Service) FoodRules(ctx context.Context, userID uuid.UUID) ([]FoodRule, error) {
	return s.repo.FoodRulesForUser(ctx, userID)
}

// PutFoodRules replaces the user's own rules with the given set, confirmed on
// arrival: submitting them through the rules screen is the confirmation.
// Pattern- and coach-sourced rules are untouched.
func (s Service) PutFoodRules(
	ctx context.Context,
	userID uuid.UUID,
	inputs []FoodRuleInput,
) ([]FoodRule, error) {
	if len(inputs) > maxFoodRules {
		return nil, validation(fmt.Sprintf("keep dietary rules to %d or fewer", maxFoodRules))
	}

	now := s.now().UTC()
	rules := make([]FoodRule, 0, len(inputs))
	seen := map[string]struct{}{}
	for _, in := range inputs {
		rule, err := s.buildFoodRule(userID, in, now)
		if err != nil {
			return nil, err
		}
		if _, dup := seen[rule.Subject]; dup {
			continue
		}
		seen[rule.Subject] = struct{}{}
		rules = append(rules, rule)
	}

	if err := s.repo.DeleteFoodRulesBySource(ctx, userID, diet.SourceUser); err != nil {
		return nil, err
	}
	if err := s.repo.UpsertFoodRules(ctx, rules, false); err != nil {
		return nil, err
	}
	return s.repo.FoodRulesForUser(ctx, userID)
}

// maxFoodRules bounds one user's rule set. Past this the prompt block stops
// being a constraint and becomes noise the model ignores.
const maxFoodRules = 40

func (s Service) buildFoodRule(userID uuid.UUID, in FoodRuleInput, now time.Time) (FoodRule, error) {
	subject := strings.ToLower(strings.TrimSpace(in.Subject))
	if subject == "" {
		return FoodRule{}, validation("a dietary rule needs a subject")
	}
	if !diet.ValidSubject(subject) {
		return FoodRule{}, validation(fmt.Sprintf("%q is not a food Kora can enforce yet", in.Subject))
	}
	if !diet.ValidKind(in.Kind) {
		return FoodRule{}, validation("choose a valid rule kind")
	}

	severity := in.Severity
	if severity == "" {
		severity = diet.DefaultSeverity(in.Kind)
	}
	if !diet.ValidSeverity(severity) {
		return FoodRule{}, validation("choose a valid rule severity")
	}
	// An allergy always blocks. Letting a client downgrade one would turn a
	// safety constraint into a suggestion.
	if in.Kind == diet.KindAllergy {
		severity = diet.SeverityBlock
	}

	label := strings.TrimSpace(in.Label)
	if label == "" {
		label = diet.LabelFor(subject)
	}
	if utf8.RuneCountInString(label) > 120 {
		return FoodRule{}, validation("a dietary rule label must be 120 characters or fewer")
	}

	confirmed := now
	return FoodRule{
		ID:          uuid.New(),
		UserID:      userID,
		Subject:     subject,
		Kind:        in.Kind,
		Severity:    severity,
		Label:       label,
		Source:      diet.SourceUser,
		ConfirmedAt: &confirmed,
	}, nil
}

// DeleteFoodRule removes one rule by subject.
func (s Service) DeleteFoodRule(ctx context.Context, userID uuid.UUID, subject string) error {
	subject = strings.ToLower(strings.TrimSpace(subject))
	if subject == "" {
		return validation("a dietary rule needs a subject")
	}
	return s.repo.DeleteFoodRule(ctx, userID, subject)
}

// ProposeFoodRules records rules Kora inferred — from a diet pattern, from the
// profile's free text, or from something the user said to the coach — as
// proposals. They do not take effect until the user confirms them.
func (s Service) ProposeFoodRules(
	ctx context.Context,
	userID uuid.UUID,
	rules []diet.Rule,
) error {
	if len(rules) == 0 {
		return nil
	}
	out := make([]FoodRule, 0, len(rules))
	for _, r := range rules {
		if !diet.ValidSubject(r.Subject) {
			continue
		}
		out = append(out, FoodRule{
			ID:       uuid.New(),
			UserID:   userID,
			Subject:  r.Subject,
			Kind:     r.Kind,
			Severity: r.Severity,
			Label:    r.Label,
			Source:   r.Source,
		})
	}
	return s.repo.UpsertFoodRules(ctx, out, true)
}

// ConfirmFoodRule puts a proposed rule in force.
func (s Service) ConfirmFoodRule(ctx context.Context, userID uuid.UUID, subject string) (FoodRule, error) {
	subject = strings.ToLower(strings.TrimSpace(subject))
	if subject == "" {
		return FoodRule{}, validation("a dietary rule needs a subject")
	}
	return s.repo.ConfirmFoodRule(ctx, userID, subject, s.now().UTC())
}

// ConfirmFoodRule marks one proposed rule as confirmed.
func (r Repository) ConfirmFoodRule(
	ctx context.Context,
	userID uuid.UUID,
	subject string,
	at time.Time,
) (FoodRule, error) {
	var out FoodRule
	result := r.db.WithContext(ctx).Model(&FoodRule{}).
		Where("user_id = ? AND subject = ?", userID, subject).
		Clauses(clause.Returning{}).
		Updates(map[string]any{"confirmed_at": at, "updated_at": at})
	if result.Error != nil {
		return FoodRule{}, fmt.Errorf("mentor: confirm food rule: %w", result.Error)
	}
	if result.RowsAffected == 0 {
		return FoodRule{}, ErrNotFound
	}
	if err := r.db.WithContext(ctx).
		Where("user_id = ? AND subject = ?", userID, subject).
		First(&out).Error; err != nil {
		return FoodRule{}, fmt.Errorf("mentor: reload confirmed food rule: %w", err)
	}
	return out, nil
}

// DietProfile compiles a user's confirmed rules into the form every gate reads.
// A read failure is an error rather than an empty profile: silently dropping
// constraints is exactly the failure this feature exists to prevent.
func (r Repository) DietProfile(ctx context.Context, userID uuid.UUID) (diet.Profile, error) {
	rules, err := r.ConfirmedFoodRules(ctx, userID)
	if err != nil {
		return diet.Profile{}, err
	}
	compiled := make([]diet.Rule, 0, len(rules))
	for _, r := range rules {
		compiled = append(compiled, diet.Rule{
			Subject:  r.Subject,
			Kind:     r.Kind,
			Severity: r.Severity,
			Label:    r.Label,
			Source:   r.Source,
		})
	}
	return diet.Compile(compiled), nil
}
