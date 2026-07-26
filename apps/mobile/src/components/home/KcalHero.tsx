import { View } from "react-native";
import { AppText } from "@/components/Text";
import { CircularProgress } from "@/components/CircularProgress";
import { AnimatedNumber } from "@/motion";
import { useTheme } from "@/theme";

interface KcalHeroProps {
  left: number;
  goal: number;
  eaten: number;
  loading?: boolean;
}

// Hero readout for the Home screen: a large SF-Rounded kcal-left number beside
// a circular ring showing eaten/goal. `loading` swaps the number for a plain
// "—" placeholder so a fresh dashboard fetch never flashes "0 kcal left".
export function KcalHero({ left, goal, eaten, loading = false }: KcalHeroProps) {
  const { colors, fonts } = useTheme();
  const numberStyle = { fontSize: 52, fontWeight: "700" as const, fontFamily: fonts.rounded, color: colors.label };

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 20 }}>
      <View style={{ flex: 1 }}>
        {loading ? (
          <AppText style={numberStyle}>—</AppText>
        ) : (
          <AnimatedNumber value={left} style={numberStyle} />
        )}
        <AppText variant="footnote" muted>
          calories left
        </AppText>
      </View>
      <CircularProgress value={eaten} max={goal} size={72} stroke={8} />
    </View>
  );
}
