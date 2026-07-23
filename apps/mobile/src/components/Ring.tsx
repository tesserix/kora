import { View } from "react-native";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

type Props = { value: number; max: number; label: string };

export function Ring({ value, max, label }: Props) {
  const { colors, radius, spacing } = useTheme();
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <View style={{ gap: spacing.sm, alignItems: "center" }}>
      <AppText variant="h1">{Math.round(value)}</AppText>
      <AppText muted>
        of {Math.round(max)} {label} · {pct}%
      </AppText>
      <View style={{ height: 10, width: "100%", backgroundColor: colors.muted, borderRadius: radius.full }}>
        <View style={{ height: 10, width: `${pct}%`, backgroundColor: colors.primary, borderRadius: radius.full }} />
      </View>
    </View>
  );
}
