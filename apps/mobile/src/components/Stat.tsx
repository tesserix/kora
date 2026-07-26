import { View } from "react-native";
import { AppText } from "./Text";
import { Numeral } from "./Numeral";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";

type Props = { label: string; value: string; unit?: string; delta?: string; trend?: "up" | "down"; valueColor?: string };

// Bare value/label stack (no bordered box) — composed inside Card / GroupedSection.
export function Stat({ label, value, unit, delta, trend, valueColor }: Props) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 2 }}>
      <AppText variant="footnote" muted>
        {label}
      </AppText>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
        <Numeral size={22} color={valueColor}>{value}</Numeral>
        {unit ? (
          <AppText variant="footnote" muted>
            {unit}
          </AppText>
        ) : null}
      </View>
      {delta ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          {trend ? <Icon name={trend === "up" ? "trending-up" : "trending-down"} size={12} color={colors.success} /> : null}
          <AppText variant="caption" style={{ color: colors.success }}>
            {delta}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}
