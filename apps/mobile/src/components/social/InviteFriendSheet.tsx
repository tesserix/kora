import { useState } from "react";
import { View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { GroupedSection } from "@/components/GroupedList";
import { PressableScale } from "@/motion";
import { useFriends, useInviteToGroup } from "@/api/hooks";
import { useTheme } from "@/theme";

interface Props {
  visible: boolean;
  groupId: string;
  memberIds: string[];
  onClose: () => void;
}

export function InviteFriendSheet({ visible, groupId, memberIds, onClose }: Props) {
  const { colors, spacing } = useTheme();
  const [err, setErr] = useState<string | null>(null);
  const friends = useFriends();
  const invite = useInviteToGroup();

  const eligible = (friends.data ?? []).filter((f) => !memberIds.includes(f.id));

  const onInvite = (userId: string) => {
    setErr(null);
    invite.mutate(
      { groupId, userId },
      { onSuccess: () => onClose(), onError: () => setErr("Couldn't invite. Try again.") },
    );
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30, gap: spacing.sm }}>
        <Overline>Invite a friend</Overline>
        {eligible.length === 0 ? (
          <AppText muted style={{ fontSize: 13, paddingVertical: 8 }}>
            No friends to invite. Everyone's already in, or add friends first.
          </AppText>
        ) : (
          <GroupedSection>
            {eligible.map((f) => (
              <PressableScale
                key={f.id}
                accessibilityRole="button"
                accessibilityLabel={`Invite ${f.display_name}`}
                haptic="none"
                disabled={invite.isPending}
                onPress={() => onInvite(f.id)}
                style={{ opacity: invite.isPending ? 0.5 : 1 }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingHorizontal: spacing.md }}>
                  <AppText variant="headline" style={{ flex: 1 }}>{f.display_name}</AppText>
                  <AppText variant="subheadline" style={{ color: colors.accent, fontWeight: "600" }}>Invite</AppText>
                </View>
              </PressableScale>
            ))}
          </GroupedSection>
        )}
        {err ? <AppText style={{ color: colors.destructive, marginTop: 6 }}>{err}</AppText> : null}
      </View>
    </Sheet>
  );
}
