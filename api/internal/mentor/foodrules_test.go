package mentor

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/diet"
)

func subjectsOf(rules []FoodRule) []string {
	out := make([]string, 0, len(rules))
	for _, r := range rules {
		out = append(out, r.Subject)
	}
	return out
}

func ruleFor(t *testing.T, rules []FoodRule, subject string) FoodRule {
	t.Helper()
	for _, r := range rules {
		if r.Subject == subject {
			return r
		}
	}
	t.Fatalf("no rule for %q in %v", subject, subjectsOf(rules))
	return FoodRule{}
}

func foodRuleService(t *testing.T) (Service, *gorm.DB) {
	t.Helper()
	db := mentorTestDB(t)
	return NewService(NewRepository(db)), db
}

func TestPutFoodRulesConfirmsOnArrivalAndScopesToTheOwner(t *testing.T) {
	svc, db := foodRuleService(t)
	owner := seedMentorUser(t, db)
	other := seedMentorUser(t, db)
	ctx := context.Background()

	saved, err := svc.PutFoodRules(ctx, owner, []FoodRuleInput{
		{Subject: "beef", Kind: diet.KindExclusion},
		{Subject: "peanut", Kind: diet.KindAllergy},
	})
	require.NoError(t, err)
	require.Equal(t, []string{"beef", "peanut"}, subjectsOf(saved))

	// Submitting through the rules screen IS the confirmation, so these are in
	// force immediately — an unconfirmed rule would enforce nothing.
	for _, r := range saved {
		require.NotNil(t, r.ConfirmedAt, "rule %q must be confirmed on arrival", r.Subject)
		require.Equal(t, diet.SourceUser, r.Source)
	}

	otherRules, err := svc.FoodRules(ctx, other)
	require.NoError(t, err)
	require.Empty(t, otherRules, "one user's rules must not leak into another's")
}

func TestPutFoodRulesForcesAnAllergyToBlock(t *testing.T) {
	svc, db := foodRuleService(t)
	owner := seedMentorUser(t, db)

	saved, err := svc.PutFoodRules(context.Background(), owner, []FoodRuleInput{
		{Subject: "peanut", Kind: diet.KindAllergy, Severity: diet.SeverityFlag},
	})
	require.NoError(t, err)
	require.Equal(t, diet.SeverityBlock, ruleFor(t, saved, "peanut").Severity,
		"a client must not be able to downgrade an allergy to a suggestion")
}

func TestPutFoodRulesDefaultsSeverityAndLabelByKind(t *testing.T) {
	svc, db := foodRuleService(t)
	owner := seedMentorUser(t, db)

	saved, err := svc.PutFoodRules(context.Background(), owner, []FoodRuleInput{
		{Subject: "mushroom", Kind: diet.KindPreference},
		{Subject: "fish", Kind: diet.KindAllergy},
	})
	require.NoError(t, err)
	require.Equal(t, diet.SeverityFlag, ruleFor(t, saved, "mushroom").Severity)
	require.Equal(t, diet.SeverityBlock, ruleFor(t, saved, "fish").Severity)
	require.Equal(t, "Mushroom", ruleFor(t, saved, "mushroom").Label)
}

func TestPutFoodRulesRejectsAnUnknownSubject(t *testing.T) {
	svc, db := foodRuleService(t)
	owner := seedMentorUser(t, db)

	_, err := svc.PutFoodRules(context.Background(), owner, []FoodRuleInput{
		{Subject: "moon cheese", Kind: diet.KindExclusion},
	})
	require.Error(t, err, "an unenforceable subject must be refused, not stored as dead weight")
}

func TestPutFoodRulesReplacesTheUsersOwnRulesOnly(t *testing.T) {
	svc, db := foodRuleService(t)
	owner := seedMentorUser(t, db)
	ctx := context.Background()

	require.NoError(t, svc.ProposeFoodRules(ctx, owner, []diet.Rule{
		{Subject: "egg", Kind: diet.KindExclusion, Severity: diet.SeverityFlag, Source: diet.SourcePattern},
	}))
	_, err := svc.PutFoodRules(ctx, owner, []FoodRuleInput{{Subject: "beef", Kind: diet.KindExclusion}})
	require.NoError(t, err)

	after, err := svc.PutFoodRules(ctx, owner, []FoodRuleInput{{Subject: "pork", Kind: diet.KindExclusion}})
	require.NoError(t, err)
	require.Equal(t, []string{"egg", "pork"}, subjectsOf(after),
		"a replace must drop the user's previous rules and keep the pattern's")
}

func TestProposeFoodRulesDoesNotPutThemInForce(t *testing.T) {
	svc, db := foodRuleService(t)
	owner := seedMentorUser(t, db)
	ctx := context.Background()

	require.NoError(t, svc.ProposeFoodRules(ctx, owner, []diet.Rule{
		{Subject: "onion", Kind: diet.KindExclusion, Severity: diet.SeverityFlag, Source: diet.SourceCoach},
	}))

	listed, err := svc.FoodRules(ctx, owner)
	require.NoError(t, err)
	require.Nil(t, ruleFor(t, listed, "onion").ConfirmedAt)

	profile, err := NewRepository(db).DietProfile(ctx, owner)
	require.NoError(t, err)
	require.True(t, profile.Empty(), "an unconfirmed proposal must enforce nothing")
}

func TestProposeFoodRulesKeepsAnExistingConfirmation(t *testing.T) {
	svc, db := foodRuleService(t)
	owner := seedMentorUser(t, db)
	ctx := context.Background()

	_, err := svc.PutFoodRules(ctx, owner, []FoodRuleInput{{Subject: "peanut", Kind: diet.KindAllergy}})
	require.NoError(t, err)

	// A later pattern expansion touches the same subject. Demoting it would
	// silently switch off an allergy the user had already confirmed.
	require.NoError(t, svc.ProposeFoodRules(ctx, owner, []diet.Rule{
		{Subject: "peanut", Kind: diet.KindExclusion, Severity: diet.SeverityFlag, Source: diet.SourcePattern},
	}))

	listed, err := svc.FoodRules(ctx, owner)
	require.NoError(t, err)
	require.NotNil(t, ruleFor(t, listed, "peanut").ConfirmedAt)
}

func TestConfirmFoodRulePutsAProposalInForce(t *testing.T) {
	svc, db := foodRuleService(t)
	owner := seedMentorUser(t, db)
	ctx := context.Background()

	require.NoError(t, svc.ProposeFoodRules(ctx, owner, []diet.Rule{
		{Subject: "garlic", Kind: diet.KindExclusion, Severity: diet.SeverityFlag, Source: diet.SourceCoach},
	}))

	confirmed, err := svc.ConfirmFoodRule(ctx, owner, "garlic")
	require.NoError(t, err)
	require.NotNil(t, confirmed.ConfirmedAt)

	profile, err := NewRepository(db).DietProfile(ctx, owner)
	require.NoError(t, err)
	require.False(t, profile.Empty())
}

func TestConfirmFoodRuleCannotReachAnotherUsersRule(t *testing.T) {
	svc, db := foodRuleService(t)
	owner := seedMentorUser(t, db)
	other := seedMentorUser(t, db)
	ctx := context.Background()

	require.NoError(t, svc.ProposeFoodRules(ctx, owner, []diet.Rule{
		{Subject: "garlic", Kind: diet.KindExclusion, Severity: diet.SeverityFlag, Source: diet.SourceCoach},
	}))

	_, err := svc.ConfirmFoodRule(ctx, other, "garlic")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestDeleteFoodRuleIsScopedToTheOwner(t *testing.T) {
	svc, db := foodRuleService(t)
	owner := seedMentorUser(t, db)
	other := seedMentorUser(t, db)
	ctx := context.Background()

	_, err := svc.PutFoodRules(ctx, owner, []FoodRuleInput{{Subject: "beef", Kind: diet.KindExclusion}})
	require.NoError(t, err)

	require.ErrorIs(t, svc.DeleteFoodRule(ctx, other, "beef"), ErrNotFound)
	require.NoError(t, svc.DeleteFoodRule(ctx, owner, "beef"))

	listed, err := svc.FoodRules(ctx, owner)
	require.NoError(t, err)
	require.Empty(t, listed)
}

func TestDietProfileCompilesOnlyConfirmedRules(t *testing.T) {
	svc, db := foodRuleService(t)
	owner := seedMentorUser(t, db)
	ctx := context.Background()

	_, err := svc.PutFoodRules(ctx, owner, []FoodRuleInput{
		{Subject: "peanut", Kind: diet.KindAllergy},
	})
	require.NoError(t, err)
	require.NoError(t, svc.ProposeFoodRules(ctx, owner, []diet.Rule{
		{Subject: "onion", Kind: diet.KindExclusion, Severity: diet.SeverityFlag, Source: diet.SourceCoach},
	}))

	profile, err := NewRepository(db).DietProfile(ctx, owner)
	require.NoError(t, err)

	blocking := diet.Screen("peanut curry", profile)
	require.True(t, diet.HasBlocking(blocking))
	require.Empty(t, diet.Screen("onion salad", profile),
		"an unconfirmed proposal must not screen anything")
}

func TestPutProfileExpandsADietPatternIntoProposals(t *testing.T) {
	svc, db := foodRuleService(t)
	owner := seedMentorUser(t, db)
	ctx := context.Background()

	_, err := svc.PutProfile(ctx, owner, ProfileInput{
		DietPattern:       diet.PatternVegetarian,
		CoachingStyle:     CoachingStyleSupportive,
		ReminderIntensity: ReminderIntensityBalanced,
		QuietStartMinute:  22 * 60,
		QuietEndMinute:    7 * 60,
	})
	require.NoError(t, err)

	listed, err := svc.FoodRules(ctx, owner)
	require.NoError(t, err)
	require.Contains(t, subjectsOf(listed), "beef")
	require.Contains(t, subjectsOf(listed), "egg", "Indian vegetarian excludes egg")
	require.Nil(t, ruleFor(t, listed, "beef").ConfirmedAt, "a pattern proposes, it does not enforce")
}

func TestPutProfileRetiresThePreviousPatternsRules(t *testing.T) {
	svc, db := foodRuleService(t)
	owner := seedMentorUser(t, db)
	ctx := context.Background()

	base := ProfileInput{
		CoachingStyle:     CoachingStyleSupportive,
		ReminderIntensity: ReminderIntensityBalanced,
		QuietStartMinute:  22 * 60,
		QuietEndMinute:    7 * 60,
	}
	vegetarian := base
	vegetarian.DietPattern = diet.PatternVegetarian
	_, err := svc.PutProfile(ctx, owner, vegetarian)
	require.NoError(t, err)

	pescatarian := base
	pescatarian.DietPattern = diet.PatternPescatarian
	_, err = svc.PutProfile(ctx, owner, pescatarian)
	require.NoError(t, err)

	listed, err := svc.FoodRules(ctx, owner)
	require.NoError(t, err)
	require.NotContains(t, subjectsOf(listed), "fish",
		"switching to pescatarian must retire the vegetarian pattern's fish rule")
	require.Contains(t, subjectsOf(listed), "beef")
}

func TestPutProfileParsesFreeTextIntoProposals(t *testing.T) {
	svc, db := foodRuleService(t)
	owner := seedMentorUser(t, db)
	ctx := context.Background()

	_, err := svc.PutProfile(ctx, owner, ProfileInput{
		DietaryPreferences: "I don't eat beef",
		Allergies:          "peanuts",
		CoachingStyle:      CoachingStyleSupportive,
		ReminderIntensity:  ReminderIntensityBalanced,
		QuietStartMinute:   22 * 60,
		QuietEndMinute:     7 * 60,
	})
	require.NoError(t, err)

	listed, err := svc.FoodRules(ctx, owner)
	require.NoError(t, err)
	require.Contains(t, subjectsOf(listed), "beef")
	require.Equal(t, diet.SeverityBlock, ruleFor(t, listed, "peanut").Severity,
		"free text under Allergies must be read as an allergy")
}

func TestPutProfileRejectsAnUnsupportedDietPattern(t *testing.T) {
	svc, db := foodRuleService(t)
	owner := seedMentorUser(t, db)

	_, err := svc.PutProfile(context.Background(), owner, ProfileInput{
		DietPattern:       "carnivore",
		CoachingStyle:     CoachingStyleSupportive,
		ReminderIntensity: ReminderIntensityBalanced,
		QuietStartMinute:  22 * 60,
		QuietEndMinute:    7 * 60,
	})
	require.Error(t, err)
}

func TestPutFoodRulesRejectsMoreRulesThanTheLimit(t *testing.T) {
	svc, db := foodRuleService(t)
	owner := seedMentorUser(t, db)

	inputs := make([]FoodRuleInput, maxFoodRules+1)
	for i := range inputs {
		inputs[i] = FoodRuleInput{Subject: "beef", Kind: diet.KindExclusion}
	}
	_, err := svc.PutFoodRules(context.Background(), owner, inputs)
	require.Error(t, err)
}

func TestDietProfileIsEmptyForAUserWithNoRules(t *testing.T) {
	_, db := foodRuleService(t)
	owner := seedMentorUser(t, db)

	profile, err := NewRepository(db).DietProfile(context.Background(), owner)
	require.NoError(t, err)
	require.True(t, profile.Empty())
	require.Empty(t, diet.Screen("beef biryani with peanuts", profile))
}
