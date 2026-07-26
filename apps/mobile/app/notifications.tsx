import { useEffect } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { GroupedSection } from "@/components/GroupedList";
import { PressableScale } from "@/motion";
import { useNotifications, useMarkAllRead } from "@/api/hooks";
import { useTheme } from "@/theme";
import { targetFor } from "@/lib/notificationTarget";
import { relativeTime } from "@/lib/relativeTime";
import type { AppNotification } from "@/api/types";

function message(n: AppNotification): string {
  switch (n.type) {
    case "friend_request":
      return `${n.actor_name} sent you a friend request`;
    case "friend_accept":
      return `${n.actor_name} accepted your friend request`;
    case "group_invite":
      return `${n.actor_name} added you to a group`;
    case "challenge_created":
      return `${n.actor_name} started a challenge`;
    case "challenge_started":
      return "A challenge you joined has started";
    case "challenge_ended":
      return `${n.actor_name} won a challenge`;
    case "challenge_passed":
      return `${n.actor_name} passed you in a challenge`;
    default:
      return n.actor_name;
  }
}

export default function NotificationsScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const notifications = useNotifications();
  const markAll = useMarkAllRead();

  // Opening the inbox clears the unread badge. Rows keep their unread styling
  // from this fetch (taken before the mark), so the visual "new" state persists
  // for this viewing.
  useEffect(() => {
    markAll.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = notifications.data ?? [];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
      <ScreenHeader overline="Recent" title="Notifications" onBack={() => router.back()} />
      <View style={{ paddingHorizontal: 20 }}>
        {list.length === 0 ? (
          <AppText muted style={{ paddingVertical: 12 }}>Nothing yet. Friend requests, group invites, and new challenges show up here.</AppText>
        ) : (
          <GroupedSection>
            {list.map((n) => {
              const target = targetFor(n);
              const text = message(n);
              const content = (
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 44, paddingHorizontal: spacing.md }}>
                  <View
                    style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: n.read ? "transparent" : colors.accent }}
                  />
                  <View style={{ flex: 1 }}>
                    <AppText variant="subheadline" style={{ fontWeight: n.read ? "400" : "600" }}>
                      {text}
                    </AppText>
                    <AppText variant="footnote" muted>
                      {relativeTime(n.created_at)}
                    </AppText>
                  </View>
                </View>
              );
              return target ? (
                <PressableScale
                  key={n.id}
                  accessibilityRole="button"
                  accessibilityLabel={text}
                  haptic="none"
                  onPress={() => router.push(target)}
                >
                  {content}
                </PressableScale>
              ) : (
                <View key={n.id} accessibilityLabel={text}>
                  {content}
                </View>
              );
            })}
          </GroupedSection>
        )}
      </View>
    </ScrollView>
  );
}
