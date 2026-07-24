import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Overline } from "@/components/Overline";
import { useSubmitOnboarding } from "@/api/hooks";
import type { OnboardingInput } from "@/api/types";
import { useTheme } from "@/theme";
import { validateOnboardingNumbers } from "@/lib/validateOnboarding";

const GOALS: Array<{ id: OnboardingInput["goal"]; icon: string; title: string; sub: string }> = [
  { id: "fat_loss", icon: "trending-down", title: "Lose weight", sub: "Gentle calorie deficit" },
  { id: "maintenance", icon: "minus", title: "Maintain", sub: "Stay where you are" },
  { id: "muscle_gain", icon: "trending-up", title: "Build muscle", sub: "Lean surplus + protein" },
];
const ACTIVITIES: OnboardingInput["activity_level"][] = ["sedentary", "light", "moderate", "active", "very_active"];

export default function Onboarding() {
  const { colors, radius, spacing, shadows } = useTheme();
  const submit = useSubmitOnboarding();
  const [goal, setGoal] = useState<OnboardingInput["goal"]>("fat_loss");
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
      onSuccess: () => router.replace("/"),
      onError: () => setError("Please check your details and try again."),
    });
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ padding: 24, paddingTop: 40, gap: spacing.md }}
    >
      {/* brand */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <View
          style={[
            {
              width: 40,
              height: 40,
              borderRadius: radius.lg,
              backgroundColor: colors.primary,
              alignItems: "center",
              justifyContent: "center",
            },
            shadows.md,
          ]}
        >
          <Icon name="sparkles" size={22} color={colors.primaryForeground} />
        </View>
        <AppText style={{ fontSize: 20, fontWeight: "800", letterSpacing: -0.4 }}>Kora</AppText>
      </View>

      <AppText style={{ fontSize: 32, fontWeight: "800", letterSpacing: -1.12, lineHeight: 34 }}>
        Snap it.{"\n"}Otto tracks it.
      </AppText>
      <AppText muted style={{ fontSize: 16, lineHeight: 24, marginBottom: 10 }}>
        Photo or chat — log meals in seconds and let AI handle the calories and macros.
      </AppText>

      <Overline>What's your goal?</Overline>
      <View style={{ gap: 10 }}>
        {GOALS.map((g) => {
          const on = goal === g.id;
          return (
            <Pressable
              key={g.id}
              accessibilityRole="button"
              onPress={() => setGoal(g.id)}
              style={[
                {
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 14,
                  padding: 16,
                  borderRadius: radius.xl,
                  backgroundColor: colors.card,
                  borderWidth: 2,
                  borderColor: on ? colors.primary : colors.border,
                },
                on ? shadows.md : null,
              ]}
            >
              <View
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: radius.lg,
                  backgroundColor: on ? colors.primary : colors.secondary,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name={g.icon} size={20} color={on ? colors.primaryForeground : colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <AppText style={{ fontSize: 16, fontWeight: "700" }}>{g.title}</AppText>
                <AppText muted style={{ fontSize: 13 }}>
                  {g.sub}
                </AppText>
              </View>
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  borderWidth: on ? 0 : 2,
                  borderColor: colors.border,
                  backgroundColor: on ? colors.primary : "transparent",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {on ? <Icon name="check" size={14} color={colors.primaryForeground} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      <Overline style={{ marginTop: 8 }}>About you</Overline>
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <View style={{ flex: 1 }}>
          <Button title="Male" variant={sex === "male" ? "primary" : "secondary"} onPress={() => setSex("male")} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Female" variant={sex === "female" ? "primary" : "secondary"} onPress={() => setSex("female")} />
        </View>
      </View>
      <TextInput
        accessibilityLabel="Birth year"
        style={inputStyle}
        placeholder="Birth year (e.g. 1995)"
        placeholderTextColor={colors.mutedForeground}
        keyboardType="number-pad"
        value={birthYear}
        onChangeText={setBirthYear}
      />
      <TextInput
        accessibilityLabel="Height in centimetres"
        style={inputStyle}
        placeholder="Height (cm)"
        placeholderTextColor={colors.mutedForeground}
        keyboardType="decimal-pad"
        value={heightCm}
        onChangeText={setHeightCm}
      />
      <TextInput
        accessibilityLabel="Weight in kilograms"
        style={inputStyle}
        placeholder="Weight (kg)"
        placeholderTextColor={colors.mutedForeground}
        keyboardType="decimal-pad"
        value={weightKg}
        onChangeText={setWeightKg}
      />

      <Overline style={{ marginTop: 8 }}>Activity</Overline>
      <View style={{ gap: spacing.sm }}>
        {ACTIVITIES.map((a) => (
          <Button
            key={a}
            title={a.replace("_", " ")}
            variant={activity === a ? "primary" : "secondary"}
            onPress={() => setActivity(a)}
          />
        ))}
      </View>

      {error ? <AppText style={{ color: colors.destructive }}>{error}</AppText> : null}
      <Button title={submit.isPending ? "Saving…" : "Get started"} onPress={onSubmit} disabled={submit.isPending} />
    </ScrollView>
  );
}
