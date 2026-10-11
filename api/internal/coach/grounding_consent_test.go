package coach

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/mentor"
)

// filterHealthByConsent is the single consent gate between synced HealthKit
// data and the coach's grounded context (see kora#372). A metric present on
// mentor.HealthDay but missing from this function reaches the coach even
// after the user has withdrawn permission for it. This test exists so that
// adding a metric to HealthDay without wiring it here fails loudly.
//
// Values are obviously synthetic (repo is public): round numbers with no
// resemblance to a real person's data.
func TestFilterHealthByConsentNilsEveryMetricWhenItsFlagIsOff(t *testing.T) {
	steps := 5000
	sleep := 420
	workout := 30
	energy := 300
	restingHR := 60

	day := mentor.HealthDay{
		Steps:               &steps,
		SleepMinutes:        &sleep,
		WorkoutMinutes:      &workout,
		ActiveEnergyKcal:    &energy,
		RestingHeartRateBpm: &restingHR,
	}

	// All flags off: every metric must be nil'd out.
	allOff := mentor.Profile{}
	got := filterHealthByConsent([]mentor.HealthDay{day}, allOff)
	assert.Nil(t, got[0].Steps, "steps must be nil when health_steps_enabled is off")
	assert.Nil(t, got[0].SleepMinutes, "sleep_minutes must be nil when health_sleep_enabled is off")
	assert.Nil(t, got[0].WorkoutMinutes, "workout_minutes must be nil when health_workouts_enabled is off")
	assert.Nil(t, got[0].ActiveEnergyKcal, "active_energy_kcal must be nil when health_energy_enabled is off")
	assert.Nil(t, got[0].RestingHeartRateBpm, "resting_heart_rate_bpm must be nil when health_heart_rate_enabled is off")

	// All flags on: every metric must survive untouched.
	allOn := mentor.Profile{
		HealthStepsEnabled:     true,
		HealthSleepEnabled:     true,
		HealthWorkoutsEnabled:  true,
		HealthEnergyEnabled:    true,
		HealthHeartRateEnabled: true,
	}
	got = filterHealthByConsent([]mentor.HealthDay{day}, allOn)
	require.NotNil(t, got[0].Steps)
	assert.Equal(t, steps, *got[0].Steps)
	require.NotNil(t, got[0].SleepMinutes)
	assert.Equal(t, sleep, *got[0].SleepMinutes)
	require.NotNil(t, got[0].WorkoutMinutes)
	assert.Equal(t, workout, *got[0].WorkoutMinutes)
	require.NotNil(t, got[0].ActiveEnergyKcal)
	assert.Equal(t, energy, *got[0].ActiveEnergyKcal)
	require.NotNil(t, got[0].RestingHeartRateBpm)
	assert.Equal(t, restingHR, *got[0].RestingHeartRateBpm)

	// Energy consented on its own must not leak the metrics still withheld.
	energyOnly := mentor.Profile{HealthEnergyEnabled: true}
	got = filterHealthByConsent([]mentor.HealthDay{day}, energyOnly)
	assert.Nil(t, got[0].Steps)
	assert.Nil(t, got[0].SleepMinutes)
	assert.Nil(t, got[0].WorkoutMinutes)
	require.NotNil(t, got[0].ActiveEnergyKcal)
	assert.Equal(t, energy, *got[0].ActiveEnergyKcal)
	assert.Nil(t, got[0].RestingHeartRateBpm)

	// Resting heart rate consented on its own, mirroring the case above.
	heartRateOnly := mentor.Profile{HealthHeartRateEnabled: true}
	got = filterHealthByConsent([]mentor.HealthDay{day}, heartRateOnly)
	assert.Nil(t, got[0].Steps)
	assert.Nil(t, got[0].SleepMinutes)
	assert.Nil(t, got[0].WorkoutMinutes)
	assert.Nil(t, got[0].ActiveEnergyKcal)
	require.NotNil(t, got[0].RestingHeartRateBpm)
	assert.Equal(t, restingHR, *got[0].RestingHeartRateBpm)
}

// anyHealthConsented decides whether health days are fetched at all before
// filterHealthByConsent ever runs. A flag missing here means a user who
// consents only to a newer metric never has health days fetched for the
// coach in the first place -- the per-metric nil-out above never gets a
// chance to run for them.
func TestAnyHealthConsentedIncludesEveryFlag(t *testing.T) {
	cases := []struct {
		name    string
		profile mentor.Profile
		want    bool
	}{
		{"all off", mentor.Profile{}, false},
		{"steps only", mentor.Profile{HealthStepsEnabled: true}, true},
		{"sleep only", mentor.Profile{HealthSleepEnabled: true}, true},
		{"workouts only", mentor.Profile{HealthWorkoutsEnabled: true}, true},
		{"energy only", mentor.Profile{HealthEnergyEnabled: true}, true},
		{"heart rate only", mentor.Profile{HealthHeartRateEnabled: true}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, anyHealthConsented(tc.profile))
		})
	}
}
