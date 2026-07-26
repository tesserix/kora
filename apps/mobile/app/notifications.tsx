import { useEffect } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, type Href } from "expo-router";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useNotifications, useMarkAllRead } from "@/api/hooks";
import { useTheme } from "@/theme";
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
    default:
      return n.actor_name;
  }
}

function targetFor(n: AppNotification): Href | null {
  switch (n.type) {
    case "friend_request":
    case "friend_accept":
      return "/friends" as Href;
    case "group_invite":
      return n.entity_id ? (`/group/${n.entity_id}` as Href) : null;
    case "challenge_created":
      return n.entity_id ? (`/challenge/${n.entity_id}` as Href) : null;
    default:
      return null;
  }
}

export default function NotificationsScreen() {
  const { colors, radius } = useTheme();
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
      <View style={{ paddingHorizontal: 20, gap: 10 }}>
        {list.length === 0 ? (
          <AppText muted style={{ paddingVertical: 12 }}>Nothing yet. Friend requests, group invites, and new challenges show up here.</AppText>
        ) : (
          list.map((n) => {
            const target = targetFor(n);
            return (
              <Pressable
                key={n.id}
                accessibilityRole="button"
                disabled={!target}
                onPress={() => target && router.push(target)}
                style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}
              >
                {!n.read ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary }} /> : <View style={{ width: 8 }} />}
                <AppText style={{ flex: 1, fontSize: 14, fontWeight: n.read ? "400" : "600" }}>{message(n)}</AppText>
              </Pressable>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}
