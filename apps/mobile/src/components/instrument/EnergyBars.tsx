import { View } from "react-native";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";

export interface EnergyBarsDay {
  label: string;
  fraction: number;
  over: boolean;
}

export interface EnergyBarsProps {
  days: EnergyBarsDay[];
  targetFraction?: number;
}

export function EnergyBars({ days, targetFraction = 0.74 }: EnergyBarsProps) {
  const { instrument, fonts } = useTheme();
  const mono = { fontFamily: fonts.mono, fontVariant: ["tabular-nums" as const] };
  const engraved = {
    fontSize: 9,
    letterSpacing: 1.4,
    textTransform: "uppercase" as const,
    color: instrument.mut,
  };

  return (
    <View>
      <View style={{ height: 86, position: "relative", flexDirection: "row", alignItems: "flex-end", gap: 6 }}>
        <View
          testID="ebar-target"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: `${(1 - targetFraction) * 100}%`,
            borderTopWidth: 1.5,
            borderStyle: "dashed",
            borderColor: instrument.tick,
          }}
        />
        {days.map((d, i) => (
          <View
            key={i}
            testID={`ebar-${i}`}
            style={{
              flex: 1,
              height: `${Math.min(Math.max(d.fraction, 0), 1) * 100}%`,
              borderRadius: 6,
              backgroundColor: d.over ? instrument.accent : instrument.tickLit,
              opacity: d.over ? 1 : 0.72,
            }}
          />
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
        {days.map((d, i) => (
          <AppText key={i} style={[engraved, { flex: 1, textAlign: "center" }, mono]}>
            {d.label}
          </AppText>
        ))}
      </View>
    </View>
  );
}
