import { View } from "react-native";
import { AppText } from "@/components/Text";
import { GaugeRing } from "@/components/GaugeRing";
import { MacroBars, type Macros } from "./MacroBars";
import { AnimatedNumber } from "@/motion";
import { useTheme } from "@/theme";

interface KcalHeroProps {
  left: number;
  goal: number;
  eaten: number;
  loading?: boolean;
  macros?: Macros;
}

// Hero readout for the Home screen: a 150pt ring (eaten/goal) with the kcal-left
// number set INSIDE it, and macro bars beside it (flex:1) when provided.
// `loading` swaps the number for a plain "—" placeholder so a fresh dashboard
// fetch never flashes "0 kcal left".
export function KcalHero({ left, goal, eaten, loading = false, macros }: KcalHeroProps) {
  const { colors, fonts, gradients } = useTheme();
  const numberStyle = { fontSize: 40, fontWeight: "800" as const, fontFamily: fonts.rounded, color: colors.label, letterSpacing: -1.5 };

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 20 }}>
      <GaugeRing value={eaten} max={goal} size={150} stroke={15} gradient={gradients.green}>
        <View style={{ alignItems: "center" }}>
          {loading ? (
            <AppText style={numberStyle}>—</AppText>
          ) : (
            <AnimatedNumber value={left} style={numberStyle} />
          )}
          <AppText variant="footnote" muted>
            kcal left
          </AppText>
        </View>
      </GaugeRing>
      {macros ? (
        <View style={{ flex: 1 }}>
          <MacroBars macros={macros} />
        </View>
      ) : null}
    </View>
  );
}
