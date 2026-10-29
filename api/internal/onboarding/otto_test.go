package onboarding

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func ottoDraft() Input {
	return Input{
		Sex: "male", BirthYear: 1990, HeightCm: 180, WeightKg: 85,
		ActivityLevel: "moderate", Goal: "fat_loss",
		GoalWeightKg: 75, PaceKgPerWeek: 0.5,
	}
}

func TestParseOttoReplyPlain(t *testing.T) {
	r, err := parseOttoReply(`{"reply":"ok","change":{"protein_override_g":125}}`)
	require.NoError(t, err)
	require.Equal(t, "ok", r.Reply)
	require.NotNil(t, r.Change)
	require.Equal(t, 125.0, *r.Change.ProteinOverrideG)
}

func TestParseOttoReplyFenced(t *testing.T) {
	r, err := parseOttoReply("```json\n{\"reply\":\"ok\",\"change\":{\"protein_override_g\":125}}\n```")
	require.NoError(t, err)
	require.Equal(t, "ok", r.Reply)
	require.Equal(t, 125.0, *r.Change.ProteinOverrideG)
}

func TestParseOttoReplyProse(t *testing.T) {
	_, err := parseOttoReply("Sure! I'd suggest...")
	require.Error(t, err)
}

func TestParseOttoReplyEmptyReply(t *testing.T) {
	_, err := parseOttoReply(`{"reply":"  "}`)
	require.Error(t, err)
}

func TestApplyIgnoresUnknownEnums(t *testing.T) {
	couch, bulk := "couch", "bulk"
	in := ottoDraft()
	out := ottoChange{ActivityLevel: &couch, Goal: &bulk}.apply(in)
	require.Equal(t, "moderate", out.ActivityLevel)
	require.Equal(t, "fat_loss", out.Goal)
}

func TestApplyClears(t *testing.T) {
	k, p := 2000.0, 120.0
	in := ottoDraft()
	in.KcalOverride, in.ProteinOverrideG = &k, &p

	out := ottoChange{ClearKcalOverride: true, ClearProteinOverride: true}.apply(in)
	require.Nil(t, out.KcalOverride)
	require.Nil(t, out.ProteinOverrideG)

	nk := 2200.0
	out = ottoChange{KcalOverride: &nk, ClearKcalOverride: true}.apply(in)
	require.Equal(t, 2200.0, *out.KcalOverride)
}

func TestApplyMaintenanceZeroesDestination(t *testing.T) {
	g := "maintenance"
	out := ottoChange{Goal: &g}.apply(ottoDraft())
	require.Equal(t, "maintenance", out.Goal)
	require.Zero(t, out.GoalWeightKg)
	require.Zero(t, out.PaceKgPerWeek)
}

func TestPlanChangesListsOnlyDiffs(t *testing.T) {
	oldIn := ottoDraft()
	oldT, err := Calculate(oldIn, 2026)
	require.NoError(t, err)
	p := 125.0
	newIn := ottoChange{ProteinOverrideG: &p}.apply(oldIn)
	newT, err := Calculate(newIn, 2026)
	require.NoError(t, err)

	got := planChanges(oldIn, newIn, oldT, newT)
	require.Len(t, got, 2)
	require.Equal(t, "protein_g", got[0].Field)
	require.Equal(t, 135.0, got[0].From)
	require.Equal(t, 125.0, got[0].To)
	require.Equal(t, "carbs_g", got[1].Field)
}

func TestEmpty(t *testing.T) {
	require.True(t, (*ottoChange)(nil).empty())
	require.True(t, (&ottoChange{}).empty())
	g := "fat_loss"
	require.False(t, (&ottoChange{Goal: &g}).empty())
}
