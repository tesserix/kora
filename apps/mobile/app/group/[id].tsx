import { useState } from "react";
import { Alert, ScrollView, Share, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams, type Href } from "expo-router";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { Icon } from "@/components/Icon";
import { LeaderRow } from "@/components/LeaderRow";
import { GroupedSection, Row } from "@/components/GroupedList";
import { PressableScale } from "@/motion";
import { CreateChallengeSheet } from "@/components/social/CreateChallengeSheet";
import { RenameGroupSheet } from "@/components/social/RenameGroupSheet";
import { InviteFriendSheet } from "@/components/social/InviteFriendSheet";
import { useGroup, useGroupProgress, useGroupCode, useLeaveGroup, useRemoveMember, useDeleteGroup, useProfile, useGroupChallenges } from "@/api/hooks";
import { useTheme } from "@/theme";

const METRIC_LABEL: Record<string, string> = { logged: "Logged days", on_target: "On-target days" };

// A group board has no "You" anchor row (every member is a peer), so this screen
// renders its own ranked list rather than reusing FriendsLeaderboard.

export default function GroupDetail() {
  const { colors, spacing } = useTheme();
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
  const [renameOpen, setRenameOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const profile = useProfile();
  const d = detail.data;
  const isOwner = d?.my_role === "owner";
  const members = progress.data?.members ?? [];
  // Consent gate: only members who opted in to sharing (`sharing: true`) are
  // ranked with metrics. Non-sharers are never rendered per-member with a
  // streak/adherence value — they are only surfaced as a count, below.
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

  const leaveDisabled = !profile.data?.id || leave.isPending;

  return (
    <>
      <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", paddingHorizontal: 20, paddingTop: 4, paddingBottom: 14 }}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Go back"
            haptic="selection"
            onPress={() => router.back()}
            style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center", marginRight: 4, marginLeft: -6 }}
          >
            <Icon name="arrow-left" size={22} color={colors.label} />
          </PressableScale>
          <View style={{ flex: 1 }}>
            <Overline>Group</Overline>
            <AppText variant="title2" style={{ marginTop: 4 }}>{d?.name ?? "Group"}</AppText>
          </View>
        </View>

        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          <GroupedSection elevated>
            <Row title="Share invite code" subtitle={code.data?.code} onPress={shareCode} />
            {isOwner ? <Row title="Rename group" chevron onPress={() => setRenameOpen(true)} /> : null}
            {isOwner ? <Row title="Invite a friend" chevron onPress={() => setInviteOpen(true)} /> : null}
          </GroupedSection>

          <GroupedSection header="Leaderboard" elevated>
            {ranked.map((m, i) => (
              <LeaderRow
                key={m.id}
                rank={i + 1}
                name={m.display_name}
                sub={`${m.adherence_days ?? 0}/7 on target`}
                metric={`${m.streak_days ?? 0}d`}
                isYou={m.id === profile.data?.id}
              />
            ))}
          </GroupedSection>

          <GroupedSection header="Members" elevated footer={notSharing.length > 0 ? `${notSharing.length} not sharing progress` : undefined}>
            {(d?.members ?? []).map((m) => (
              <Row
                key={m.id}
                title={m.display_name}
                subtitle={m.role}
                right={
                  isOwner && m.role !== "owner" ? (
                    <PressableScale
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${m.display_name}`}
                      haptic="none"
                      disabled={removeMember.isPending}
                      onPress={() => removeMember.mutate({ groupId: id, userId: m.id })}
                      style={{ opacity: removeMember.isPending ? 0.5 : 1 }}
                    >
                      <AppText variant="footnote" style={{ color: colors.destructive, fontWeight: "600" }}>
                        Remove
                      </AppText>
                    </PressableScale>
                  ) : undefined
                }
              />
            ))}
          </GroupedSection>

          <View style={{ gap: spacing.sm }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginLeft: spacing.md }}>
              <AppText variant="caption" muted style={{ textTransform: "uppercase" }}>
                Challenges
              </AppText>
              <PressableScale accessibilityRole="button" accessibilityLabel="New challenge" haptic="none" onPress={() => setSheet(true)}>
                <AppText variant="footnote" style={{ color: colors.accent, fontWeight: "600" }}>
                  New challenge
                </AppText>
              </PressableScale>
            </View>
            <GroupedSection>
              {(challenges.data ?? []).length === 0 ? (
                <Row title="No challenges yet" subtitle="Start one." />
              ) : (
                (challenges.data ?? []).map((ch) => (
                  <Row
                    key={ch.id}
                    title={ch.title}
                    subtitle={`${ch.status} · ${METRIC_LABEL[ch.metric] ?? ch.metric} · ${ch.participant_count} in`}
                    detail={ch.joined ? "Joined" : undefined}
                    chevron
                    onPress={() => router.push(`/challenge/${ch.id}` as Href)}
                  />
                ))
              )}
            </GroupedSection>
          </View>

          <GroupedSection>
            {isOwner ? (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Delete group"
                haptic="none"
                disabled={del.isPending}
                onPress={onDelete}
                style={{ opacity: del.isPending ? 0.5 : 1 }}
              >
                <View style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.md }}>
                  <AppText variant="headline" style={{ color: colors.destructive }}>
                    Delete group
                  </AppText>
                </View>
              </PressableScale>
            ) : (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Leave group"
                haptic="none"
                disabled={leaveDisabled}
                onPress={onLeave}
                style={{ opacity: leaveDisabled ? 0.5 : 1 }}
              >
                <View style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.md }}>
                  <AppText variant="headline" style={{ color: colors.destructive }}>
                    Leave group
                  </AppText>
                </View>
              </PressableScale>
            )}
          </GroupedSection>
        </View>
      </ScrollView>
      {sheet ? <CreateChallengeSheet visible groupId={id} onClose={() => setSheet(false)} /> : null}
      {renameOpen && d ? <RenameGroupSheet visible groupId={id} currentName={d.name} onClose={() => setRenameOpen(false)} /> : null}
      {inviteOpen ? <InviteFriendSheet visible groupId={id} memberIds={(d?.members ?? []).map((m) => m.id)} onClose={() => setInviteOpen(false)} /> : null}
    </>
  );
}
