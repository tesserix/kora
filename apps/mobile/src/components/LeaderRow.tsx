import { View } from "react-native";
import { AppText } from "./Text";
import { Numeral } from "./Numeral";
import { Avatar } from "./Avatar";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";
import { withAlpha } from "@/lib/color";

type Props = { rank: number; name: string; sub?: string; metric: string; isYou?: boolean; onPress?: () => void };

export function LeaderRow({ rank, name, sub, metric, isYou = false, onPress }: Props) {
  const { colors, radius, spacing } = useTheme();
  const initials = name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  return (
    <PressableScale testID="leader-row" accessibilityRole={onPress ? "button" : undefined} haptic={onPress ? "selection" : "none"} onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: isYou ? withAlpha(colors.accent, 0.12) : "transparent" }}>
      <Numeral size={15} color={colors.mutedForeground}>{String(rank)}</Numeral>
      <Avatar initials={initials} />
      <View style={{ flex: 1 }}>
        <AppText variant="headline" style={isYou ? { color: colors.accent } : undefined}>{name}</AppText>
        {sub ? <AppText variant="footnote" muted>{sub}</AppText> : null}
      </View>
      <AppText variant="headline" style={{ color: isYou ? colors.accent : colors.label }}>{metric}</AppText>
    </PressableScale>
  );
}
