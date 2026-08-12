import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, type Href } from "expo-router";
import { safeBack } from "@/lib/safeBack";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { PressableScale } from "@/motion";
import { GroupedSection, Row } from "@/components/GroupedList";
import { EmptyState } from "@/components/common/EmptyState";
import { CreateGroupSheet } from "@/components/social/CreateGroupSheet";
import { useGroups } from "@/api/hooks";
import { useTheme } from "@/theme";

// A neutral "Owner" chip, styled inline rather than via Badge's default
// variants — those lean on `colors.cardSecondary` / `colors.label`, which
// carry a faint green tint in dark mode, and Badge's "instrument" variant is
// a solid accent fill reserved for this screen's real accent budget (the
// primary CTA), not an identity tag.
function OwnerChip() {
  const { instrument } = useTheme();
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: instrument.inset,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: instrument.glassBorder,
        marginRight: 8,
      }}
    >
      <AppText style={{ fontSize: 11, fontWeight: "700", color: instrument.mut }}>Owner</AppText>
    </View>
  );
}

export default function Groups() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const groups = useGroups();
  const [sheet, setSheet] = useState<null | "create" | "join">(null);
  const list = groups.data ?? [];

  return (
    <>
      <View style={{ flex: 1, backgroundColor: instrument.bg }}>
        <AppBackground />
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
          <ScreenHeader overline="Your groups" title="Groups" onBack={() => safeBack("/(tabs)/more")} />
          <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
            {/* Add-actions follow the app-wide ghost-row pattern (Friends'
                "Add a friend", Diary's "Add dinner") — the previous pair of
                large side-by-side buttons made this the only screen leading
                with button chrome instead of content. */}
            <View style={{ gap: spacing.sm }}>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Create a group"
                haptic="selection"
                onPress={() => setSheet("create")}
                style={{
                  borderWidth: 1.5,
                  borderStyle: "dashed",
                  borderColor: instrument.tick,
                  borderRadius: 24,
                  paddingVertical: 16,
                  paddingHorizontal: 16,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                <AppText style={{ fontSize: 18, fontWeight: "600", color: instrument.accent }}>+</AppText>
                <AppText style={{ fontSize: 15, fontWeight: "600", color: instrument.ink }}>Create a group</AppText>
              </PressableScale>
              <GroupedSection>
                <Row
                  title="Join with a code"
                  icon={{ name: "type", tint: instrument.mut }}
                  chevron
                  onPress={() => setSheet("join")}
                />
              </GroupedSection>
            </View>

            {list.length === 0 ? (
              <EmptyState
                variant="instrument"
                icon="people"
                title="No groups yet"
                subtitle="Create one or join with a code."
              />
            ) : (
              <GroupedSection>
                {list.map((g) => (
                  <Row
                    key={g.id}
                    title={g.name}
                    subtitle={`${g.member_count} ${g.member_count === 1 ? "member" : "members"}`}
                    chevron
                    onPress={() => router.push(`/group/${g.id}` as Href)}
                    right={g.role === "owner" ? <OwnerChip /> : undefined}
                  />
                ))}
              </GroupedSection>
            )}
          </View>
        </ScrollView>
      </View>
      {sheet ? <CreateGroupSheet visible mode={sheet} onClose={() => setSheet(null)} /> : null}
    </>
  );
}
