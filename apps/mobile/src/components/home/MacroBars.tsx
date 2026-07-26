import { useEffect } from "react";
import { View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { AppText } from "@/components/Text";
import { springs, useMotionPrefs } from "@/motion";
import { useTheme } from "@/theme";

export interface Macros {
  p: number;
  c: number;
  f: number;
  pGoal: number;
  cGoal: number;
  fGoal: number;
}

interface BarProps {
  label: string;
  value: number;
  goal: number;
  color: string;
}

function Bar({ label, value, goal, color }: BarProps) {
  const { colors, radius } = useTheme();
  const { reduceMotion } = useMotionPrefs();
  const pct = goal > 0 ? Math.min(100, Math.max(0, (value / goal) * 100)) : 0;
  const width = useSharedValue(pct);

  useEffect(() => {
    width.value = reduceMotion ? pct : withSpring(pct, springs.standard);
  }, [pct, reduceMotion, width]);

  const animatedStyle = useAnimatedStyle(() => ({ width: `${width.value}%` }));

  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <AppText variant="footnote" muted>
          {label}
        </AppText>
        <AppText variant="footnote" muted>
          {`${Math.round(value)}g / ${Math.round(goal)}g`}
        </AppText>
      </View>
      <View style={{ height: 6, borderRadius: radius.full, backgroundColor: colors.muted, overflow: "hidden" }}>
        <Animated.View style={[{ height: 6, borderRadius: radius.full, backgroundColor: color }, animatedStyle]} />
      </View>
    </View>
  );
}

// Three horizontal macro bars (protein/carbs/fat) for the Home hero card —
// colored from theme tokens only (accent/accentAmber/accentBlue).
export function MacroBars({ macros }: { macros: Macros }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 12, marginTop: 16 }}>
      <Bar label="Protein" value={macros.p} goal={macros.pGoal} color={colors.accent} />
      <Bar label="Carbs" value={macros.c} goal={macros.cGoal} color={colors.accentAmber} />
      <Bar label="Fat" value={macros.f} goal={macros.fGoal} color={colors.accentBlue} />
    </View>
  );
}
