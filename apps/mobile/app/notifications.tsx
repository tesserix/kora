import { useEffect } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { GroupedSection } from "@/components/GroupedList";
import { NotifRow } from "@/components/NotifRow";
import { useNotifications, useMarkAllRead } from "@/api/hooks";
import { useTheme } from "@/theme";
import { targetFor } from "@/lib/notificationTarget";
import { relativeTime } from "@/lib/relativeTime";
import type { AppNotification, NotificationType } from "@/api/types";

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

type NotifIconTint = { icon: string; tint: string };

// Per-type icon + tint for the notification row's colored icon chip. Icons are
// restricted to glyphs confirmed to exist in Icon's MAP/SYMBOLS tables — an
// unmapped name silently falls back to a plain Circle, which reads as broken.
function iconTintFor(type: NotificationType, colors: ReturnType<typeof useTheme>["colors"]): NotifIconTint {
  switch (type) {
    case "friend_request":
      return { icon: "users", tint: colors.accent };
    case "friend_accept":
      return { icon: "check", tint: colors.accent };
    case "group_invite":
      return { icon: "people", tint: colors.accentBlue };
    case "challenge_created":
    case "challenge_started":
    case "challenge_ended":
      return { icon: "trophy", tint: colors.accentAmber };
    case "challenge_passed":
      return { icon: "check", tint: colors.accent };
    default:
      return { icon: "bell", tint: colors.accent };
  }
}

export default function NotificationsScreen() {
  const { colors } = useTheme();
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
          <GroupedSection elevated>
            {list.map((n) => {
              const target = targetFor(n);
              const { icon, tint } = iconTintFor(n.type, colors);
              return (
                <NotifRow
                  key={n.id}
                  type={n.type}
                  iconName={icon}
                  tint={tint}
                  text={message(n)}
                  time={relativeTime(n.created_at)}
                  unread={!n.read}
                  onPress={target ? () => router.push(target) : undefined}
                />
              );
            })}
          </GroupedSection>
        )}
      </View>
    </ScrollView>
  );
}
