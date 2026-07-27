import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, type Href } from "expo-router";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { Badge } from "@/components/Badge";
import { GroupedSection, Row } from "@/components/GroupedList";
import { CreateGroupSheet } from "@/components/social/CreateGroupSheet";
import { useGroups } from "@/api/hooks";
import { useTheme } from "@/theme";

export default function Groups() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const groups = useGroups();
  const [sheet, setSheet] = useState<null | "create" | "join">(null);
  const list = groups.data ?? [];

  return (
    <>
      <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
        <ScreenHeader overline="Your groups" title="Groups" onBack={() => router.back()} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <Button title="Create group" onPress={() => setSheet("create")} style={{ flex: 1 }} />
            <Button title="Join by code" variant="secondary" onPress={() => setSheet("join")} style={{ flex: 1 }} />
          </View>

          <GroupedSection elevated>
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
                  right={g.role === "owner" ? <Badge>Owner</Badge> : undefined}
                />
              ))
            )}
          </GroupedSection>
        </View>
      </ScrollView>
      {sheet ? <CreateGroupSheet visible mode={sheet} onClose={() => setSheet(null)} /> : null}
    </>
  );
}
