import { Alert, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { Overline } from "@/components/Overline";
import { useChallenge, useJoinChallenge, useLeaveChallenge, useDeleteChallenge } from "@/api/hooks";
import { useTheme } from "@/theme";

const METRIC_LABEL: Record<string, string> = { logged: "Logged days", on_target: "On-target days" };
const STATUS_LABEL: Record<string, string> = { upcoming: "Upcoming", active: "Active", ended: "Ended" };

export default function ChallengeDetailScreen() {
  const { colors, radius } = useTheme();
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
      <ScreenHeader overline={d ? `${STATUS_LABEL[d.status]} · ${METRIC_LABEL[d.metric]}` : "Challenge"} title={d?.title ?? "Challenge"} onBack={() => router.back()} />
      <View style={{ paddingHorizontal: 20, gap: 20 }}>
        {d?.status === "ended" && d.winner ? (
          <View style={{ padding: 16, borderRadius: radius.lg, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.primary }}>
            <AppText style={{ fontSize: 16, fontWeight: "700" }}>{`🏆 ${d.winner.display_name} wins`}</AppText>
            <AppText muted style={{ fontSize: 12 }}>{`${d.winner.score} ${d.metric === "logged" ? "days logged" : "days on target"}`}</AppText>
          </View>
        ) : null}

        <View style={{ gap: 10 }}>
          <Overline>Standings</Overline>
          {(d?.standings ?? []).length === 0 ? (
            <AppText muted style={{ fontSize: 12 }}>No one has joined yet.</AppText>
          ) : (
            (d?.standings ?? []).map((s, i) => (
              <View key={s.user_id} style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
                <AppText style={{ flex: 1, fontSize: 15, fontWeight: "600" }}>{`${i + 1}. ${s.display_name}`}</AppText>
                <AppText style={{ fontSize: 16, fontWeight: "700" }}>{s.score}</AppText>
              </View>
            ))
          )}
        </View>

        {d ? (
          d.joined ? (
            <Button title="Leave challenge" variant="secondary" onPress={() => leave.mutate({ challengeId: id, groupId })} disabled={leave.isPending} />
          ) : (
            <Button title="Join challenge" onPress={() => join.mutate({ challengeId: id, groupId })} disabled={join.isPending} />
          )
        ) : null}

        {d?.can_delete ? <Button title="Delete challenge" variant="ghost" onPress={onDelete} disabled={del.isPending} /> : null}
      </View>
    </ScrollView>
  );
}
