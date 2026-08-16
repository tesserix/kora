import { useState } from "react";
import { Alert, ScrollView, Share, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams, type Href } from "expo-router";
import { safeBack } from "@/lib/safeBack";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { LeaderRow } from "@/components/LeaderRow";
import { GroupedSection, Row } from "@/components/GroupedList";
import { PressableScale } from "@/motion";
import { CreateChallengeSheet } from "@/components/social/CreateChallengeSheet";
import { RenameGroupSheet } from "@/components/social/RenameGroupSheet";
import { InviteFriendSheet } from "@/components/social/InviteFriendSheet";
import { useGroup, useGroupProgress, useGroupCode, useLeaveGroup, useRemoveMember, useDeleteGroup, useProfile, useGroupChallenges } from "@/api/hooks";
import { useToast } from "@/components/Toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { useTheme } from "@/theme";

const METRIC_LABEL: Record<string, string> = { logged: "Logged days", on_target: "On-target days" };

// A group board has no "You" anchor row (every member is a peer), so this screen
// renders its own ranked list rather than reusing FriendsLeaderboard.

export default function GroupDetail() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const detail = useGroup(id);
  const progress = useGroupProgress(id);
  const code = useGroupCode(id);
  const leave = useLeaveGroup();
  const removeMember = useRemoveMember();
  const toast = useToast();
  const del = useDeleteGroup();
  const challenges = useGroupChallenges(id);
  const [sheet, setSheet] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const profile = useProfile();

  // #83: all three of this screen's mutations ran with no error surface. Their
  // buttons gate on isPending, so a silent failure read as a broken control
  // rather than a failed request. The onSuccess handlers are preserved — the
  // navigation on a successful leave/delete still happens.
  const onError = (error: unknown) => toast.show({ message: apiErrorMessage(error) });

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
      { text: "Delete", style: "destructive", onPress: () => del.mutate(id, { onSuccess: () => router.back(), onError }) },
    ]);

  // #174: this shipped with "" as its message, which renders a title-only
  // alert — every other confirm on this screen (and in friends.tsx) states the
  // consequence, so this one does too.
  const onLeave = () =>
    Alert.alert("Leave this group?", "You'll drop off its leaderboard and challenges. You can rejoin with an invite code.", [
      { text: "Cancel", style: "cancel" },
      { text: "Leave", style: "destructive", onPress: () => leave.mutate({ groupId: id, userId: profile.data?.id ?? "" }, { onSuccess: () => router.back(), onError }) },
    ]);

  // #174: removing a member was the one unconfirmed action on this screen, and
  // the only one whose consequence lands on someone else. It gets the same
  // confirm as delete/leave/unfriend, naming the member so the owner can see
  // which row they hit.
  const onRemoveMember = (userId: string, name: string) =>
    Alert.alert(`Remove ${name}?`, `${name} loses access to this group. You can invite them back later.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => removeMember.mutate({ groupId: id, userId }, { onError }) },
    ]);

  const leaveDisabled = !profile.data?.id || leave.isPending;

  return (
    <>
      <View style={{ flex: 1, backgroundColor: instrument.bg }}>
        <AppBackground />
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
          <ScreenHeader overline="Group" title={d?.name ?? "Group"} onBack={() => safeBack("/groups")} />

          <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
            <GroupedSection>
              <Row title="Share invite code" subtitle={code.data?.code} onPress={shareCode} />
              {isOwner ? <Row title="Rename group" chevron onPress={() => setRenameOpen(true)} /> : null}
              {isOwner ? <Row title="Invite a friend" chevron onPress={() => setInviteOpen(true)} /> : null}
            </GroupedSection>

            <GroupedSection header="Leaderboard">
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

            <GroupedSection header="Members" footer={notSharing.length > 0 ? `${notSharing.length} not sharing progress` : undefined}>
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
                        onPress={() => onRemoveMember(m.id, m.display_name)}
                        style={{ opacity: removeMember.isPending ? 0.5 : 1 }}
                      >
                        <AppText style={{ fontSize: 13, color: instrument.danger, fontWeight: "600" }}>
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
                <AppText style={{ fontSize: 11, letterSpacing: 0.5, textTransform: "uppercase", color: instrument.mut, fontWeight: "500" }}>
                  Challenges
                </AppText>
                <PressableScale accessibilityRole="button" accessibilityLabel="New challenge" haptic="none" onPress={() => setSheet(true)}>
                  <AppText style={{ fontSize: 13, color: instrument.accent, fontWeight: "600" }}>
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
                    <AppText style={{ fontSize: 17, fontWeight: "600", color: instrument.danger }}>
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
                    <AppText style={{ fontSize: 17, fontWeight: "600", color: instrument.danger }}>
                      Leave group
                    </AppText>
                  </View>
                </PressableScale>
              )}
            </GroupedSection>
          </View>
        </ScrollView>
      </View>
      {sheet ? <CreateChallengeSheet visible groupId={id} onClose={() => setSheet(false)} /> : null}
      {renameOpen && d ? <RenameGroupSheet visible groupId={id} currentName={d.name} onClose={() => setRenameOpen(false)} /> : null}
      {inviteOpen ? <InviteFriendSheet visible groupId={id} memberIds={(d?.members ?? []).map((m) => m.id)} onClose={() => setInviteOpen(false)} /> : null}
    </>
  );
}
