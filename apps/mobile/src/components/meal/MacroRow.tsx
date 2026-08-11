import { View } from "react-native";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";
import { engravedStyle } from "./mealStyles";
import { monoStyle } from "@/components/instrument/typography";

export interface MacroRowProps {
  label: string;
  grams: number;
  pct: number;
}

// One row of app/meal.tsx's macro breakdown panel: a 70pt engraved-label
// column, a 5px inset track with an accent fill, and the mono gram value +
// "· N%" mut share of this meal's macro calories (Atwater factors —
// protein/carbs 4 kcal/g, fat 9 kcal/g — computed from figures the screen
// already has, no extra fetch required).
export function MacroRow({ label, grams, pct }: MacroRowProps) {
  const { instrument, fonts } = useTheme();
  const mono = monoStyle(fonts);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <View style={{ width: 70 }}>
        <AppText style={engravedStyle(instrument)}>{label}</AppText>
      </View>
      <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: instrument.inset, overflow: "hidden" }}>
        <View
          style={{
            height: "100%",
            width: `${Math.min(Math.max(pct, 0), 100)}%`,
            backgroundColor: instrument.accent,
            borderRadius: 3,
          }}
        />
      </View>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4, minWidth: 64, justifyContent: "flex-end" }}>
        <AppText style={[{ fontSize: 13, fontWeight: "600", color: instrument.ink }, mono]}>{grams}g</AppText>
        <AppText style={[{ fontSize: 11, color: instrument.mut }, mono]}>{`· ${pct}%`}</AppText>
      </View>
    </View>
  );
}
