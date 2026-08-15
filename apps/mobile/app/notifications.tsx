import { useEffect } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { safeBack } from "@/lib/safeBack";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { GroupedSection } from "@/components/GroupedList";
import { NotifRow } from "@/components/NotifRow";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadErrorNotice } from "@/components/common/LoadErrorNotice";
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
  const { colors, instrument } = useTheme();
  const insets = useSafeAreaInsets();
  const notifications = useNotifications();
  const markAll = useMarkAllRead();

  // Opening the inbox clears the unread badge. Rows keep their unread styling
  // from this fetch (taken before the mark), so the visual "new" state persists
  // for this viewing.
  //
  // #83 lists this among the mutations with no error surface, but it is the one
  // case where staying silent is correct, and that is a decision rather than an
  // oversight. The other twelve are user-initiated taps: something the person
  // asked for did not happen, so they must be told. This one fires from an
  // effect on mount. Nobody asked for it, and its failure is self-describing —
  // the badge simply stays unread, which is TRUE, because the server did not
  // record the read. Toasting here would put "Couldn't reach Kora" on screen
  // for an action the user never took, on top of whatever the notifications
  // list itself is already showing for the same outage.
  //
  // Pinned by notifications.test.tsx so a later sweep does not "fix" it.
  useEffect(() => {
    markAll.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = notifications.data ?? [];
  // #174: an unreachable inbox is not an empty one.
  const listError = notifications.isError;

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
        <ScreenHeader overline="Recent" title="Notifications" onBack={() => safeBack("/(tabs)/more")} />
        <View style={{ paddingHorizontal: 20 }}>
          {listError ? (
            <LoadErrorNotice message="Couldn't load your notifications." onRetry={() => void notifications.refetch()} />
          ) : list.length === 0 ? (
            <EmptyState
              variant="instrument"
              icon="bell"
              title="Nothing yet"
              subtitle="Friend requests, group invites, and new challenges show up here."
            />
          ) : (
            <GroupedSection>
              {list.map((n) => {
                const target = targetFor(n);
                // NotifRow no longer paints per-type tints on its icon tile
                // (spec: "instrument tokens; any green/legacy accent →
                // ink/mut") — `iconTintFor` still supplies the glyph name.
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
    </View>
  );
}
