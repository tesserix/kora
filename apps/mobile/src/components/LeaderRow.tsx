import { StyleSheet, View } from "react-native";
import { AppText } from "./Text";
import { Avatar } from "./Avatar";
import { PressableScale } from "@/motion";
import { initials } from "@/lib/initials";
import { useTheme } from "@/theme";
import { monoStyle } from "@/components/instrument/typography";

// `uri` is optional and unused by every current caller (kora#454): the
// leaderboard sources — FriendProgress, GroupMemberView, and the challenge
// leaderboard entry — don't carry avatar_url on the wire, so there is no
// data to thread through without an API change. The prop exists so a caller
// that does get avatar data later doesn't need this component touched again.
type Props = {
  rank: number;
  name: string;
  sub?: string;
  metric: string;
  isYou?: boolean;
  onPress?: () => void;
  uri?: string | null;
};

// Restyled to Instrument Glass: the "you" row highlight moves from an
// accent-tinted fill to inset+glassBorder — the accent budget on a
// leaderboard belongs to something rarer than "this is you" (spec:
// LeaderRow.tsx > "leader 'you' highlight = inset+glassBorder, not accent
// fill").
export function LeaderRow({ rank, name, sub, metric, isYou = false, onPress, uri }: Props) {
  const { instrument, spacing, fonts } = useTheme();
  const mono = monoStyle(fonts);
  return (
    <PressableScale
      testID="leader-row"
      accessibilityRole={onPress ? "button" : undefined}
      haptic={onPress ? "selection" : "none"}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: spacing.md,
        borderRadius: 12,
        backgroundColor: isYou ? instrument.inset : "transparent",
        borderWidth: isYou ? StyleSheet.hairlineWidth : 0,
        borderColor: instrument.glassBorder,
      }}
    >
      <AppText style={[{ fontSize: 15, fontWeight: "600", color: instrument.mut }, mono]}>{String(rank)}</AppText>
      <Avatar initials={initials(name)} uri={uri} />
      <View style={{ flex: 1 }}>
        <AppText variant="headline" style={{ color: instrument.ink }}>{name}</AppText>
        {sub ? <AppText style={[{ fontSize: 13, color: instrument.mut }, mono]}>{sub}</AppText> : null}
      </View>
      <AppText style={[{ fontSize: 17, fontWeight: "600", color: instrument.ink }, mono]}>{metric}</AppText>
    </PressableScale>
  );
}
