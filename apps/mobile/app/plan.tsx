import { useEffect, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { safeBack } from "@/lib/safeBack";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Numeral } from "@/components/Numeral";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { BezelCluster, ZoneRule } from "@/components/instrument/BezelCluster";
import {
  DerivationChain,
  type DerivationRow,
} from "@/components/instrument/DerivationChain";
import { engravedStyle, monoStyle } from "@/components/instrument/typography";
import { GroupedSection, Row } from "@/components/GroupedList";
import { PressableScale, haptics } from "@/motion";
import {
  usePlan,
  useProfile,
  useSavePlan,
  useSubmitOnboarding,
} from "@/api/hooks";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { computePlan, type OverrideCode } from "@/lib/plan";
import {
  draftFromParams,
  draftToParams,
  type PlanDraft,
} from "@/lib/planDraft";
import { useTheme } from "@/theme";

const OVERRIDE_COPY: Record<OverrideCode, string> = {
  kcal_below_resting_burn:
    "That's below your resting burn. Kora won't set a target under it.",
  kcal_above_ceiling: "That's more than double your daily burn.",
  protein_below_min: "That's below the minimum protein for your weight.",
  protein_above_max: "That's above 2.5 g per kg, more than your body can use.",
  protein_exceeds_share:
    "That leaves no room for fat and carbs at this calorie target.",
};

// Mirrors calc.go's 1% of bodyweight pace cap, for the input_error fallback.
// input_error itself is a developer string ("onboarding: pace_kg_per_week ..."),
// so the page shows its own copy rather than the server's text.
const MAX_PACE_FRACTION_OF_BODYWEIGHT = 0.01;

// A field being typed into: blank means "no override", never NaN.
function parseOverride(text: string): number | null {
  return text.trim() === "" ? null : Number(text);
}

type Field = "kcal" | "protein";

export default function PlanScreen() {
  const { instrument, spacing, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const paramDraft = draftFromParams(params);
  const plan = usePlan({ enabled: paramDraft === null });
  const profile = useProfile();
  const submit = useSubmitOnboarding();
  const save = useSavePlan();

  // undefined until the user types, so the source's override shows through.
  const [kcalText, setKcalText] = useState<string | undefined>();
  const [proteinText, setProteinText] = useState<string | undefined>();
  const [editing, setEditing] = useState<Field | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const missingOnboardingDraft =
    params.mode === "onboarding" && paramDraft === null;
  useEffect(() => {
    if (missingOnboardingDraft) router.replace("/onboarding");
  }, [missingOnboardingDraft]);

  const fromServer = paramDraft === null;
  // Round-tripped through the params codec so the server's null fields become absent ones.
  const draft =
    paramDraft ??
    (plan.data
      ? draftFromParams(draftToParams(plan.data.inputs as PlanDraft))
      : null);
  // input_error describes the stored destination; a draft from params replaced it.
  const inputError = fromServer ? (plan.data?.input_error ?? null) : null;
  // The profile alone decides POST or PUT: params.mode only says where the
  // draft came from, and an edit round-trip during onboarding comes back as
  // mode=edit for a user who still has to POST.
  const isOnboarding = profile.data !== undefined && !profile.data.onboarded_at;

  if (!draft) {
    return (
      <View style={{ flex: 1, backgroundColor: instrument.bg }}>
        <AppBackground />
        <View style={{ paddingTop: insets.top + 8 }}>
          <ScreenHeader
            overline="Your plan"
            title="Plan"
            onBack={() => safeBack("/profile")}
          />
          {plan.error ? (
            <AppText
              accessibilityRole="alert"
              style={{
                color: instrument.danger,
                fontSize: 13,
                paddingHorizontal: 20,
              }}
            >
              {apiErrorMessage(plan.error)}
            </AppText>
          ) : null}
        </View>
      </View>
    );
  }

  const kcalOverride =
    kcalText === undefined
      ? (draft.target_kcal_override ?? null)
      : parseOverride(kcalText);
  const proteinOverride =
    proteinText === undefined
      ? (draft.target_protein_override_g ?? null)
      : parseOverride(proteinText);

  // With input_error the server computes without the destination; so does this.
  const goalWeightKg = inputError ? undefined : draft.goal_weight_kg;
  const pace = draft.pace_kg_per_week ?? 0;
  const result = computePlan({
    sex: draft.sex,
    age: new Date().getFullYear() - draft.birth_year,
    heightCm: draft.height_cm,
    weightKg: draft.weight_kg,
    activityLevel: draft.activity_level,
    goal: draft.goal,
    paceKgPerWeek: inputError
      ? Math.min(pace, draft.weight_kg * MAX_PACE_FRACTION_OF_BODYWEIGHT)
      : pace,
    goalWeightKg,
    kcalOverride,
    proteinOverrideG: proteinOverride,
  });

  const {
    target_kcal_override: _k,
    target_protein_override_g: _p,
    ...inputs
  } = draft;
  const payload: PlanDraft = {
    ...inputs,
    ...(kcalOverride !== null ? { target_kcal_override: kcalOverride } : {}),
    ...(proteinOverride !== null
      ? { target_protein_override_g: proteinOverride }
      : {}),
  };

  const pending = submit.isPending || save.isPending;
  // Until the profile loads the page can't tell POST from PUT, and a POST for
  // an onboarded user would reset onboarded_at.
  const profileUnknown = profile.data === undefined;
  const blocked =
    pending ||
    profileUnknown ||
    result.overrideError !== null ||
    inputError !== null;

  function onPrimary() {
    if (blocked) return;
    setSubmitError(null);
    setEditing(null);
    const onError = (e: unknown) => setSubmitError(apiErrorMessage(e));
    if (isOnboarding) {
      submit.mutate(payload, {
        onSuccess: () => {
          haptics.success();
          router.replace("/");
        },
        onError,
      });
    } else {
      save.mutate(payload, { onSuccess: () => safeBack("/profile"), onError });
    }
  }

  function clearOverride(field: Field) {
    (field === "kcal" ? setKcalText : setProteinText)("");
    setEditing(null);
  }

  const mono = monoStyle(fonts);
  const engraved = engravedStyle(instrument);

  // The figure, or the inline field while it is being typed into.
  function figure(field: Field, value: number, unit: string, size: number) {
    const text = field === "kcal" ? kcalText : proteinText;
    const override = field === "kcal" ? kcalOverride : proteinOverride;
    if (editing === field) {
      return (
        <TextInput
          testID={`${field}-input`}
          autoFocus
          keyboardType="number-pad"
          returnKeyType="done"
          value={text ?? (override === null ? "" : String(override))}
          onChangeText={field === "kcal" ? setKcalText : setProteinText}
          onBlur={() => setEditing(null)}
          onSubmitEditing={() => setEditing(null)}
          placeholder={String(Math.round(value))}
          placeholderTextColor={instrument.mut}
          accessibilityLabel={
            field === "kcal"
              ? "Your calorie target"
              : "Your protein target in grams"
          }
          style={[
            mono,
            {
              fontSize: size,
              fontWeight: "700",
              color: instrument.ink,
              minWidth: 80,
              textAlign: "center",
            },
          ]}
        />
      );
    }
    return (
      <PressableScale
        testID={`${field}-value`}
        accessibilityRole="button"
        accessibilityHint="Type your own number"
        haptic="none"
        onPress={() => setEditing(field)}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Numeral
          size={size}
          weight={size > 20 ? "800" : "700"}
        >{`${Math.round(value)}${unit}`}</Numeral>
      </PressableScale>
    );
  }

  // "Your number · Use Kora's" while an override is set (valid or flagged), else Kora's basis.
  function basis(field: Field, korasBasis: string) {
    const overridden =
      (field === "kcal" ? kcalOverride : proteinOverride) !== null;
    return (
      <View style={{ alignItems: "center" }}>
        <AppText testID={`${field}-basis`} variant="caption" muted>
          {overridden ? "Your number" : korasBasis}
        </AppText>
        {overridden ? (
          <PressableScale
            testID={`use-kora-${field}`}
            accessibilityRole="button"
            haptic="none"
            onPress={() => clearOverride(field)}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <AppText
              style={{ fontSize: 13, fontWeight: "600", color: instrument.ink }}
            >
              Use Kora&apos;s
            </AppText>
          </PressableScale>
        ) : null}
      </View>
    );
  }

  const derivationRows: DerivationRow[] = [
    { label: "Resting burn", value: `${Math.round(result.bmr)} kcal` },
    { label: "Activity-adjusted", value: `${Math.round(result.tdee)} kcal` },
    {
      label: "Goal adjustment",
      value: `${result.adjustment >= 0 ? "+" : "−"}${Math.abs(Math.round(result.adjustment))} kcal`,
    },
    // The user's number is not the sum of Kora's working above it.
    {
      label: result.kcalOverridden ? "Your target" : "Daily target",
      value: `${Math.round(result.kcal)} kcal`,
    },
  ];
  const proteinBasis = `${result.proteinGPerKg} g/kg ${draft.goal === "fat_loss" && goalWeightKg ? "goal wt" : "body wt"}`;
  const errorText = { color: instrument.danger, fontSize: 13 } as const;

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingTop: insets.top + 8,
          paddingBottom: insets.bottom + 40,
        }}
      >
        <ScreenHeader
          overline="Your plan"
          title="Plan"
          onBack={() => safeBack("/profile")}
        />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          <BezelCluster radius={25} testID="plan-cluster">
            <View style={{ padding: spacing.md, gap: spacing.sm }}>
              <View style={{ alignItems: "center" }}>
                <AppText style={engraved}>Calories</AppText>
                {figure("kcal", result.kcal, "", 40)}
                <AppText
                  variant="caption"
                  muted
                  style={{ textTransform: "uppercase", letterSpacing: 1.4 }}
                >
                  kcal / day
                </AppText>
                {basis("kcal", "Kora's calculation")}
              </View>
              {result.floored ? (
                <AppText
                  variant="footnote"
                  muted
                  style={{ textAlign: "center" }}
                >
                  Kept at your resting burn — Kora won&apos;t go lower.
                </AppText>
              ) : null}
              <DerivationChain rows={derivationRows} />
            </View>
            <ZoneRule label="Macros" />
            <View style={{ padding: spacing.md, gap: spacing.sm }}>
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                }}
              >
                <View style={{ flex: 1, alignItems: "center" }}>
                  <AppText style={engraved}>Protein</AppText>
                  {figure("protein", result.proteinG, "g", 20)}
                  {basis("protein", proteinBasis)}
                </View>
                <View style={{ flex: 1, alignItems: "center" }}>
                  <AppText style={engraved}>Carbs</AppText>
                  <View style={{ minHeight: 44, justifyContent: "center" }}>
                    <Numeral
                      testID="carbs-value"
                      size={20}
                    >{`${Math.round(result.carbsG)}g`}</Numeral>
                  </View>
                  <AppText testID="carbs-basis" variant="caption" muted>
                    the rest
                  </AppText>
                </View>
                <View style={{ flex: 1, alignItems: "center" }}>
                  <AppText style={engraved}>Fat</AppText>
                  <View style={{ minHeight: 44, justifyContent: "center" }}>
                    <Numeral
                      testID="fat-value"
                      size={20}
                    >{`${Math.round(result.fatG)}g`}</Numeral>
                  </View>
                  <AppText testID="fat-basis" variant="caption" muted>
                    25%
                  </AppText>
                </View>
              </View>
              {result.overrideError ? (
                <AppText
                  testID="override-error"
                  accessibilityLiveRegion="polite"
                  style={[errorText, { textAlign: "center" }]}
                >
                  {OVERRIDE_COPY[result.overrideError]}
                </AppText>
              ) : (
                <AppText
                  variant="footnote"
                  muted
                  style={{ textAlign: "center" }}
                >
                  Tap calories or protein to type your own.
                </AppText>
              )}
            </View>
          </BezelCluster>

          <View style={{ gap: spacing.xs }}>
            <GroupedSection>
              <Row
                title="Body, activity & goal"
                chevron
                onPress={() =>
                  router.push({
                    pathname: "/onboarding",
                    params: { ...draftToParams(payload), mode: "edit" },
                  })
                }
              />
            </GroupedSection>
            {inputError ? (
              <AppText
                testID="input-error"
                accessibilityRole="alert"
                style={[errorText, { marginLeft: spacing.md }]}
              >
                Your latest weigh-in no longer fits your goal weight or pace.
                Update them in Body, activity &amp; goal.
              </AppText>
            ) : null}
          </View>

          {profile.error && profileUnknown ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <AppText
                testID="profile-error"
                accessibilityRole="alert"
                style={errorText}
              >
                Couldn&apos;t load your profile.
              </AppText>
              <PressableScale
                accessibilityRole="button"
                haptic="none"
                onPress={() => profile.refetch()}
                style={{
                  minHeight: 44,
                  justifyContent: "center",
                  paddingHorizontal: spacing.sm,
                }}
              >
                <AppText
                  style={{
                    fontSize: 13,
                    fontWeight: "600",
                    color: instrument.ink,
                  }}
                >
                  Try again
                </AppText>
              </PressableScale>
            </View>
          ) : null}
          {submitError ? (
            <AppText
              testID="submit-error"
              accessibilityRole="alert"
              style={errorText}
            >
              {submitError}
            </AppText>
          ) : null}
          <Button
            testID="plan-primary"
            title={isOnboarding ? "Start with this plan" : "Save"}
            onPress={onPrimary}
            disabled={blocked}
          />
          {profile.data && !isOnboarding && !profile.data.plan_saved_at ? (
            <AppText
              testID="plan-unsaved"
              variant="footnote"
              muted
              style={{ textAlign: "center" }}
            >
              Kora&apos;s current calculation. Save to make it your plan.
            </AppText>
          ) : null}

          <AppText variant="footnote" muted style={{ textAlign: "center" }}>
            Kora gives general nutrition information, not medical advice. For
            medical concerns, talk to a healthcare professional.
          </AppText>
        </View>
      </ScrollView>
    </View>
  );
}
