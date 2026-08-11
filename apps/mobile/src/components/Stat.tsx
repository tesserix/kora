import { View } from "react-native";
import { AppText } from "./Text";
import { Numeral } from "./Numeral";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";

type Props = { label: string; value: string; unit?: string; delta?: string; trend?: "up" | "down"; valueColor?: string };

// Bare value/label stack (no bordered box) — composed inside Card / GroupedSection.
// The delta/trend indicator defaults to `instrument.ink` rather than
// `colors.success` (green): a generic "this changed" signal isn't a success
// state, and green is reserved (spec: "no new green"). Callers that need a
// genuinely positive/negative tint still pass `valueColor` explicitly.
export function Stat({ label, value, unit, delta, trend, valueColor }: Props) {
  const { instrument } = useTheme();
  return (
    <View style={{ gap: 2 }}>
      <AppText style={{ fontSize: 13, color: instrument.mut }}>
        {label}
      </AppText>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
        <Numeral size={22} color={valueColor ?? instrument.ink}>{value}</Numeral>
        {unit ? (
          <AppText style={{ fontSize: 13, color: instrument.mut }}>
            {unit}
          </AppText>
        ) : null}
      </View>
      {delta ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          {trend ? <Icon name={trend === "up" ? "trending-up" : "trending-down"} size={12} color={instrument.ink} /> : null}
          <AppText style={{ fontSize: 11, color: instrument.ink }}>
            {delta}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}
