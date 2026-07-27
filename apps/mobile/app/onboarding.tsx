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
  const [weightKg, setWeightKg] = useState("");
  const [error, setError] = useState<string | null>(null);

  const filledInputStyle = {
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    color: colors.label,
    fontSize: fontSize.base,
    minHeight: 48,
  } as const;

  function onSubmit() {
    setError(null);
    const validationError = validateOnboardingNumbers(birthYear, heightCm, weightKg);
    if (validationError) {
      setError(validationError);
      return;
    }
    const input: OnboardingInput = {
      sex,
      goal,
      activity_level: activity,
      birth_year: Number(birthYear),
      height_cm: Number(heightCm),
      weight_kg: Number(weightKg),
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
          <Card variant="elevated" style={{ padding: 0 }}>
            <TextInput
              accessibilityLabel="Weight in kilograms"
              style={filledInputStyle}
              placeholder="Weight (kg)"
              placeholderTextColor={colors.secondaryLabel}
              keyboardType="decimal-pad"
              value={weightKg}
              onChangeText={setWeightKg}
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
        <Button title={submit.isPending ? "Saving…" : "Get started"} onPress={onSubmit} disabled={submit.isPending} />
      </ScrollView>
    </View>
  );
}
