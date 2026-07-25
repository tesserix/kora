import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, type Href } from "expo-router";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { CreateGroupSheet } from "@/components/social/CreateGroupSheet";
import { useGroups } from "@/api/hooks";
import { useTheme } from "@/theme";

export default function Groups() {
  const { colors, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const groups = useGroups();
  const [sheet, setSheet] = useState<null | "create" | "join">(null);
  const list = groups.data ?? [];

  return (
    <>
      <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
        <ScreenHeader overline="Your groups" title="Groups" />
        <View style={{ paddingHorizontal: 20, gap: 12 }}>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button title="Create group" onPress={() => setSheet("create")} style={{ flex: 1 }} />
            <Button title="Join by code" variant="secondary" onPress={() => setSheet("join")} style={{ flex: 1 }} />
          </View>

          {list.length === 0 ? (
            <AppText muted style={{ paddingVertical: 12 }}>No groups yet. Create one or join with a code.</AppText>
          ) : (
            list.map((g) => (
              <Pressable
                key={g.id}
                accessibilityRole="button"
                onPress={() => router.push(`/group/${g.id}` as Href)}
                style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 16, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}
              >
                <Icon name="users" size={18} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <AppText style={{ fontSize: 15, fontWeight: "600" }}>{g.name}</AppText>
                  <AppText muted style={{ fontSize: 12 }}>{`${g.member_count} ${g.member_count === 1 ? "member" : "members"}`}</AppText>
                </View>
                {g.role === "owner" ? <AppText muted style={{ fontSize: 11 }}>Owner</AppText> : null}
              </Pressable>
            ))
          )}
        </View>
      </ScrollView>
      {sheet ? <CreateGroupSheet visible mode={sheet} onClose={() => setSheet(null)} /> : null}
    </>
  );
}
