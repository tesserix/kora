import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, type Href } from "expo-router";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { Button } from "@/components/Button";
import { GroupedSection, Row } from "@/components/GroupedList";
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
          <ScreenHeader overline="Your groups" title="Groups" onBack={() => router.back()} />
          <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
            <View style={{ flexDirection: "row", gap: spacing.sm }}>
              <Button title="Create group" onPress={() => setSheet("create")} style={{ flex: 1 }} />
              <Button title="Join by code" variant="secondary" onPress={() => setSheet("join")} style={{ flex: 1 }} />
            </View>

            <GroupedSection>
              {list.length === 0 ? (
                <Row title="No groups yet" subtitle="Create one or join with a code." />
              ) : (
                list.map((g) => (
                  <Row
                    key={g.id}
                    title={g.name}
                    subtitle={`${g.member_count} ${g.member_count === 1 ? "member" : "members"}`}
                    chevron
                    onPress={() => router.push(`/group/${g.id}` as Href)}
                    right={g.role === "owner" ? <OwnerChip /> : undefined}
                  />
                ))
              )}
            </GroupedSection>
          </View>
        </ScrollView>
      </View>
      {sheet ? <CreateGroupSheet visible mode={sheet} onClose={() => setSheet(null)} /> : null}
    </>
  );
}
