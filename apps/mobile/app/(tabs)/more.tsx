import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, type Href } from "expo-router";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { unregisterPushToken } from "@/lib/push";
import { ScreenHeader } from "@/components/ScreenHeader";
import { GroupedSection, Row } from "@/components/GroupedList";
import { Badge } from "@/components/Badge";
import { useUnreadCount } from "@/api/hooks";
import { useTheme } from "@/theme";

export default function More() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const unread = useUnreadCount();
  const count = unread.data?.count ?? 0;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
      <ScreenHeader overline="Your account" title="More" />
      <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
        <GroupedSection>
          <Row
            title="Friends"
            icon={{ name: "users", tint: colors.accentBlue }}
            chevron
            onPress={() => router.push("/friends" as Href)}
          />
          <Row
            title="Groups"
            icon={{ name: "people", tint: colors.accent }}
            chevron
            onPress={() => router.push("/groups" as Href)}
          />
          <Row
            title="Notifications"
            icon={{ name: "bell", tint: colors.accentAmber }}
            chevron
            right={count > 0 ? (
              <View style={{ marginRight: spacing.xs }}>
                <Badge variant="accent">{count}</Badge>
              </View>
            ) : null}
            onPress={() => router.push("/notifications" as Href)}
          />
        </GroupedSection>
        <GroupedSection>
          <Row
            title="Sign out"
            destructive
            onPress={async () => {
              if (!auth) return;
              try {
                await unregisterPushToken();
              } catch {
                // best-effort: still sign out even if de-registration fails
              }
              await signOut(auth);
            }}
          />
        </GroupedSection>
      </View>
    </ScrollView>
  );
}
