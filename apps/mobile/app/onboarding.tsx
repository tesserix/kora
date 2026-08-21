import { useMemo, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
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
import { useSubmitOnboarding } from "@/api/hooks";
import type { OnboardingInput } from "@/api/types";
import { useTheme } from "@/theme";
import { validateGoalWeight, validateOnboardingNumbers } from "@/lib/validateOnboarding";
import { deriveGoalWeightKg } from "@/lib/goalWeightDefault";
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
  const submit = useSubmitOnboarding();
  const { system } = useUnits();
  const { fontScale, height: windowHeight } = useWindowDimensions();
  const health = useActivityHistory();

  const [goalIndex, setGoalIndex] = useState(0);
  const [sex, setSex] = useState<OnboardingInput["sex"]>("male");
  const [activityIndex, setActivityIndex] = useState(2);
  const [age, setAge] = useState(30);
  const [heightCm, setHeightCm] = useState(170);
  const [weightKg, setWeightKg] = useState(70);
  // `null` IS the "has the user set a destination yet" flag, held as one piece
  // of state rather than a boolean beside a number so the two can never
  // disagree: there is no representable state where the flag says "user set"
  // but the value is stale, or vice versa. Purely a DEFAULTING mechanism — it
  // gates nothing, withholds nothing, and never reaches the payload.
  const [chosenGoalWeightKg, setChosenGoalWeightKg] = useState<number | null>(null);
  const [paceIndex, setPaceIndex] = useState(1);
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

  const goal = GOAL_IDS[goalIndex];
  const activityLevel = ACTIVITY_IDS[activityIndex];
  // Clamp the derived destination against the range of the ruler actually on
  // screen. The imperial weight ruler is 80-400 lb, which is not the metric
  // ruler's 30-200 kg, so deriving against the metric bounds in imperial mode
  // could place the destination off the end of the scale the user is reading.
  const weightRangeKg =
    system === "imperial"
      ? { min: kgFromLb(WEIGHT_LB_MIN), max: kgFromLb(WEIGHT_LB_MAX) }
      : { min: WEIGHT_KG_MIN, max: WEIGHT_KG_MAX };
  // Until the user moves the destination ruler it tracks their goal and their
  // current weight, so the value on display can never be the contradiction
  // `validateGoalWeight` would refuse at submit — the failure that removing
  // the untouched-destination validation skip would otherwise have created for
  // anyone whose first action is picking "Build muscle". Once they have moved
  // it their number stands: recomputing it under them would be a worse bug
  // than the incoherent default it replaced.
  const goalWeightKg =
    chosenGoalWeightKg ?? deriveGoalWeightKg(goal, weightKg, weightRangeKg.min, weightRangeKg.max);
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

  // kora#164: the rulers arrive carrying real, sensible defaults (30 / 170cm
  // / 70kg / 65kg) and — since kora#165 — those numbers are legible on the
  // face of each control. A screen that displays a value and then refuses to
  // accept it until you have jogged the control is not asking for consent, it
  // is demanding a ritual, and it blocked first run outright. So the
  // displayed values ARE the accepted values: the plan they imply is shown
  // from the first frame, the accept button is live from the first frame, and
  // the payload carries exactly what the rulers say.
  //
  // The old `touched` set is gone entirely rather than kept for preview
  // gating. Keeping it would have left the screen in a strictly worse state
  // than either of its endpoints: the button would be live while the dial,
  // derivation chain and macro trio still read "—", so a user could accept a
  // plan they had never been shown. The gating existed to stop the screen
  // presenting a target derived from values the user had not chosen — a
  // premise this change deliberately reverses.
  const dialKcal = plan.kcal;
  // The destination (goal weight + pace) is meaningless while maintaining and
  // is omitted from the payload then — but for every other goal it is now
  // always sent, touched or not. That is what keeps screen and server in
  // agreement: the dial is computed from the visible pace stop, so omitting
  // pace_kg_per_week would let the server decode Go's zero value and collapse
  // the deficit to plain TDEE behind a target the user had already accepted.
  const hasDestination = goal !== "maintenance";

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
    bump();
  }
  function onHeightChange(value: number) {
    setHeightCm(system === "imperial" ? value * CM_PER_IN : value);
    bump();
  }
  function onWeightChange(value: number) {
    setWeightKg(system === "imperial" ? kgFromLb(value) : value);
    bump();
  }
  function onGoalWeightChange(value: number) {
    // The first move is also the moment deriving stops, for good.
    setChosenGoalWeightKg(system === "imperial" ? kgFromLb(value) : value);
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
    // These are always real numbers straight off the rulers — never the empty
    // strings a text field could hand over — so this guard is a range check on
    // values the user can see, not a fill-in-the-blanks check. It stays
    // because a ruler range and a validator range can drift apart.
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
    // Now that the destination is always sent for a non-maintenance goal it
    // is always validated too: a default 65kg goal under "Build muscle" at
    // 70kg current is a contradiction the user can see on screen, and it must
    // be caught in the field rather than stored.
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
      // The destination has no meaning while maintaining, so it is omitted
      // entirely rather than sent as a value the goal cannot use.
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

  // Every row is the arithmetic behind the number on the dial, for the values
  // currently on the rulers. Shown unconditionally: the user is being asked to
  // accept this plan, so they get to see how it was reached before they press
  // the button (kora#164).
  const derivationRows: DerivationRow[] = [
    { label: "Resting burn", value: `${Math.round(plan.bmr)} kcal` },
    { label: "Activity-adjusted", value: `${Math.round(plan.tdee)} kcal` },
    {
      label: "Goal adjustment",
      value: `${plan.adjustment >= 0 ? "+" : "−"}${Math.abs(Math.round(plan.adjustment))} kcal`,
    },
    { label: "Daily target", value: `${Math.round(plan.kcal)} kcal` },
  ];

  const weeks = hasDestination ? weeksToGoal(weightKg, goalWeightKg, paceKgPerWeek) : 0;

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
          <PlanDial kcal={dialKcal} maxHeight={dialMaxHeight} />
          <Numeral size={36} weight="800">
            {String(Math.round(plan.kcal))}
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
            // The only gate left (kora#164): a second press while the first
            // submit is still in flight would onboard the account twice.
            // Button already turns `disabled` into accessibilityState for
            // assistive tech.
            disabled={submit.isPending}
          />
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
              value={Math.round(heightCm / CM_PER_IN)}
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
              value={Math.round(lbFromKg(weightKg))}
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
              unit="lb"
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
            labels={paces.map((p) => `${p} kg/wk`)}
            onChange={onPaceChange}
            accessibilityLabel="Pace"
            testID="pace-ruler"
          />
          <AppText testID="destination-caption" variant="footnote" muted>
            {weeks > 0 ? `${weeks} weeks to goal` : "You're already there"}
          </AppText>
        </>
      ) : null}

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

      <AppText variant="footnote" muted style={{ textAlign: "center" }}>
        Kora gives general nutrition information, not medical advice. For medical concerns, talk
        to a healthcare professional.
      </AppText>
    </AuthScaffold>
  );
}
