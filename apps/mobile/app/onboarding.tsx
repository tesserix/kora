import { useEffect, useState } from "react";
import { BackHandler, View } from "react-native";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Overline } from "@/components/Overline";
import { Segmented } from "@/components/Segmented";
import { Field } from "@/components/Field";
import { BrandLockup } from "@/components/BrandLockup";
import { SelectableCard } from "@/components/SelectableCard";
import { AuthScaffold } from "@/components/AuthScaffold";
import { ActivityFromHealth } from "@/components/ActivityFromHealth";
import { useActivityHistory } from "@/health/useActivityHistory";
import { useSubmitOnboarding } from "@/api/hooks";
import type { OnboardingInput } from "@/api/types";
import { useTheme } from "@/theme";
import { validateOnboardingNumbers } from "@/lib/validateOnboarding";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { haptics } from "@/motion";
import { cmFromFtIn, kgFromLb, useUnits } from "@/units";

const GOALS: Array<{ id: OnboardingInput["goal"]; icon: string; title: string; sub: string }> = [
  { id: "fat_loss", icon: "trending-down", title: "Lose weight", sub: "Gentle calorie deficit" },
  { id: "maintenance", icon: "minus", title: "Maintain", sub: "Stay where you are" },
  { id: "muscle_gain", icon: "trending-up", title: "Build muscle", sub: "Lean surplus + protein" },
];

const SEX_OPTIONS: Array<{ key: OnboardingInput["sex"]; label: string }> = [
  { key: "male", label: "Male" },
  { key: "female", label: "Female" },
];

// Descriptors do double duty: they explain what each level means, and they let
// the levels render as cards instead of a five-way Segmented, which divided its
// width equally and clipped "Sedentary" to "Sedentar/y".
const ACTIVITY_OPTIONS: Array<{
  key: OnboardingInput["activity_level"];
  label: string;
  sub: string;
}> = [
  { key: "sedentary", label: "Sedentary", sub: "Desk job, little walking" },
  { key: "light", label: "Light", sub: "1–2 sessions a week" },
  { key: "moderate", label: "Moderate", sub: "3–5 sessions a week" },
  { key: "active", label: "Active", sub: "6–7 sessions a week" },
  { key: "very_active", label: "Very active", sub: "Physical job or athlete" },
];

// Maps a stored activity_level back to its display label, so the Health
// suggestion names the level using exactly the same words as the cards below it.
function activityLabel(level: OnboardingInput["activity_level"]): string {
  return ACTIVITY_OPTIONS.find((a) => a.key === level)?.label ?? String(level);
}

export default function Onboarding() {
  const { colors, spacing } = useTheme();
  const submit = useSubmitOnboarding();
  const [step, setStep] = useState<1 | 2>(1);
  const [goal, setGoal] = useState<OnboardingInput["goal"]>("fat_loss");
  const [sex, setSex] = useState<OnboardingInput["sex"]>("male");
  const [activity, setActivity] = useState<OnboardingInput["activity_level"]>("moderate");
  const [birthYear, setBirthYear] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [heightFt, setHeightFt] = useState("");
  const [heightIn, setHeightIn] = useState("");
  const [weightText, setWeightText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { system } = useUnits();
  const health = useActivityHistory();

  // Android's hardware back on step 2 must return to step 1, not pop the route —
  // leaving onboarding would discard everything already entered.
  useEffect(() => {
    if (step !== 2) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setStep(1);
      return true; // handled
    });
    return () => sub.remove();
  }, [step]);

  function onSubmit() {
    setError(null);
    // Imperial: a blank ft/in pair converts to "0" (truthy), which would slip
    // past the validator's presence check into a range error. Catch missing raw
    // inputs here so the user sees "Please fill in..." instead.
    if (system === "imperial" && (!birthYear || (!heightFt && !heightIn) || !weightText)) {
      setError("Please fill in your birth year, height, and weight.");
      return;
    }
    const heightCmStr = system === "imperial" ? String(cmFromFtIn(Number(heightFt), Number(heightIn))) : heightCm;
    const weightKgStr = system === "imperial" ? String(kgFromLb(Number(weightText))) : weightText;
    const validationError = validateOnboardingNumbers(
      birthYear,
      heightCmStr,
      weightKgStr,
      system === "imperial" ? { heightUnit: "ft/in", weightUnit: "lb" } : undefined,
    );
    if (validationError) {
      setError(validationError);
      return;
    }
    const input: OnboardingInput = {
      sex,
      goal,
      activity_level: activity,
      birth_year: Number(birthYear),
      height_cm: Number(heightCmStr),
      weight_kg: Number(weightKgStr),
    };
    submit.mutate(input, {
      onSuccess: () => {
        haptics.success();
        router.replace("/");
      },
      // Names the actual cause: a 5xx or an offline phone must not tell the
      // user their details are wrong and send them round a loop.
      onError: (e: unknown) => setError(apiErrorMessage(e)),
    });
  }

  if (step === 1) {
    return (
      <AuthScaffold
        progress={{ step: 1, total: 2 }}
        footer={
          <Button
            title="Continue"
            icon="arrow-right"
            iconPosition="trailing"
            onPress={() => setStep(2)}
          />
        }
      >
        <BrandLockup />
        <AppText variant="title1" style={{ marginTop: spacing.sm }}>
          Snap it.{"\n"}Otto tracks it.
        </AppText>
        <AppText muted>
          Photo or chat — log meals in seconds and let AI handle the calories and macros.
        </AppText>

        <Overline style={{ marginTop: spacing.xs }}>What&apos;s your goal?</Overline>
        <View accessibilityRole="radiogroup" style={{ gap: spacing.sm }}>
          {GOALS.map((g) => (
            <SelectableCard
              key={g.id}
              icon={g.icon}
              title={g.title}
              subtitle={g.sub}
              selected={goal === g.id}
              onPress={() => setGoal(g.id)}
            />
          ))}
        </View>
      </AuthScaffold>
    );
  }

  return (
    <AuthScaffold
      onBack={() => setStep(1)}
      progress={{ step: 2, total: 2 }}
      footer={
        <Button
          title={submit.isPending ? "Saving…" : "Get started"}
          icon="arrow-right"
          iconPosition="trailing"
          onPress={onSubmit}
          disabled={submit.isPending}
        />
      }
    >
      <AppText variant="title1">About you</AppText>

      <Segmented
        options={SEX_OPTIONS}
        value={sex}
        onChange={(key) => setSex(key as OnboardingInput["sex"])}
      />

      <View style={{ gap: spacing.md }}>
        <Field
          label="Birth year"
          placeholder="e.g. 1995"
          keyboardType="number-pad"
          value={birthYear}
          onChangeText={setBirthYear}
        />
        {system === "imperial" ? (
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <View style={{ flex: 1 }}>
              <Field
                label="Height (ft)"
                accessibilityLabel="Height in feet"
                keyboardType="number-pad"
                value={heightFt}
                onChangeText={setHeightFt}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                label="Height (in)"
                accessibilityLabel="Height in inches"
                keyboardType="number-pad"
                value={heightIn}
                onChangeText={setHeightIn}
              />
            </View>
          </View>
        ) : (
          <Field
            label="Height (cm)"
            accessibilityLabel="Height in centimetres"
            keyboardType="decimal-pad"
            value={heightCm}
            onChangeText={setHeightCm}
          />
        )}
        <Field
          label={system === "imperial" ? "Weight (lb)" : "Weight (kg)"}
          accessibilityLabel={system === "imperial" ? "Weight in pounds" : "Weight in kilograms"}
          keyboardType="decimal-pad"
          value={weightText}
          onChangeText={setWeightText}
        />
      </View>

      <Overline style={{ marginTop: spacing.xs }}>Activity</Overline>
      <ActivityFromHealth
        status={health.status}
        inference={health.inference}
        levelLabel={activityLabel}
        onUseHealth={health.request}
        onAccept={setActivity}
      />
      <View accessibilityRole="radiogroup" style={{ gap: spacing.sm }}>
        {ACTIVITY_OPTIONS.map((a) => (
          <SelectableCard
            key={a.key}
            title={a.label}
            subtitle={a.sub}
            selected={activity === a.key}
            onPress={() => setActivity(a.key)}
          />
        ))}
      </View>

      {error ? (
        <AppText
          variant="footnote"
          accessibilityLiveRegion="polite"
          style={{ color: colors.destructive }}
        >
          {error}
        </AppText>
      ) : null}
      <AppText variant="footnote" muted style={{ textAlign: "center" }}>
        Kora gives general nutrition information, not medical advice. For medical concerns, talk
        to a healthcare professional.
      </AppText>
    </AuthScaffold>
  );
}
