import { View } from "react-native";
import { AppText } from "./Text";
import { Numeral } from "./Numeral";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";

type Props = { label: string; value: string; unit?: string; delta?: string; trend?: "up" | "down" };

export function Stat({ label, value, unit, delta, trend }: Props) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 2 }}>
      <AppText muted style={{ fontSize: 12, fontWeight: "600" }}>{label}</AppText>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
        <Numeral size={22}>{value}</Numeral>
        {unit ? <AppText muted style={{ fontSize: 12 }}>{unit}</AppText> : null}
      </View>
      {delta ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          {trend ? <Icon name={trend === "up" ? "trending-up" : "trending-down"} size={12} color={colors.success} /> : null}
          <AppText style={{ fontSize: 11, color: colors.success, fontWeight: "600" }}>{delta}</AppText>
        </View>
      ) : null}
    </View>
  );
}
