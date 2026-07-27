import { Alert, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Icon } from "@/components/Icon";
import { LeaderRow } from "@/components/LeaderRow";
import { GroupedSection } from "@/components/GroupedList";
import { useChallenge, useJoinChallenge, useLeaveChallenge, useDeleteChallenge } from "@/api/hooks";
import { useTheme } from "@/theme";

const METRIC_LABEL: Record<string, string> = { logged: "Logged days", on_target: "On-target days" };
const STATUS_LABEL: Record<string, string> = { upcoming: "Upcoming", active: "Active", ended: "Ended" };

export default function ChallengeDetailScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const challenge = useChallenge(id);
  const join = useJoinChallenge();
  const leave = useLeaveChallenge();
  const del = useDeleteChallenge();

  const d = challenge.data;
  const groupId = d?.group_id ?? "";

  const onDelete = () =>
    Alert.alert("Delete this challenge?", "This removes it for everyone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => del.mutate({ challengeId: id, groupId }, { onSuccess: () => router.back() }) },
    ]);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
      <ScreenHeader
        overline={d ? `${STATUS_LABEL[d.status]} · ${METRIC_LABEL[d.metric]}` : "Challenge"}
        overlineVariant="footnote"
        title={d?.title ?? "Challenge"}
        titleVariant="title1"
        onBack={() => router.back()}
      />
      <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
        {d?.status === "ended" && d.winner ? (
          <Card variant="elevated" style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Icon name="trophy" size={22} color={colors.accentAmber} />
            <View style={{ flex: 1 }}>
              <AppText variant="headline">{`${d.winner.display_name} wins`}</AppText>
              <AppText variant="footnote" muted>
                {`${d.winner.score} ${d.metric === "logged" ? "days logged" : "days on target"}`}
              </AppText>
            </View>
          </Card>
        ) : null}

        <GroupedSection header="Standings" elevated>
          {(d?.standings ?? []).length === 0 ? (
            <View style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.md }}>
              <AppText variant="footnote" muted>No one has joined yet.</AppText>
            </View>
          ) : (
            (d?.standings ?? []).map((s, i) => (
              <LeaderRow key={s.user_id} rank={i + 1} name={s.display_name} metric={String(s.score)} />
            ))
          )}
        </GroupedSection>

        {d ? (
          d.joined ? (
            <Button title="Leave challenge" variant="secondary" onPress={() => leave.mutate({ challengeId: id, groupId })} disabled={leave.isPending} />
          ) : (
            <Button title="Join challenge" onPress={() => join.mutate({ challengeId: id, groupId })} disabled={join.isPending} />
          )
        ) : null}

        {d?.can_delete ? <Button title="Delete challenge" variant="destructive" onPress={onDelete} disabled={del.isPending} /> : null}
      </View>
    </ScrollView>
  );
}
