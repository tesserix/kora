import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { safeBack } from "@/lib/safeBack";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { GlassPanel } from "@/components/instrument/GlassPanel";
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
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const profile = useProfile();
  const data = profile.data;
  const { system } = useUnits();
  const fw = data ? formatWeight(data.weight_kg, system) : null;

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}
      >
        <ScreenHeader overline="Your account" title="Profile" onBack={() => safeBack("/(tabs)/more")} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          <GlassPanel radius={24} style={{ alignItems: "center", paddingVertical: spacing.lg }}>
            <Avatar initials={data ? initials(data.display_name) : "—"} size={72} />
            <AppText style={{ fontSize: 22, fontWeight: "700", color: instrument.ink, marginTop: spacing.sm }}>
              {data ? data.display_name : "Loading…"}
            </AppText>
            <AppText style={{ fontSize: 15, color: instrument.mut, marginTop: spacing.xs }}>
              {data ? data.email : "—"}
            </AppText>
          </GlassPanel>

          <GlassPanel radius={22} style={{ padding: spacing.md }}>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: spacing.sm,
              }}
            >
              <AppText style={{ fontSize: 17, fontWeight: "600", color: instrument.ink }}>Daily targets</AppText>
              <View
                style={{
                  paddingHorizontal: spacing.sm,
                  paddingVertical: spacing.xs / 2,
                  borderRadius: 999,
                  backgroundColor: instrument.inset,
                  borderWidth: 1,
                  borderColor: instrument.glassBorder,
                }}
              >
                <AppText style={{ fontSize: 13, fontWeight: "700", color: instrument.mut }}>
                  {humanizeGoal(data?.goal)}
                </AppText>
              </View>
            </View>

            <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.xs, marginBottom: spacing.md }}>
              <Numeral size={40} color={instrument.ink}>{data ? Math.round(data.target_kcal) : "—"}</Numeral>
              <AppText style={{ fontSize: 15, color: instrument.mut }}>kcal / day</AppText>
            </View>

            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <View>
                <AppText style={{ fontSize: 13, color: instrument.mut }}>Protein</AppText>
                <Numeral size={17} color={instrument.ink}>
                  {data ? `${Math.round(data.target_protein_g)}g` : "—"}
                </Numeral>
              </View>
              <View>
                <AppText style={{ fontSize: 13, color: instrument.mut }}>Carbs</AppText>
                <Numeral size={17} color={instrument.ink}>
                  {data ? `${Math.round(data.target_carbs_g)}g` : "—"}
                </Numeral>
              </View>
              <View>
                <AppText style={{ fontSize: 13, color: instrument.mut }}>Fat</AppText>
                <Numeral size={17} color={instrument.ink}>
                  {data ? `${Math.round(data.target_fat_g)}g` : "—"}
                </Numeral>
              </View>
            </View>
          </GlassPanel>

          <View style={{ flexDirection: "row", gap: spacing.lg }}>
            <GlassPanel radius={22} style={{ flex: 1, padding: spacing.md }}>
              <AppText style={{ fontSize: 13, color: instrument.mut }}>Weight</AppText>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.xs, marginTop: spacing.xs }}>
                <Numeral size={24} color={instrument.ink}>{fw ? fw.value : "—"}</Numeral>
                <AppText style={{ fontSize: 15, color: instrument.mut }}>{fw ? fw.unit : "kg"}</AppText>
              </View>
            </GlassPanel>
            <GlassPanel radius={22} style={{ flex: 1, padding: spacing.md }}>
              <AppText style={{ fontSize: 13, color: instrument.mut }}>Member since</AppText>
              <AppText style={{ fontSize: 17, fontWeight: "600", color: instrument.ink, marginTop: spacing.xs }}>
                {data ? formatMemberSince(data.onboarded_at) : "—"}
              </AppText>
            </GlassPanel>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
