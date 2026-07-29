import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Overline } from "@/components/Overline";
import { GroupedSection, Row } from "@/components/GroupedList";
import { Segmented } from "@/components/Segmented";
import { Card } from "@/components/Card";
import { AppBackground } from "@/components/AppBackground";
import { useSubmitOnboarding } from "@/api/hooks";
import type { OnboardingInput } from "@/api/types";
import { useTheme } from "@/theme";
import { validateOnboardingNumbers } from "@/lib/validateOnboarding";
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

const ACTIVITY_OPTIONS: Array<{ key: OnboardingInput["activity_level"]; label: string }> = [
  { key: "sedentary", label: "Sedentary" },
  { key: "light", label: "Light" },
  { key: "moderate", label: "Moderate" },
  { key: "active", label: "Active" },
  { key: "very_active", label: "Very active" },
];

export default function Onboarding() {
  const { colors, spacing, fontSize } = useTheme();
  const insets = useSafeAreaInsets();
  const submit = useSubmitOnboarding();
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

  const filledInputStyle = {
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    color: colors.label,
    fontSize: fontSize.base,
    minHeight: 48,
  } as const;

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
      onError: () => setError("Please check your details and try again."),
    });
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: spacing.lg,
          paddingTop: insets.top + spacing.lg,
          paddingBottom: spacing["2xl"],
          gap: spacing.md,
        }}
      >
        <Overline>Getting started</Overline>
        <AppText variant="title1">
          Snap it.{"\n"}Otto tracks it.
        </AppText>
        <AppText muted style={{ marginBottom: spacing.xs }}>
          Photo or chat — log meals in seconds and let AI handle the calories and macros.
        </AppText>

        <GroupedSection header="What's your goal?" elevated>
          {GOALS.map((g) => (
            <Row
              key={g.id}
              title={g.title}
              subtitle={g.sub}
              icon={{ name: g.icon, tint: colors.accent }}
              onPress={() => setGoal(g.id)}
              right={goal === g.id ? <Icon name="check" size={18} color={colors.accent} /> : undefined}
            />
          ))}
        </GroupedSection>

        <Overline style={{ marginTop: spacing.xs }}>About you</Overline>
        <Segmented options={SEX_OPTIONS} value={sex} onChange={(key) => setSex(key as OnboardingInput["sex"])} />

        <View style={{ gap: spacing.sm }}>
          <Card variant="elevated" style={{ padding: 0 }}>
            <TextInput
              accessibilityLabel="Birth year"
              style={filledInputStyle}
              placeholder="Birth year (e.g. 1995)"
              placeholderTextColor={colors.secondaryLabel}
              keyboardType="number-pad"
              value={birthYear}
              onChangeText={setBirthYear}
            />
          </Card>
          {system === "imperial" ? (
            <View style={{ flexDirection: "row", gap: spacing.sm }}>
              <Card variant="elevated" style={{ padding: 0, flex: 1 }}>
                <TextInput
                  accessibilityLabel="Height in feet"
                  style={filledInputStyle}
                  placeholder="Height (ft)"
                  placeholderTextColor={colors.secondaryLabel}
                  keyboardType="number-pad"
                  value={heightFt}
                  onChangeText={setHeightFt}
                />
              </Card>
              <Card variant="elevated" style={{ padding: 0, flex: 1 }}>
                <TextInput
                  accessibilityLabel="Height in inches"
                  style={filledInputStyle}
                  placeholder="Height (in)"
                  placeholderTextColor={colors.secondaryLabel}
                  keyboardType="number-pad"
                  value={heightIn}
                  onChangeText={setHeightIn}
                />
              </Card>
            </View>
          ) : (
            <Card variant="elevated" style={{ padding: 0 }}>
              <TextInput
                accessibilityLabel="Height in centimetres"
                style={filledInputStyle}
                placeholder="Height (cm)"
                placeholderTextColor={colors.secondaryLabel}
                keyboardType="decimal-pad"
                value={heightCm}
                onChangeText={setHeightCm}
              />
            </Card>
          )}
          <Card variant="elevated" style={{ padding: 0 }}>
            <TextInput
              accessibilityLabel={system === "imperial" ? "Weight in pounds" : "Weight in kilograms"}
              style={filledInputStyle}
              placeholder={system === "imperial" ? "Weight (lb)" : "Weight (kg)"}
              placeholderTextColor={colors.secondaryLabel}
              keyboardType="decimal-pad"
              value={weightText}
              onChangeText={setWeightText}
            />
          </Card>
        </View>

        <Overline style={{ marginTop: spacing.xs }}>Activity</Overline>
        <Segmented
          options={ACTIVITY_OPTIONS}
          value={activity}
          onChange={(key) => setActivity(key as OnboardingInput["activity_level"])}
        />

        {error ? (
          <AppText variant="footnote" style={{ color: colors.destructive }}>
            {error}
          </AppText>
        ) : null}
        <AppText variant="footnote" muted style={{ textAlign: "center" }}>
          Kora gives general nutrition information, not medical advice. For medical concerns, talk
          to a healthcare professional.
        </AppText>
        <Button title={submit.isPending ? "Saving…" : "Get started"} onPress={onSubmit} disabled={submit.isPending} />
      </ScrollView>
    </View>
  );
}
