import { useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Overline } from "@/components/Overline";
import { AddFriendSheet } from "@/components/social/AddFriendSheet";
import { useFriends, useFriendRequests, useAcceptRequest, useDeclineRequest, useUnfriend } from "@/api/hooks";
import { useTheme } from "@/theme";

export default function Friends() {
  const { colors, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const friends = useFriends();
  const requests = useFriendRequests();
  const accept = useAcceptRequest();
  const decline = useDeclineRequest();
  const unfriend = useUnfriend();
  const [addOpen, setAddOpen] = useState(false);

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
        <View style={{ paddingHorizontal: 20, gap: 20 }}>
          <Button title="Add a friend" onPress={() => setAddOpen(true)} />

          {incoming.length > 0 ? (
            <View style={{ gap: 10 }}>
              <Overline>Requests</Overline>
              {incoming.map((r) => (
                <View key={r.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
                  <AppText style={{ flex: 1, fontSize: 15, fontWeight: "600" }}>{r.user.display_name}</AppText>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Accept request from ${r.user.display_name}`} onPress={() => accept.mutate(r.id)} style={{ width: 40, height: 40, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary }}>
                    <Icon name="check" size={18} color={colors.primaryForeground} />
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Decline request from ${r.user.display_name}`} onPress={() => decline.mutate(r.id)} style={{ width: 40, height: 40, borderRadius: radius.md, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border }}>
                    <Icon name="x" size={18} color={colors.mutedForeground} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}

          <View style={{ gap: 10 }}>
            <Overline>Friends</Overline>
            {list.length === 0 ? (
              <AppText muted>No friends yet. Share your code to connect.</AppText>
            ) : (
              list.map((f) => (
                <Pressable key={f.id} accessibilityRole="button" accessibilityLabel={`Remove ${f.display_name}`} onLongPress={() => onUnfriend(f.id, f.display_name)} style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
                  <Icon name="users" size={18} color={colors.primary} />
                  <AppText style={{ fontSize: 15, fontWeight: "600" }}>{f.display_name}</AppText>
                </Pressable>
              ))
            )}
          </View>
        </View>
      </ScrollView>
      <AddFriendSheet visible={addOpen} onClose={() => setAddOpen(false)} />
    </>
  );
}
