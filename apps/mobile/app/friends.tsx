import { useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { safeBack } from "@/lib/safeBack";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { Icon } from "@/components/Icon";
import { Avatar } from "@/components/Avatar";
import { GroupedSection, Row } from "@/components/GroupedList";
import { AddFriendSheet } from "@/components/social/AddFriendSheet";
import { FriendsLeaderboard } from "@/components/social/FriendsLeaderboard";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadErrorNotice } from "@/components/common/LoadErrorNotice";
import { PressableScale } from "@/motion";
import {
  useFriends,
  useFriendRequests,
  useAcceptRequest,
  useDeclineRequest,
  useUnfriend,
  useFriendsProgress,
} from "@/api/hooks";
import { useToast } from "@/components/Toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { initials } from "@/lib/initials";
import { useTheme } from "@/theme";

// 32pt visual + 6pt slop each side = a 44pt target, the iOS minimum.
const TAP_SLOP = { top: 6, bottom: 6, left: 6, right: 6 } as const;

export default function Friends() {
  const { instrument, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const friends = useFriends();
  const requests = useFriendRequests();
  const accept = useAcceptRequest();
  const decline = useDeclineRequest();
  const unfriend = useUnfriend();
  const compare = useFriendsProgress();
  const toast = useToast();

  // #83: none of the four mutations on this screen had an error surface, so a
  // failed tap did nothing and said nothing. Shared because every failure here
  // reads the same to the user — the action did not happen, and this is why.
  const surfaceError = { onError: (error: unknown) => toast.show({ message: apiErrorMessage(error) }) };
  const [addOpen, setAddOpen] = useState(false);

  const incoming = requests.data?.incoming ?? [];
  const list = friends.data ?? [];
  // #174: an outage rendered as "No friends yet" — the empty state is a claim
  // about the user's circle, not about the network. An inline notice with a
  // retry is all a list screen needs, so long as it REPLACES that claim.
  const listError = friends.isError;

  const onUnfriend = (id: string, name: string) =>
    Alert.alert("Remove friend?", `Remove ${name} from your friends.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => unfriend.mutate(id, surfaceError) },
    ]);

  return (
    <>
      <View style={{ flex: 1, backgroundColor: instrument.bg }}>
        <AppBackground />
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
          <ScreenHeader overline="Your circle" title="Friends" onBack={() => safeBack("/(tabs)/more")} />
          <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Add a friend"
              haptic="selection"
              onPress={() => setAddOpen(true)}
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
              <Icon name="plus" size={16} color={instrument.accent} />
              <AppText style={{ fontSize: 15, fontWeight: "600", color: instrument.ink }}>Add a friend</AppText>
            </PressableScale>

            <FriendsLeaderboard data={compare.data} />

            {incoming.length > 0 ? (
              <GroupedSection header="Requests">
                {incoming.map((r) => (
                  <Row
                    key={r.id}
                    title={r.user.display_name}
                    right={
                      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                        <PressableScale
                          accessibilityRole="button"
                          accessibilityLabel={`Accept request from ${r.user.display_name}`}
                          haptic="success"
                          onPress={() => accept.mutate(r.id, surfaceError)}
                          // The 32pt circle is the design; hitSlop takes the
                          // TARGET to 44pt without changing it (kora#446).
                          // These two sit adjacent with asymmetric
                          // consequences — a mis-tap declines someone with no
                          // undo — so they are the worst controls in the app
                          // to leave under the minimum.
                          hitSlop={TAP_SLOP}
                          style={{ width: 32, height: 32, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: instrument.accent }}
                        >
                          <Icon name="check" size={16} color={instrument.accentOn} />
                        </PressableScale>
                        <PressableScale
                          accessibilityRole="button"
                          accessibilityLabel={`Decline request from ${r.user.display_name}`}
                          haptic="selection"
                          onPress={() => decline.mutate(r.id, surfaceError)}
                          hitSlop={TAP_SLOP}
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: radius.full,
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: instrument.inset,
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: instrument.glassBorder,
                          }}
                        >
                          <Icon name="x" size={16} color={instrument.mut} />
                        </PressableScale>
                      </View>
                    }
                  />
                ))}
              </GroupedSection>
            ) : null}

            {listError ? (
              <LoadErrorNotice message="Couldn't load your friends." onRetry={() => void friends.refetch()} />
            ) : list.length === 0 ? (
              <EmptyState
                variant="instrument"
                icon="users"
                title="No friends yet"
                subtitle="Share your code to connect."
              />
            ) : (
              <GroupedSection header="Friends">
                {list.map((f) => (
                  <PressableScale
                    key={f.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${f.display_name}`}
                    haptic="none"
                    onLongPress={() => onUnfriend(f.id, f.display_name)}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 44, paddingHorizontal: spacing.md }}>
                      <Avatar initials={initials(f.display_name)} uri={f.avatar_url} size={32} />
                      <AppText variant="headline" style={{ color: instrument.ink }}>{f.display_name}</AppText>
                    </View>
                  </PressableScale>
                ))}
              </GroupedSection>
            )}
          </View>
        </ScrollView>
      </View>
      <AddFriendSheet visible={addOpen} onClose={() => setAddOpen(false)} />
    </>
  );
}
