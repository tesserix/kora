import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Card } from "@/components/Card";
import { Avatar } from "@/components/Avatar";
import { Numeral } from "@/components/Numeral";
import { useProfile } from "@/api/hooks";
import type { Profile } from "@/api/types";
import { useTheme } from "@/theme";
import { formatWeight, useUnits } from "@/units";

const GOAL_LABELS: Record<Profile["goal"], string> = {
  fat_loss: "Fat loss",
  maintenance: "Maintenance",
  muscle_gain: "Muscle gain",
};

function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function humanizeGoal(goal: string | undefined): string {
  if (!goal) return "—";
  return GOAL_LABELS[goal as Profile["goal"]] ?? goal;
}

// Formats an ISO date as e.g. "March 2025". Never fabricates a date when the
// server hasn't reported one — falls back to an explicit placeholder.
function formatMemberSince(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export default function ProfileScreen() {
  const { colors, spacing, gradients } = useTheme();
  const insets = useSafeAreaInsets();
  const profile = useProfile();
  const data = profile.data;
  const { system } = useUnits();
  const fw = data ? formatWeight(data.weight_kg, system) : null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}
    >
      <ScreenHeader overline="Your account" title="Profile" onBack={() => router.back()} />
      <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
        <Card variant="hero" style={{ alignItems: "center", paddingVertical: spacing.lg }}>
          <Avatar initials={data ? initials(data.display_name) : "—"} size={72} />
          <AppText variant="title2" style={{ marginTop: spacing.sm }}>
            {data ? data.display_name : "Loading…"}
          </AppText>
          <AppText muted style={{ marginTop: spacing.xs }}>
            {data ? data.email : "—"}
          </AppText>
        </Card>

        <Card variant="elevated">
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: spacing.sm,
            }}
          >
            <AppText variant="headline">Daily targets</AppText>
            <View
              style={{
                paddingHorizontal: spacing.sm,
                paddingVertical: spacing.xs / 2,
                borderRadius: 999,
                backgroundColor: colors.cardSecondary,
              }}
            >
              <AppText variant="footnote" style={{ fontWeight: "700" }}>
                {humanizeGoal(data?.goal)}
              </AppText>
            </View>
          </View>

          <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.xs, marginBottom: spacing.md }}>
            <Numeral size={40}>{data ? Math.round(data.target_kcal) : "—"}</Numeral>
            <AppText muted>kcal / day</AppText>
          </View>

          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <View>
              <AppText variant="footnote" muted>Protein</AppText>
              <Numeral size={17} color={gradients.green[0]}>
                {data ? `${Math.round(data.target_protein_g)}g` : "—"}
              </Numeral>
            </View>
            <View>
              <AppText variant="footnote" muted>Carbs</AppText>
              <Numeral size={17} color={gradients.amber[0]}>
                {data ? `${Math.round(data.target_carbs_g)}g` : "—"}
              </Numeral>
            </View>
            <View>
              <AppText variant="footnote" muted>Fat</AppText>
              <Numeral size={17} color={gradients.blue[0]}>
                {data ? `${Math.round(data.target_fat_g)}g` : "—"}
              </Numeral>
            </View>
          </View>
        </Card>

        <View style={{ flexDirection: "row", gap: spacing.lg }}>
          <Card variant="elevated" style={{ flex: 1 }}>
            <AppText variant="footnote" muted>Weight</AppText>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.xs, marginTop: spacing.xs }}>
              <Numeral size={24}>{fw ? fw.value : "—"}</Numeral>
              <AppText muted>{fw ? fw.unit : "kg"}</AppText>
            </View>
          </Card>
          <Card variant="elevated" style={{ flex: 1 }}>
            <AppText variant="footnote" muted>Member since</AppText>
            <AppText variant="headline" style={{ marginTop: spacing.xs }}>
              {data ? formatMemberSince(data.onboarded_at) : "—"}
            </AppText>
          </Card>
        </View>
      </View>
    </ScrollView>
  );
}
