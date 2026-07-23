import { View } from "react-native";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

type Props = { label: string; value: number; target: number; color: string };

export function MacroBar({ label, value, target, color }: Props) {
  const { colors, radius, spacing } = useTheme();
  const pct = target > 0 ? Math.min(100, Math.round((value / target) * 100)) : 0;
  return (
    <View style={{ gap: spacing.xs }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <AppText>{label}</AppText>
        <AppText muted>
          {Math.round(value)} / {Math.round(target)} g
        </AppText>
      </View>
      <View style={{ height: spacing.sm, backgroundColor: colors.muted, borderRadius: radius.full }}>
        <View style={{ height: spacing.sm, width: `${pct}%`, backgroundColor: color, borderRadius: radius.full }} />
      </View>
    </View>
  );
}
