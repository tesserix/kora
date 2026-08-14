import { useMemo, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Overline } from "@/components/Overline";
import { SegmentedGlass } from "@/components/instrument/SegmentedGlass";
import { Numeral } from "@/components/Numeral";
import { AuthScaffold } from "@/components/AuthScaffold";
import { ActivityFromHealth } from "@/components/ActivityFromHealth";
import { useActivityHistory } from "@/health/useActivityHistory";
import { TickRuler } from "@/components/instrument/TickRuler";
import { PlanDial } from "@/components/instrument/PlanDial";
import { PlanDelta } from "@/components/instrument/PlanDelta";
import { DerivationChain, type DerivationRow } from "@/components/instrument/DerivationChain";
import { useSubmitOnboarding } from "@/api/hooks";
import type { OnboardingInput } from "@/api/types";
import { useTheme } from "@/theme";
import { validateGoalWeight, validateOnboardingNumbers } from "@/lib/validateOnboarding";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { haptics } from "@/motion";
import { CM_PER_IN, kgFromLb, lbFromKg, useUnits, weightUnitLabel } from "@/units";
import {
  ACTIVITY_FACTORS,
  availablePaces,
  computePlan,
  weeksToGoal,
  type ActivityLevel,
  type PlanGoal,
} from "@/lib/plan";

type TouchedField = "age" | "height" | "weight" | "goalWeight";

const GOAL_IDS: readonly PlanGoal[] = ["fat_loss", "maintenance", "muscle_gain"];
const GOAL_LABELS = ["Lose weight", "Maintain", "Build muscle"] as const;
const GOAL_CAPTIONS = ["Gentle calorie deficit", "Stay where you are", "Lean surplus + protein"];

const SEX_OPTIONS: Array<{ key: OnboardingInput["sex"]; label: string }> = [
  { key: "male", label: "Male" },
  { key: "female", label: "Female" },
];

const ACTIVITY_IDS: readonly ActivityLevel[] = [
  "sedentary",
  "light",
  "moderate",
  "active",
  "very_active",
];
const ACTIVITY_LABELS = ["Sedentary", "Light", "Moderate", "Active", "Very active"] as const;
const ACTIVITY_CAPTIONS = [
  "Desk job, little walking",
  "1–2 sessions a week",
  "3–5 sessions a week",
  "6–7 sessions a week",
  "Physical job or athlete",
];

// Continuous ruler ranges. Metric ranges are ours to choose; imperial ranges
// (weight/goal-weight in lb, height in whole inches) are pinned by the brief.
const AGE_MIN = 13;
const AGE_MAX = 100;
const HEIGHT_CM_MIN = 120;
const HEIGHT_CM_MAX = 220;
const WEIGHT_KG_MIN = 30;
const WEIGHT_KG_MAX = 200;
const HEIGHT_IN_MIN = 55;
const HEIGHT_IN_MAX = 84;
const WEIGHT_LB_MIN = 80;
const WEIGHT_LB_MAX = 400;

function formatFtIn(inches: number): string {
  return `${Math.floor(inches / 12)}'${inches % 12}"`;
}

// Maps a stored activity_level back to its display label, so the Health
// suggestion names the level using exactly the same words as the ruler below it.
function activityLabel(level: OnboardingInput["activity_level"]): string {
  const index = ACTIVITY_IDS.indexOf(level);
  return index >= 0 ? ACTIVITY_LABELS[index] : String(level);
}

export default function Onboarding() {
  const { colors, spacing } = useTheme();
  const submit = useSubmitOnboarding();
  const { system } = useUnits();
  const health = useActivityHistory();

  const [goalIndex, setGoalIndex] = useState(0);
  const [sex, setSex] = useState<OnboardingInput["sex"]>("male");
  const [activityIndex, setActivityIndex] = useState(2);
  const [age, setAge] = useState(30);
  const [heightCm, setHeightCm] = useState(170);
  const [weightKg, setWeightKg] = useState(70);
  const [goalWeightKg, setGoalWeightKg] = useState(65);
  const [paceIndex, setPaceIndex] = useState(1);
  const [touched, setTouched] = useState<ReadonlySet<TouchedField>>(new Set());
  // Three separate error slots, not one: validation errors render under their
  // own field, and only a submit (API/network) failure renders beside the
  // accept button.
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [goalWeightErrorMsg, setGoalWeightErrorMsg] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // The only evidence the user acted, for PlanDelta: incremented on every
  // input change, including ones where the resting-burn clamp leaves kcal
  // itself unchanged.
  const [revision, setRevision] = useState(0);

  const bump = () => setRevision((r) => r + 1);
  const markTouched = (field: TouchedField) =>
    setTouched((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));

  const goal = GOAL_IDS[goalIndex];
  const activityLevel = ACTIVITY_IDS[activityIndex];
  const paces = useMemo(() => availablePaces(weightKg), [weightKg]);

  // A dropping weight can shrink the pace list below the current index.
  // Derived at render time rather than corrected afterward in an effect: an
  // effect-based clamp runs AFTER the commit that shrank `paces`, so the
  // ruler would render for one frame with a stale index against the shorter
  // `labels` array (accessibilityValue reading undefined). Deriving it here
  // means there is never a transient to correct, and there is exactly one
  // source of truth for "the pace stop actually in effect".
  const safePaceIndex = Math.min(paceIndex, paces.length - 1);
  const paceKgPerWeek = paces[safePaceIndex];

  const plan = useMemo(
    () =>
      computePlan({
        sex,
        age,
        heightCm,
        weightKg,
        activityLevel,
        goal,
        paceKgPerWeek,
      }),
    [sex, age, heightCm, weightKg, activityLevel, goal, paceKgPerWeek],
  );

  const hasAllNumbers = touched.has("age") && touched.has("height") && touched.has("weight");
  const dialKcal = hasAllNumbers ? plan.kcal : null;
  // Gates whether the destination (goal weight + pace) is a real, user-set
  // value rather than the untouched defaults — mirrors hasAllNumbers, but
  // for the ruler this screen never forces the user to touch before the
  // accept button unlocks.
  const hasDestination = goal !== "maintenance" && touched.has("goalWeight");
  // A non-maintenance goal has no plan without a destination: the deficit is
  // derived from pace, so an untouched destination would mean showing a
  // target (computed from the visible, always-real pace stop) the server
  // cannot reproduce — it omits pace_kg_per_week and collapses to plain
  // TDEE. This is what gates the accept button, not hasAllNumbers alone.
  const canAccept = hasAllNumbers && (goal === "maintenance" || touched.has("goalWeight"));

  function onGoalChange(index: number) {
    setGoalIndex(index);
    bump();
  }
  function onSexChange(key: string) {
    setSex(key as OnboardingInput["sex"]);
    bump();
  }
  function onActivityChange(index: number) {
    setActivityIndex(index);
    bump();
  }
  function onAcceptHealthActivity(level: OnboardingInput["activity_level"]) {
    const index = ACTIVITY_IDS.indexOf(level);
    if (index >= 0) setActivityIndex(index);
    // PlanDelta's revision is the only evidence the user acted — a
    // Health-sourced change is still the user accepting a suggestion, so it
    // must bump exactly like a manual drag would.
    bump();
  }
  function onAgeChange(value: number) {
    setAge(value);
    markTouched("age");
    bump();
  }
  function onHeightChange(value: number) {
    setHeightCm(system === "imperial" ? value * CM_PER_IN : value);
    markTouched("height");
    bump();
  }
  function onWeightChange(value: number) {
    setWeightKg(system === "imperial" ? kgFromLb(value) : value);
    markTouched("weight");
    bump();
  }
  function onGoalWeightChange(value: number) {
    setGoalWeightKg(system === "imperial" ? kgFromLb(value) : value);
    markTouched("goalWeight");
    bump();
  }
  function onPaceChange(index: number) {
    setPaceIndex(index);
    bump();
  }

  function onSubmit() {
    setDetailsError(null);
    setGoalWeightErrorMsg(null);
    setSubmitError(null);
    const unitOpts = system === "imperial" ? { heightUnit: "in", weightUnit: "lb" } : undefined;
    const numbersError = validateOnboardingNumbers(
      String(age),
      String(heightCm),
      String(weightKg),
      unitOpts,
    );
    if (numbersError) {
      setDetailsError(numbersError);
      return;
    }
    // Validating an untouched destination would block submit on the default
    // goalWeightKg (65) the user never chose — and since it is not sent
    // below, there is nothing to validate until the ruler has been moved.
    if (hasDestination) {
      const goalWeightError = validateGoalWeight(goal, weightKg, goalWeightKg, weightUnitLabel(system));
      if (goalWeightError) {
        setGoalWeightErrorMsg(goalWeightError);
        return;
      }
    }
    const input: OnboardingInput = {
      sex,
      goal,
      // Without this the server falls back to DefaultTimezone
      // (Australia/Sydney) for every account, so a user anywhere else got the
      // wrong day boundary from signup — see kora#84. The profile zone still
      // drives streaks and challenge windows even after local_date fixed log
      // bucketing, so it has to be right.
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      activity_level: activityLevel,
      birth_year: new Date().getFullYear() - age,
      height_cm: heightCm,
      weight_kg: weightKg,
      // The destination has no meaning while maintaining, and an untouched
      // ruler is a default the user never chose — both are omitted entirely
      // rather than sent as a fabricated destination.
      ...(hasDestination ? { goal_weight_kg: goalWeightKg, pace_kg_per_week: paceKgPerWeek } : {}),
    };
    submit.mutate(input, {
      onSuccess: () => {
        haptics.success();
        router.replace("/");
      },
      // Names the actual cause: a 5xx or an offline phone must not tell the
      // user their details are wrong and send them round a loop.
      onError: (e: unknown) => setSubmitError(apiErrorMessage(e)),
    });
  }

  // `plan` is computed unconditionally (from default placeholder numbers
  // until the user has touched anything real), so these rows and the macro
  // trio below must not read it directly while !hasAllNumbers — that would
  // present a concrete target the user never agreed to. The labels stay in
  // place (structure visible) while the values withhold ("—", matching the
  // header Numeral's own placeholder) until the plan is real.
  const derivationRows: DerivationRow[] = [
    { label: "Resting burn", value: hasAllNumbers ? `${Math.round(plan.bmr)} kcal` : "—" },
    { label: "Activity-adjusted", value: hasAllNumbers ? `${Math.round(plan.tdee)} kcal` : "—" },
    {
      label: "Goal adjustment",
      value: hasAllNumbers
        ? `${plan.adjustment >= 0 ? "+" : "−"}${Math.abs(Math.round(plan.adjustment))} kcal`
        : "—",
    },
    { label: "Daily target", value: hasAllNumbers ? `${Math.round(plan.kcal)} kcal` : "—" },
  ];

  const weeks = hasDestination ? weeksToGoal(weightKg, goalWeightKg, paceKgPerWeek) : 0;

  return (
    <AuthScaffold
      header={
        <View
          style={{
            alignItems: "center",
            gap: spacing.xs,
            paddingHorizontal: spacing.lg,
            paddingBottom: spacing.sm,
          }}
        >
          <PlanDial kcal={dialKcal} />
          <Numeral size={36} weight="800">
            {hasAllNumbers ? String(Math.round(plan.kcal)) : "—"}
          </Numeral>
          <AppText variant="caption" muted style={{ textTransform: "uppercase", letterSpacing: 1.4 }}>
            kcal / day
          </AppText>
          <PlanDelta kcal={dialKcal} floored={plan.floored} revision={revision} />
        </View>
      }
      footer={
        <View style={{ gap: spacing.xs }}>
          {submitError ? (
            <AppText
              variant="footnote"
              accessibilityLiveRegion="polite"
              style={{ color: colors.destructive }}
            >
              {submitError}
            </AppText>
          ) : null}
          <Button
            testID="accept-button"
            title={submit.isPending ? "Saving…" : "Start with this plan"}
            icon="arrow-right"
            iconPosition="trailing"
            onPress={onSubmit}
            // The accept gate is the whole point of this screen: a press
            // before the user has actually set their own numbers (or, for a
            // non-maintenance goal, before they've set a destination) would
            // submit fabricated or server-unreproducible values as if they
            // were real. Button already turns `disabled` into
            // accessibilityState for assistive tech.
            disabled={submit.isPending || !canAccept}
          />
          {!hasAllNumbers ? (
            <AppText variant="footnote" muted style={{ textAlign: "center" }}>
              Set your age, height and weight to see your plan.
            </AppText>
          ) : !canAccept ? (
            <AppText variant="footnote" muted style={{ textAlign: "center" }}>
              Set your goal weight to see your plan.
            </AppText>
          ) : null}
        </View>
      }
    >
      <Overline>Your goal</Overline>
      <TickRuler
        mode="detented"
        index={goalIndex}
        labels={GOAL_LABELS}
        onChange={onGoalChange}
        accessibilityLabel="Goal"
        testID="goal-ruler"
      />
      <AppText variant="footnote" muted>
        {GOAL_CAPTIONS[goalIndex]}
      </AppText>

      <Overline style={{ marginTop: spacing.sm }}>You</Overline>
      <SegmentedGlass options={SEX_OPTIONS} value={sex} onChange={onSexChange} />

      <View style={{ gap: spacing.md }}>
        <View>
          <AppText variant="footnote" muted>
            Age
          </AppText>
          <TickRuler
            mode="continuous"
            value={age}
            min={AGE_MIN}
            max={AGE_MAX}
            step={1}
            onChange={onAgeChange}
            accessibilityLabel="Age in years"
            testID="age-ruler"
          />
        </View>
        <View>
          <AppText variant="footnote" muted>
            Height
          </AppText>
          {system === "imperial" ? (
            <TickRuler
              mode="continuous"
              value={Math.round(heightCm / CM_PER_IN)}
              min={HEIGHT_IN_MIN}
              max={HEIGHT_IN_MAX}
              step={1}
              onChange={onHeightChange}
              formatLabel={formatFtIn}
              accessibilityLabel="Height"
              testID="height-ruler"
            />
          ) : (
            <TickRuler
              mode="continuous"
              value={heightCm}
              min={HEIGHT_CM_MIN}
              max={HEIGHT_CM_MAX}
              step={1}
              onChange={onHeightChange}
              accessibilityLabel="Height in centimetres"
              testID="height-ruler"
            />
          )}
        </View>
        <View>
          <AppText variant="footnote" muted>
            Weight
          </AppText>
          {system === "imperial" ? (
            <TickRuler
              mode="continuous"
              value={Math.round(lbFromKg(weightKg))}
              min={WEIGHT_LB_MIN}
              max={WEIGHT_LB_MAX}
              step={1}
              onChange={onWeightChange}
              accessibilityLabel="Weight in pounds"
              testID="weight-ruler"
            />
          ) : (
            <TickRuler
              mode="continuous"
              value={weightKg}
              min={WEIGHT_KG_MIN}
              max={WEIGHT_KG_MAX}
              step={0.5}
              onChange={onWeightChange}
              accessibilityLabel="Weight in kilograms"
              testID="weight-ruler"
            />
          )}
        </View>
        {detailsError ? (
          <AppText
            variant="footnote"
            accessibilityLiveRegion="polite"
            style={{ color: colors.destructive }}
          >
            {detailsError}
          </AppText>
        ) : null}
      </View>

      <Overline style={{ marginTop: spacing.sm }}>Activity</Overline>
      <ActivityFromHealth
        status={health.status}
        inference={health.inference}
        levelLabel={activityLabel}
        onUseHealth={health.request}
        onAccept={onAcceptHealthActivity}
      />
      <TickRuler
        mode="detented"
        index={activityIndex}
        labels={ACTIVITY_LABELS}
        onChange={onActivityChange}
        accessibilityLabel="Activity level"
        testID="activity-ruler"
      />
      <AppText variant="footnote" muted>
        {ACTIVITY_CAPTIONS[activityIndex]} · ×{ACTIVITY_FACTORS[activityLevel]}
      </AppText>

      {goal !== "maintenance" ? (
        <>
          <Overline style={{ marginTop: spacing.sm }}>Destination</Overline>
          {system === "imperial" ? (
            <TickRuler
              mode="continuous"
              value={Math.round(lbFromKg(goalWeightKg))}
              min={WEIGHT_LB_MIN}
              max={WEIGHT_LB_MAX}
              step={1}
              onChange={onGoalWeightChange}
              accessibilityLabel="Goal weight in pounds"
              testID="goal-weight-ruler"
            />
          ) : (
            <TickRuler
              mode="continuous"
              value={goalWeightKg}
              min={WEIGHT_KG_MIN}
              max={WEIGHT_KG_MAX}
              step={0.5}
              onChange={onGoalWeightChange}
              accessibilityLabel="Goal weight in kilograms"
              testID="goal-weight-ruler"
            />
          )}
          {goalWeightErrorMsg ? (
            <AppText
              variant="footnote"
              accessibilityLiveRegion="polite"
              style={{ color: colors.destructive }}
            >
              {goalWeightErrorMsg}
            </AppText>
          ) : null}
          <TickRuler
            mode="detented"
            index={safePaceIndex}
            labels={paces.map((p) => `${p} kg/wk`)}
            onChange={onPaceChange}
            accessibilityLabel="Pace"
            testID="pace-ruler"
          />
          <AppText testID="destination-caption" variant="footnote" muted>
            {/* Same leak as the derivation rows: `weeks` is derived from the
                goalWeightKg default until the user has actually moved the
                destination ruler, so it withholds behind hasDestination
                (which also requires hasAllNumbers) rather than showing a
                distance to a body/destination the user never entered. */}
            {hasAllNumbers && hasDestination
              ? weeks > 0
                ? `${weeks} weeks to goal`
                : "You're already there"
              : "—"}
          </AppText>
        </>
      ) : null}

      <DerivationChain rows={derivationRows} />

      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <View style={{ alignItems: "center" }}>
          <AppText variant="footnote" muted>
            Protein
          </AppText>
          <Numeral>{hasAllNumbers ? `${Math.round(plan.proteinG)}g` : "—"}</Numeral>
        </View>
        <View style={{ alignItems: "center" }}>
          <AppText variant="footnote" muted>
            Carbs
          </AppText>
          <Numeral>{hasAllNumbers ? `${Math.round(plan.carbsG)}g` : "—"}</Numeral>
        </View>
        <View style={{ alignItems: "center" }}>
          <AppText variant="footnote" muted>
            Fat
          </AppText>
          <Numeral>{hasAllNumbers ? `${Math.round(plan.fatG)}g` : "—"}</Numeral>
        </View>
      </View>

      <AppText variant="footnote" muted style={{ textAlign: "center" }}>
        Kora gives general nutrition information, not medical advice. For medical concerns, talk
        to a healthcare professional.
      </AppText>
    </AuthScaffold>
  );
}
