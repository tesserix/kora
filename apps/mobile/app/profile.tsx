import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { safeBack } from "@/lib/safeBack";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { engravedStyle, monoStyle } from "@/components/instrument/typography";
import { GroupedSection, Row } from "@/components/GroupedList";
import { Avatar } from "@/components/Avatar";
import { useProfile } from "@/api/hooks";
import type { Profile } from "@/api/types";
import { useTheme } from "@/theme";
import { formatWeight, useUnits } from "@/units";

const GOAL_LABELS: Record<Profile["goal"], string> = {
  fat_loss: "Fat loss",
  maintenance: "Maintenance",
  muscle_gain: "Muscle gain",
};

// Falls back to "K" when the name is empty/whitespace-only — otherwise
// filter(Boolean) on the split leaves nothing to join, and the avatar renders
// an empty circle (same fallback as app/(tabs)/index.tsx's `initials`).
function initials(name: string): string {
  const parts = name.split(" ").filter(Boolean);
  if (parts.length === 0) return "K";
  return parts
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
  const { instrument, spacing, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const profile = useProfile();
  const data = profile.data;
  const { system } = useUnits();
  const fw = data ? formatWeight(data.weight_kg, system) : null;
  const mono = monoStyle(fonts);
  const duoLabel = [engravedStyle(instrument), { marginBottom: spacing.xs }];

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
            <AppText style={{ fontSize: 14, color: instrument.mut, marginTop: spacing.xs, textAlign: "center" }}>
              {data ? data.email : "—"}
            </AppText>
          </GlassPanel>

          <View>
            <AppText style={[engravedStyle(instrument), { marginLeft: spacing.md, marginBottom: spacing.xs }]}>
              Daily targets
            </AppText>
            <GlassPanel radius={22} style={{ padding: spacing.md }}>
              <View style={{ flexDirection: "row", justifyContent: "flex-end", marginBottom: spacing.sm }}>
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
                  <AppText
                    style={{
                      fontSize: 10,
                      letterSpacing: 1,
                      textTransform: "uppercase",
                      fontWeight: "700",
                      color: instrument.mut,
                    }}
                  >
                    {humanizeGoal(data?.goal)}
                  </AppText>
                </View>
              </View>

              {/* flexWrap, not flexShrink: with nothing given, neither side
                  yields and "kcal / day" is clipped by the screen edge at
                  accessibility sizes; with flexShrink on the unit the box
                  narrows below the word and the unit breaks MID-WORD instead
                  (measured: "k / g" on the weight card below). Wrapping moves
                  the unit to its own line whole, and the numeral -- the
                  reading -- never splits. Unchanged at medium, where both
                  still fit one line. (kora#173) */}
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  alignItems: "baseline",
                  gap: spacing.xs,
                  marginBottom: spacing.md,
                }}
              >
                {/* Explicit lineHeight: large mono numerals clip their ascent
                    without it (same class as the GaugeDial center-numeral bug). */}
                <AppText
                  style={[
                    { fontSize: 40, lineHeight: 46, fontWeight: "700", color: instrument.ink },
                    mono,
                  ]}
                >
                  {data ? Math.round(data.target_kcal) : "—"}
                </AppText>
                <AppText style={{ fontSize: 13, color: instrument.mut }}>kcal / day</AppText>
              </View>

              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <View>
                  <AppText style={{ fontSize: 13, color: instrument.mut }}>Protein</AppText>
                  <AppText style={[{ fontSize: 17, fontWeight: "700", color: instrument.ink }, mono]}>
                    {data ? `${Math.round(data.target_protein_g)}g` : "—"}
                  </AppText>
                </View>
                <View>
                  <AppText style={{ fontSize: 13, color: instrument.mut }}>Carbs</AppText>
                  <AppText style={[{ fontSize: 17, fontWeight: "700", color: instrument.ink }, mono]}>
                    {data ? `${Math.round(data.target_carbs_g)}g` : "—"}
                  </AppText>
                </View>
                <View>
                  <AppText style={{ fontSize: 13, color: instrument.mut }}>Fat</AppText>
                  <AppText style={[{ fontSize: 17, fontWeight: "700", color: instrument.ink }, mono]}>
                    {data ? `${Math.round(data.target_fat_g)}g` : "—"}
                  </AppText>
                </View>
              </View>
            </GlassPanel>
          </View>

          <View style={{ flexDirection: "row", gap: spacing.lg }}>
            <GlassPanel radius={22} style={{ flex: 1, padding: spacing.md, minHeight: 84, justifyContent: "center" }}>
              <AppText style={duoLabel}>Weight</AppText>
              {/* Same treatment as the energy readout above; here the edge
                  that clips is the card's, not the screen's. flexShrink on
                  the unit was measured breaking "kg" into "k" / "g" -- a
                  two-letter unit has no break point worth taking, so the row
                  wraps instead and the unit drops to its own line whole
                  (kora#173). */}
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: spacing.xs }}>
                <AppText style={[{ fontSize: 24, fontWeight: "700", color: instrument.ink }, mono]}>
                  {fw ? fw.value : "—"}
                </AppText>
                <AppText variant="subheadline" style={{ color: instrument.mut }}>{fw ? fw.unit : "kg"}</AppText>
              </View>
            </GlassPanel>
            <GlassPanel radius={22} style={{ flex: 1, padding: spacing.md, minHeight: 84, justifyContent: "center" }}>
              <AppText style={duoLabel}>Member since</AppText>
              <AppText variant="headline" style={{ color: instrument.ink }}>
                {data ? formatMemberSince(data.onboarded_at) : "—"}
              </AppText>
            </GlassPanel>
          </View>

          <View>
            <AppText style={[engravedStyle(instrument), { marginLeft: spacing.md, marginBottom: spacing.xs }]}>
              Account
            </AppText>
            <GroupedSection>
              <Row
                title="Delete account"
                destructive
                chevron
                onPress={() => router.push("/delete-account")}
              />
            </GroupedSection>
            <AppText style={{ fontSize: 13, color: instrument.mut, marginLeft: spacing.md, marginTop: spacing.xs }}>
              Permanently deletes your account and all your data.
            </AppText>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
