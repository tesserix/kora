import { useCallback, useMemo, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Overline } from "@/components/Overline";
import { SegmentedGlass } from "@/components/instrument/SegmentedGlass";
import { Numeral } from "@/components/Numeral";
import { AuthScaffold, HEADER_SCROLLS_ABOVE_FONT_SCALE } from "@/components/AuthScaffold";
import { ActivityFromHealth } from "@/components/ActivityFromHealth";
import { useActivityHistory } from "@/health/useActivityHistory";
import { TickRuler } from "@/components/instrument/TickRuler";
import { PlanDial } from "@/components/instrument/PlanDial";
import { PlanDelta } from "@/components/instrument/PlanDelta";
import { DerivationChain, type DerivationRow } from "@/components/instrument/DerivationChain";
import type { OnboardingInput } from "@/api/types";
import { useTheme } from "@/theme";
import { validateGoalWeight, validateOnboardingNumbers } from "@/lib/validateOnboarding";
import { deriveGoalWeightKg } from "@/lib/goalWeightDefault";
import { draftFromParams, draftToParams } from "@/lib/planDraft";
import { CM_PER_IN, kgFromLb, lbFromKg, useUnits, weightUnitLabel } from "@/units";
import {
  ACTIVITY_FACTORS,
  availablePaces,
  computePlan,
  weeksToGoal,
  type ActivityLevel,
  type PlanGoal,
} from "@/lib/plan";

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

// Where an unset ruler rests, and so what a single tap on it commits.
const AGE_REST = 30;
const HEIGHT_CM_REST = 170;
const WEIGHT_KG_REST = 70;
const ACTIVITY_REST = 2;
const GOAL_REST = 0;
const PACE_REST = 1;

const ACTIVITY_UNSET_CAPTION = "Pick one: this changes your calories by up to ~500 kcal";

/** "a", "a and b", "a, b and c". */
function listOf(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * The most of the window height the dial may take while the header is STICKY.
 *
 * The header is the only thing on this screen the user cannot scroll away below
 * the threshold, and since kora#268 the dial grows with Dynamic Type like
 * everything else in it. At fontScale 1.3 an unbounded dial goes from 178pt to
 * 231pt — +53pt on the header that kora#284 is a complaint about — so while it
 * is sticky the dial gets a ceiling instead.
 *
 * The arithmetic, on a 393x852 device (iPhone 16 Pro class):
 *
 *   design dial   178 / 852            = 20.9% of the window
 *   ceiling       852 * 0.23           = 195.96pt
 *   scale ceiling 195.96 / 178         = 1.101
 *
 * So 23% is 20.9% plus two points of headroom: the dial may grow by a tenth,
 * and the rest of the header's growth is spent on the numeral and the captions
 * — which is the text the user actually asked to enlarge. At 1.3 that is 196pt
 * rather than 231pt.
 *
 * Above the threshold the header scrolls, so nothing is pinned and no ceiling
 * is needed — the budget is omitted there and the dial takes its natural scale.
 */
export const STICKY_DIAL_HEIGHT_SHARE = 0.23;

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
  const { system } = useUnits();
  const { fontScale, height: windowHeight } = useWindowDimensions();
  const health = useActivityHistory();
  const params = useLocalSearchParams<Record<string, string | string[]>>();

  // Edit mode arrives from /plan with the current draft. Read once: the draft
  // seeds the rulers and a later param change must not reset what the user did.
  // A draft that fails validation is ignored and the screen starts unset.
  const [seed] = useState(() => (params.mode === "edit" ? draftFromParams(params) : null));
  const isEdit = seed !== null;

  // The screen holds no defaults: a tap sets a ruler's rest value, and kora#164's displayed-but-unaccepted trap cannot occur because nothing is displayed until it is set.
  const [goalIndex, setGoalIndex] = useState<number | null>(
    seed ? GOAL_IDS.indexOf(seed.goal) : null,
  );
  const [sex, setSex] = useState<OnboardingInput["sex"] | null>(seed?.sex ?? null);
  const [activityIndex, setActivityIndex] = useState<number | null>(
    seed ? ACTIVITY_IDS.indexOf(seed.activity_level) : null,
  );
  const [age, setAge] = useState<number | null>(
    seed ? new Date().getFullYear() - seed.birth_year : null,
  );
  const [heightCm, setHeightCm] = useState<number | null>(seed?.height_cm ?? null);
  const [weightKg, setWeightKg] = useState<number | null>(seed?.weight_kg ?? null);
  // `null` until the user sets a destination. Its rest position is derived
  // from goal and weight (below); the user's number, once set, is never
  // recomputed under them. The server reports "no destination" as 0.
  const [chosenGoalWeightKg, setChosenGoalWeightKg] = useState<number | null>(
    seed?.goal_weight_kg || null,
  );
  const [paceIndex, setPaceIndex] = useState<number | null>(() => {
    if (!seed?.pace_kg_per_week) return null;
    const i = availablePaces(seed.weight_kg).indexOf(seed.pace_kg_per_week);
    return i >= 0 ? i : null;
  });
  // Two error slots, not one: each validation error renders under its own field.
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [goalWeightErrorMsg, setGoalWeightErrorMsg] = useState<string | null>(null);
  // The only evidence the user acted, for PlanDelta: incremented on every
  // input change, including ones where the resting-burn clamp leaves kcal
  // itself unchanged.
  const [revision, setRevision] = useState(0);

  const bump = useCallback(() => setRevision((r) => r + 1), []);

  const goal = goalIndex === null ? null : GOAL_IDS[goalIndex];
  const activityLevel = activityIndex === null ? null : ACTIVITY_IDS[activityIndex];
  const hasDestination = goal !== null && goal !== "maintenance";
  // Clamp the derived destination against the range of the ruler actually on
  // screen. The imperial weight ruler is 80-400 lb, which is not the metric
  // ruler's 30-200 kg, so deriving against the metric bounds in imperial mode
  // could place the destination off the end of the scale the user is reading.
  const weightRangeKg =
    system === "imperial"
      ? { min: kgFromLb(WEIGHT_LB_MIN), max: kgFromLb(WEIGHT_LB_MAX) }
      : { min: WEIGHT_KG_MIN, max: WEIGHT_KG_MAX };
  // Until the user sets the destination its rest tracks their goal and their
  // current weight, so a single tap can never commit the contradiction
  // `validateGoalWeight` would refuse (65kg while building from 70kg).
  const goalWeightRestKg =
    goal !== null && weightKg !== null
      ? deriveGoalWeightKg(goal, weightKg, weightRangeKg.min, weightRangeKg.max)
      : null;
  const paces = useMemo(() => (weightKg === null ? [] : availablePaces(weightKg)), [weightKg]);

  // A dropping weight can shrink the pace list below the current index.
  // Derived at render time rather than corrected afterward in an effect: an
  // effect-based clamp runs AFTER the commit that shrank `paces`, so the
  // ruler would render for one frame with a stale index against the shorter
  // `labels` array (accessibilityValue reading undefined). Deriving it here
  // means there is never a transient to correct, and there is exactly one
  // source of truth for "the pace stop actually in effect".
  const safePaceIndex = paceIndex === null ? null : Math.min(paceIndex, paces.length - 1);
  const paceKgPerWeek = safePaceIndex === null ? null : paces[safePaceIndex];

  const missing = [
    goal === null && "goal",
    sex === null && "sex",
    age === null && "age",
    heightCm === null && "height",
    weightKg === null && "weight",
    activityLevel === null && "activity",
    hasDestination && chosenGoalWeightKg === null && "goal weight",
    hasDestination && paceKgPerWeek === null && "pace",
  ].filter((m): m is string => m !== false);

  // The full payload, or null until every required field is set. The
  // destination has no meaning while maintaining, so it is omitted then.
  function buildInput(): OnboardingInput | null {
    if (
      goal === null ||
      sex === null ||
      age === null ||
      heightCm === null ||
      weightKg === null ||
      activityLevel === null
    ) {
      return null;
    }
    let destination = {};
    if (goal !== "maintenance") {
      if (chosenGoalWeightKg === null || paceKgPerWeek === null) return null;
      destination = {
        goal_weight_kg: chosenGoalWeightKg,
        pace_kg_per_week: paceKgPerWeek,
      };
    }
    return {
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
      ...destination,
      // Overrides are the Plan page's to change; editing the inputs here
      // carries them back untouched.
      ...(seed?.target_kcal_override != null
        ? { target_kcal_override: seed.target_kcal_override }
        : {}),
      ...(seed?.target_protein_override_g != null
        ? { target_protein_override_g: seed.target_protein_override_g }
        : {}),
    };
  }
  const input = buildInput();

  // Kora's own calculation for the draft; overrides are shown on /plan.
  const plan = input
    ? computePlan({
        sex: input.sex,
        age: new Date().getFullYear() - input.birth_year,
        heightCm: input.height_cm,
        weightKg: input.weight_kg,
        activityLevel: input.activity_level,
        goal: input.goal,
        paceKgPerWeek: input.pace_kg_per_week ?? 0,
        goalWeightKg: input.goal_weight_kg,
      })
    : null;

  // Stable identities: TickRuler rebuilds its gestures whenever onChange changes.
  const onGoalChange = useCallback(
    (index: number) => {
      setGoalIndex(index);
      bump();
    },
    [bump],
  );
  const onSexChange = useCallback(
    (key: string) => {
      setSex(key as OnboardingInput["sex"]);
      bump();
    },
    [bump],
  );
  const onActivityChange = useCallback(
    (index: number) => {
      setActivityIndex(index);
      bump();
    },
    [bump],
  );
  // Accepting the Health suggestion counts as choosing an activity level, and
  // bumps PlanDelta exactly like a manual drag would.
  const onAcceptHealthActivity = useCallback(
    (level: OnboardingInput["activity_level"]) => {
      const index = ACTIVITY_IDS.indexOf(level);
      if (index >= 0) setActivityIndex(index);
      bump();
    },
    [bump],
  );
  const onAgeChange = useCallback(
    (value: number) => {
      setAge(value);
      bump();
    },
    [bump],
  );
  const onHeightChange = useCallback(
    (value: number) => {
      setHeightCm(system === "imperial" ? value * CM_PER_IN : value);
      bump();
    },
    [bump, system],
  );
  const onWeightChange = useCallback(
    (value: number) => {
      setWeightKg(system === "imperial" ? kgFromLb(value) : value);
      bump();
    },
    [bump, system],
  );
  const onGoalWeightChange = useCallback(
    (value: number) => {
      setChosenGoalWeightKg(system === "imperial" ? kgFromLb(value) : value);
      bump();
    },
    [bump, system],
  );
  const onPaceChange = useCallback(
    (index: number) => {
      setPaceIndex(index);
      bump();
    },
    [bump],
  );

  // Hands the draft to /plan, which shows it and owns the submit.
  function onSeePlan() {
    if (!input) return;
    setDetailsError(null);
    setGoalWeightErrorMsg(null);
    const unitOpts = system === "imperial" ? { heightUnit: "in", weightUnit: "lb" } : undefined;
    // These are always real numbers straight off the rulers — never the empty
    // strings a text field could hand over — so this guard is a range check on
    // values the user can see, not a fill-in-the-blanks check. It stays
    // because a ruler range and a validator range can drift apart.
    const numbersError = validateOnboardingNumbers(
      String(new Date().getFullYear() - input.birth_year),
      String(input.height_cm),
      String(input.weight_kg),
      unitOpts,
    );
    if (numbersError) {
      setDetailsError(numbersError);
      return;
    }
    if (input.goal_weight_kg !== undefined) {
      const goalWeightError = validateGoalWeight(
        input.goal,
        input.weight_kg,
        input.goal_weight_kg,
        weightUnitLabel(system),
      );
      if (goalWeightError) {
        setGoalWeightErrorMsg(goalWeightError);
        return;
      }
    }
    const draftParams = draftToParams(input);
    if (isEdit) {
      router.navigate({ pathname: "/plan", params: { ...draftParams, mode: "edit" } });
    } else {
      router.push({ pathname: "/plan", params: { ...draftParams, mode: "onboarding" } });
    }
  }

  // The arithmetic behind the number on the dial, for the values currently on
  // the rulers, so the user sees how the plan was reached before /plan.
  const derivationRows: DerivationRow[] = plan
    ? [
        { label: "Resting burn", value: `${Math.round(plan.bmr)} kcal` },
        { label: "Activity-adjusted", value: `${Math.round(plan.tdee)} kcal` },
        {
          label: "Goal adjustment",
          value: `${plan.adjustment >= 0 ? "+" : "−"}${Math.abs(Math.round(plan.adjustment))} kcal`,
        },
        { label: "Daily target", value: `${Math.round(plan.kcal)} kcal` },
      ]
    : [];

  const weeks =
    weightKg !== null && chosenGoalWeightKg !== null && paceKgPerWeek !== null
      ? weeksToGoal(weightKg, chosenGoalWeightKg, paceKgPerWeek)
      : null;

  // `undefined`, not a number, once the header scrolls: PlanDial reads any
  // absent or unresolved budget as "no ceiling" and a real-looking 0 as the
  // same thing on purpose (the kora#270 collapse), so this must be genuinely
  // absent rather than falsy.
  const dialMaxHeight =
    fontScale > HEADER_SCROLLS_ABOVE_FONT_SCALE
      ? undefined
      : windowHeight * STICKY_DIAL_HEIGHT_SHARE;

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
          {plan ? (
            <>
              <PlanDial kcal={plan.kcal} maxHeight={dialMaxHeight} />
              <Numeral size={36} weight="800">
                {String(Math.round(plan.kcal))}
              </Numeral>
              <AppText
                variant="caption"
                muted
                style={{ textTransform: "uppercase", letterSpacing: 1.4 }}
              >
                kcal / day
              </AppText>
              <PlanDelta kcal={plan.kcal} floored={plan.floored} revision={revision} />
            </>
          ) : (
            // Plain language in the dial's place: no needle or numeral until
            // there is a plan the user's own values produce.
            <AppText
              testID="plan-missing"
              variant="headline"
              style={{ textAlign: "center", paddingVertical: spacing.lg }}
            >
              {`Set your ${listOf(missing)}`}
            </AppText>
          )}
        </View>
      }
      footer={
        <Button
          testID="see-plan-button"
          title={isEdit ? "Update plan" : "See my plan"}
          icon="arrow-right"
          iconPosition="trailing"
          onPress={onSeePlan}
          // Button already turns `disabled` into accessibilityState for
          // assistive tech; the header says what is still missing.
          disabled={input === null}
        />
      }
    >
      <Overline>Your goal</Overline>
      <TickRuler
        mode="detented"
        index={goalIndex}
        restIndex={GOAL_REST}
        labels={GOAL_LABELS}
        onChange={onGoalChange}
        accessibilityLabel="Goal"
        testID="goal-ruler"
      />
      {goalIndex !== null ? (
        <AppText variant="footnote" muted>
          {GOAL_CAPTIONS[goalIndex]}
        </AppText>
      ) : null}

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
            restValue={AGE_REST}
            min={AGE_MIN}
            max={AGE_MAX}
            step={1}
            unit="years"
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
              value={heightCm === null ? null : Math.round(heightCm / CM_PER_IN)}
              restValue={Math.round(HEIGHT_CM_REST / CM_PER_IN)}
              min={HEIGHT_IN_MIN}
              max={HEIGHT_IN_MAX}
              step={1}
              onChange={onHeightChange}
              // formatFtIn already spells the unit into the value (5'7"), so
              // there is no `unit` suffix here.
              formatLabel={formatFtIn}
              accessibilityLabel="Height"
              testID="height-ruler"
            />
          ) : (
            <TickRuler
              mode="continuous"
              value={heightCm}
              restValue={HEIGHT_CM_REST}
              min={HEIGHT_CM_MIN}
              max={HEIGHT_CM_MAX}
              step={1}
              unit="cm"
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
              value={weightKg === null ? null : Math.round(lbFromKg(weightKg))}
              restValue={Math.round(lbFromKg(WEIGHT_KG_REST))}
              min={WEIGHT_LB_MIN}
              max={WEIGHT_LB_MAX}
              step={1}
              unit="lb"
              onChange={onWeightChange}
              accessibilityLabel="Weight in pounds"
              testID="weight-ruler"
            />
          ) : (
            <TickRuler
              mode="continuous"
              value={weightKg}
              restValue={WEIGHT_KG_REST}
              min={WEIGHT_KG_MIN}
              max={WEIGHT_KG_MAX}
              step={0.5}
              unit="kg"
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
        restIndex={ACTIVITY_REST}
        labels={ACTIVITY_LABELS}
        onChange={onActivityChange}
        accessibilityLabel="Activity level"
        testID="activity-ruler"
      />
      <AppText variant="footnote" muted>
        {activityIndex === null || activityLevel === null
          ? ACTIVITY_UNSET_CAPTION
          : `${ACTIVITY_CAPTIONS[activityIndex]} · ×${ACTIVITY_FACTORS[activityLevel]}`}
      </AppText>

      {hasDestination && goalWeightRestKg !== null ? (
        <>
          <Overline style={{ marginTop: spacing.sm }}>Destination</Overline>
          {system === "imperial" ? (
            <TickRuler
              mode="continuous"
              value={chosenGoalWeightKg === null ? null : Math.round(lbFromKg(chosenGoalWeightKg))}
              restValue={Math.round(lbFromKg(goalWeightRestKg))}
              min={WEIGHT_LB_MIN}
              max={WEIGHT_LB_MAX}
              step={1}
              unit="lb"
              onChange={onGoalWeightChange}
              accessibilityLabel="Goal weight in pounds"
              testID="goal-weight-ruler"
            />
          ) : (
            <TickRuler
              mode="continuous"
              value={chosenGoalWeightKg}
              restValue={goalWeightRestKg}
              min={WEIGHT_KG_MIN}
              max={WEIGHT_KG_MAX}
              step={0.5}
              unit="kg"
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
            restIndex={Math.min(PACE_REST, paces.length - 1)}
            labels={paces.map((p) => `${p} kg/wk`)}
            onChange={onPaceChange}
            accessibilityLabel="Pace"
            testID="pace-ruler"
          />
          {weeks !== null ? (
            <AppText testID="destination-caption" variant="footnote" muted>
              {weeks > 0 ? `${weeks} weeks to goal` : "You're already there"}
            </AppText>
          ) : null}
        </>
      ) : null}

      {plan ? (
        <>
          <DerivationChain rows={derivationRows} />

          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <View style={{ alignItems: "center" }}>
              <AppText variant="footnote" muted>
                Protein
              </AppText>
              <Numeral>{`${Math.round(plan.proteinG)}g`}</Numeral>
            </View>
            <View style={{ alignItems: "center" }}>
              <AppText variant="footnote" muted>
                Carbs
              </AppText>
              <Numeral>{`${Math.round(plan.carbsG)}g`}</Numeral>
            </View>
            <View style={{ alignItems: "center" }}>
              <AppText variant="footnote" muted>
                Fat
              </AppText>
              <Numeral>{`${Math.round(plan.fatG)}g`}</Numeral>
            </View>
          </View>
        </>
      ) : null}

      <AppText variant="footnote" muted style={{ textAlign: "center" }}>
        Kora gives general nutrition information, not medical advice. For medical concerns, talk to
        a healthcare professional.
      </AppText>
    </AuthScaffold>
  );
}
