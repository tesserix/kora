import { useState } from "react";
import { Alert, Pressable, ScrollView, Share, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams, type Href } from "expo-router";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { Overline } from "@/components/Overline";
import { CreateChallengeSheet } from "@/components/social/CreateChallengeSheet";
import { useGroup, useGroupProgress, useGroupCode, useLeaveGroup, useRemoveMember, useDeleteGroup, useProfile, useGroupChallenges } from "@/api/hooks";
import { useTheme } from "@/theme";

// A group board has no "You" anchor row (every member is a peer), so this screen
// renders its own ranked list rather than reusing FriendsLeaderboard.

export default function GroupDetail() {
  const { colors, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const detail = useGroup(id);
  const progress = useGroupProgress(id);
  const code = useGroupCode(id);
  const leave = useLeaveGroup();
  const removeMember = useRemoveMember();
  const del = useDeleteGroup();
  const challenges = useGroupChallenges(id);
  const [sheet, setSheet] = useState(false);

  const profile = useProfile();
  const d = detail.data;
  const isOwner = d?.my_role === "owner";
  const members = progress.data?.members ?? [];
  const sharing = members.filter((m) => m.sharing);
  const notSharing = members.filter((m) => !m.sharing);
  const ranked = [...sharing].sort((a, b) => (b.streak_days ?? 0) - (a.streak_days ?? 0) || (b.adherence_days ?? 0) - (a.adherence_days ?? 0));

  const shareCode = () => {
    if (code.data) Share.share({ message: code.data.link }).catch(() => {});
  };

  const onDelete = () =>
    Alert.alert("Delete this group?", "This removes it for everyone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => del.mutate(id, { onSuccess: () => router.back() }) },
    ]);

  const onLeave = () =>
    Alert.alert("Leave this group?", "", [
      { text: "Cancel", style: "cancel" },
      { text: "Leave", style: "destructive", onPress: () => leave.mutate({ groupId: id, userId: profile.data?.id ?? "" }, { onSuccess: () => router.back() }) },
    ]);

  return (
    <>
      <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
        <ScreenHeader overline="Group" title={d?.name ?? "Group"} />
        <View style={{ paddingHorizontal: 20, gap: 20 }}>
          <Button title="Share invite code" onPress={shareCode} variant="secondary" />

          <View style={{ gap: 10 }}>
            <Overline>Leaderboard</Overline>
            {ranked.map((m, i) => (
              <View key={m.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
                {/* Rank + name are combined into one text node (rather than a separate bare-name
                    node) so a member who is also listed in the roster below doesn't produce two
                    identically-texted elements — the roster row keeps the sole standalone name. */}
                <View style={{ flex: 1 }}>
                  <AppText style={{ fontSize: 15, fontWeight: "600" }}>{`${i + 1}. ${m.display_name}`}</AppText>
                  <AppText muted style={{ fontSize: 12 }}>{`${m.adherence_days ?? 0}/7 on target`}</AppText>
                </View>
                <AppText style={{ fontSize: 16, fontWeight: "700" }}>{m.streak_days ?? 0}</AppText>
              </View>
            ))}
          </View>

          <View style={{ gap: 8 }}>
            <Overline>Members</Overline>
            {(d?.members ?? []).map((m) => (
              <View key={m.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 }}>
                <AppText style={{ flex: 1, fontSize: 15 }}>{m.display_name}</AppText>
                <AppText muted style={{ fontSize: 11 }}>{m.role}</AppText>
                {isOwner && m.role !== "owner" ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${m.display_name}`} disabled={removeMember.isPending} onPress={() => removeMember.mutate({ groupId: id, userId: m.id })}>
                    <AppText style={{ color: colors.destructive, fontSize: 13 }}>Remove</AppText>
                  </Pressable>
                ) : null}
              </View>
            ))}
            {notSharing.length > 0 ? <AppText muted style={{ fontSize: 12 }}>{`${notSharing.length} not sharing progress`}</AppText> : null}
          </View>

          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Overline>Challenges</Overline>
              <Pressable accessibilityRole="button" accessibilityLabel="New challenge" onPress={() => setSheet(true)}>
                <AppText style={{ color: colors.primary, fontSize: 13, fontWeight: "600" }}>New challenge</AppText>
              </Pressable>
            </View>
            {(challenges.data ?? []).length === 0 ? (
              <AppText muted style={{ fontSize: 12 }}>No challenges yet. Start one.</AppText>
            ) : (
              (challenges.data ?? []).map((ch) => (
                <Pressable
                  key={ch.id}
                  accessibilityRole="button"
                  onPress={() => router.push(`/challenge/${ch.id}` as Href)}
                  style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}
                >
                  <View style={{ flex: 1 }}>
                    <AppText style={{ fontSize: 15, fontWeight: "600" }}>{ch.title}</AppText>
                    <AppText muted style={{ fontSize: 12 }}>{`${ch.status} · ${ch.metric === "logged" ? "Logged days" : "On-target days"} · ${ch.participant_count} in`}</AppText>
                  </View>
                  {ch.joined ? <AppText muted style={{ fontSize: 11 }}>Joined</AppText> : null}
                </Pressable>
              ))
            )}
          </View>

          {isOwner ? (
            <Button title="Delete group" variant="ghost" onPress={onDelete} disabled={del.isPending} />
          ) : (
            <Button title="Leave group" variant="ghost" onPress={onLeave} disabled={!profile.data?.id || leave.isPending} />
          )}
        </View>
      </ScrollView>
      {sheet ? <CreateChallengeSheet visible groupId={id} onClose={() => setSheet(false)} /> : null}
    </>
  );
}
