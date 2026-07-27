import { useState } from "react";
import { Alert, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Avatar } from "@/components/Avatar";
import { GroupedSection, Row } from "@/components/GroupedList";
import { AddFriendSheet } from "@/components/social/AddFriendSheet";
import { FriendsLeaderboard } from "@/components/social/FriendsLeaderboard";
import { PressableScale } from "@/motion";
import {
  useFriends,
  useFriendRequests,
  useAcceptRequest,
  useDeclineRequest,
  useUnfriend,
  useProfile,
  useSetShareProgress,
  useFriendsProgress,
} from "@/api/hooks";
import { useTheme } from "@/theme";

function initials(name: string): string {
  return name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
}

export default function Friends() {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const friends = useFriends();
  const requests = useFriendRequests();
  const accept = useAcceptRequest();
  const decline = useDeclineRequest();
  const unfriend = useUnfriend();
  const profile = useProfile();
  const setShare = useSetShareProgress();
  const compare = useFriendsProgress();
  const [addOpen, setAddOpen] = useState(false);

  const shareOn = profile.data?.share_progress ?? false;

  const incoming = requests.data?.incoming ?? [];
  const list = friends.data ?? [];

  const onUnfriend = (id: string, name: string) =>
    Alert.alert("Remove friend?", `Remove ${name} from your friends.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => unfriend.mutate(id) },
    ]);

  return (
    <>
      <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
        <ScreenHeader overline="Your circle" title="Friends" />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          <Button title="Add a friend" onPress={() => setAddOpen(true)} />

          <GroupedSection elevated>
            <Row
              title="Share my progress"
              subtitle="Friends can see your streak and on-target days."
              right={
                <Switch
                  accessibilityLabel="Share my progress"
                  value={shareOn}
                  onValueChange={(v) => setShare.mutate(v)}
                  trackColor={{ true: colors.accent }}
                />
              }
            />
          </GroupedSection>

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
                        onPress={() => accept.mutate(r.id)}
                        style={{ width: 32, height: 32, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent }}
                      >
                        <Icon name="check" size={16} color={colors.primaryForeground} />
                      </PressableScale>
                      <PressableScale
                        accessibilityRole="button"
                        accessibilityLabel={`Decline request from ${r.user.display_name}`}
                        haptic="selection"
                        onPress={() => decline.mutate(r.id)}
                        style={{ width: 32, height: 32, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: colors.cardSecondary }}
                      >
                        <Icon name="x" size={16} color={colors.secondaryLabel} />
                      </PressableScale>
                    </View>
                  }
                />
              ))}
            </GroupedSection>
          ) : null}

          <GroupedSection header="Friends" elevated>
            {list.length === 0 ? (
              <Row title="No friends yet" subtitle="Share your code to connect." />
            ) : (
              list.map((f) => (
                <PressableScale
                  key={f.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${f.display_name}`}
                  haptic="none"
                  onLongPress={() => onUnfriend(f.id, f.display_name)}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 44, paddingHorizontal: spacing.md }}>
                    <Avatar initials={initials(f.display_name)} size={32} />
                    <AppText variant="headline">{f.display_name}</AppText>
                  </View>
                </PressableScale>
              ))
            )}
          </GroupedSection>
        </View>
      </ScrollView>
      <AddFriendSheet visible={addOpen} onClose={() => setAddOpen(false)} />
    </>
  );
}
