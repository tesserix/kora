import { View } from "react-native";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";
import { GlassPanel } from "./GlassPanel";
import { SubDial } from "./SubDial";

export interface MacroWideProps {
  label: string;
  value: number;
  goal: number;
  unit?: string;
}

export function MacroWide({ label, value, goal, unit = "g" }: MacroWideProps) {
  const { instrument, fonts } = useTheme();
  const mono = { fontFamily: fonts.mono, fontVariant: ["tabular-nums" as const] };
  const engraved = {
    fontSize: 9,
    letterSpacing: 1.4,
    textTransform: "uppercase" as const,
    color: instrument.mut,
  };
  const fraction = goal > 0 ? value / goal : 0;
  const toGo = Math.max(0, goal - value);

  return (
    <GlassPanel radius={22} testID="macro-wide">
      <View style={{ flexDirection: "row", alignItems: "center", padding: 14, gap: 12 }}>
        <SubDial fraction={fraction} testID="macro-wide-subdial" />
        <View style={{ flex: 1 }}>
          <AppText style={engraved}>{label}</AppText>
          <AppText style={[{ fontSize: 15, fontWeight: "600", color: instrument.ink }, mono]}>
            {value}/{goal}
          </AppText>
          <View
            style={{
              height: 5,
              borderRadius: 3,
              backgroundColor: instrument.inset,
              overflow: "hidden",
              marginTop: 6,
            }}
          >
            <View
              style={{
                height: "100%",
                width: `${Math.min(fraction, 1) * 100}%`,
                backgroundColor: instrument.accent,
                borderRadius: 3,
              }}
            />
          </View>
        </View>
        <AppText style={[{ fontSize: 11, color: instrument.mut }, mono]}>
          {toGo}
          {unit} to go
        </AppText>
      </View>
    </GlassPanel>
  );
}
