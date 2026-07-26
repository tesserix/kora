import { useState } from "react";
import { Pressable, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useFriends, useInviteToGroup } from "@/api/hooks";
import { useTheme } from "@/theme";

interface Props {
  visible: boolean;
  groupId: string;
  memberIds: string[];
  onClose: () => void;
}

export function InviteFriendSheet({ visible, groupId, memberIds, onClose }: Props) {
  const { colors, radius } = useTheme();
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
      <View style={{ paddingHorizontal: 22, paddingBottom: 30, gap: 8 }}>
        <Overline>Invite a friend</Overline>
        {eligible.length === 0 ? (
          <AppText muted style={{ fontSize: 13, paddingVertical: 8 }}>
            No friends to invite. Everyone's already in, or add friends first.
          </AppText>
        ) : (
          eligible.map((f) => (
            <Pressable
              key={f.id}
              accessibilityRole="button"
              accessibilityLabel={`Invite ${f.display_name}`}
              disabled={invite.isPending}
              onPress={() => onInvite(f.id)}
              style={{ flexDirection: "row", alignItems: "center", padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}
            >
              <AppText style={{ flex: 1, fontSize: 15, fontWeight: "600" }}>{f.display_name}</AppText>
              <AppText style={{ color: colors.primary, fontSize: 13, fontWeight: "600" }}>Invite</AppText>
            </Pressable>
          ))
        )}
        {err ? <AppText style={{ color: colors.destructive, marginTop: 6 }}>{err}</AppText> : null}
      </View>
    </Sheet>
  );
}
