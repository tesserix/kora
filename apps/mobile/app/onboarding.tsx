import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { useSubmitOnboarding } from "@/api/hooks";
import type { OnboardingInput } from "@/api/types";
import { useTheme } from "@/theme";

const GOALS: OnboardingInput["goal"][] = ["fat_loss", "maintenance", "muscle_gain"];
const ACTIVITIES: OnboardingInput["activity_level"][] = ["sedentary", "light", "moderate", "active", "very_active"];

export default function Onboarding() {
  const { colors, spacing, radius } = useTheme();
  const submit = useSubmitOnboarding();
  const [goal, setGoal] = useState<OnboardingInput["goal"]>("maintenance");
  const [sex, setSex] = useState<OnboardingInput["sex"]>("male");
  const [activity, setActivity] = useState<OnboardingInput["activity_level"]>("moderate");
  const [birthYear, setBirthYear] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [error, setError] = useState<string | null>(null);

  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.input,
    borderRadius: radius.lg,
    padding: spacing.md,
    color: colors.foreground,
    minHeight: 48,
  } as const;

  function onSubmit() {
    setError(null);
    const input: OnboardingInput = {
      sex,
      goal,
      activity_level: activity,
      birth_year: Number(birthYear),
      height_cm: Number(heightCm),
      weight_kg: Number(weightKg),
    };
    submit.mutate(input, {
      onSuccess: () => router.replace("/"),
      onError: () => setError("Please check your details and try again."),
    });
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
      <AppText variant="h1">Set your goal</AppText>

      <AppText variant="h3">Goal</AppText>
      <View style={{ gap: spacing.sm }}>
        {GOALS.map((g) => (
          <Button key={g} title={g.replace("_", " ")} variant={goal === g ? "primary" : "secondary"} onPress={() => setGoal(g)} />
        ))}
      </View>

      <AppText variant="h3">Sex</AppText>
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <View style={{ flex: 1 }}><Button title="Male" variant={sex === "male" ? "primary" : "secondary"} onPress={() => setSex("male")} /></View>
        <View style={{ flex: 1 }}><Button title="Female" variant={sex === "female" ? "primary" : "secondary"} onPress={() => setSex("female")} /></View>
      </View>

      <TextInput style={inputStyle} placeholder="Birth year (e.g. 1995)" placeholderTextColor={colors.mutedForeground} keyboardType="number-pad" value={birthYear} onChangeText={setBirthYear} />
      <TextInput style={inputStyle} placeholder="Height (cm)" placeholderTextColor={colors.mutedForeground} keyboardType="decimal-pad" value={heightCm} onChangeText={setHeightCm} />
      <TextInput style={inputStyle} placeholder="Weight (kg)" placeholderTextColor={colors.mutedForeground} keyboardType="decimal-pad" value={weightKg} onChangeText={setWeightKg} />

      <AppText variant="h3">Activity</AppText>
      <View style={{ gap: spacing.sm }}>
        {ACTIVITIES.map((a) => (
          <Button key={a} title={a.replace("_", " ")} variant={activity === a ? "primary" : "secondary"} onPress={() => setActivity(a)} />
        ))}
      </View>

      {error ? <AppText style={{ color: colors.destructive }}>{error}</AppText> : null}
      <Button title={submit.isPending ? "Saving…" : "Continue"} onPress={onSubmit} disabled={submit.isPending} />
    </ScrollView>
  );
}
