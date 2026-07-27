import { useEffect, useId } from "react";
import { View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import Animated, { useAnimatedProps, useSharedValue, withSpring } from "react-native-reanimated";
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

const AnimatedRect = Animated.createAnimatedComponent(Rect);
const BAR_H = 8;

interface BarProps {
  label: string;
  value: number;
  goal: number;
  gradient: [string, string];
}

function Bar({ label, value, goal, gradient }: BarProps) {
  const { colors } = useTheme();
  const { reduceMotion } = useMotionPrefs();
  const gid = useId();
  const pct = goal > 0 ? Math.min(100, Math.max(0, (value / goal) * 100)) : 0;
  const w = useSharedValue(pct);

  useEffect(() => {
    w.value = reduceMotion ? pct : withSpring(pct, springs.standard);
  }, [pct, reduceMotion, w]);

  const animatedProps = useAnimatedProps(() => ({ width: w.value }));
  const key = label.toLowerCase();

  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <AppText variant="footnote" muted>{label}</AppText>
        <AppText variant="footnote" muted style={{ fontVariant: ["tabular-nums"] }}>
          {`${Math.round(value)}g / ${Math.round(goal)}g`}
        </AppText>
      </View>
      {/* viewBox width 100 == percent; preserveAspectRatio none lets it stretch full width */}
      <Svg width="100%" height={BAR_H} viewBox={`0 0 100 ${BAR_H}`} preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0%" stopColor={gradient[0]} />
            <Stop offset="100%" stopColor={gradient[1]} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={100} height={BAR_H} rx={BAR_H / 2} fill={colors.muted} />
        <AnimatedRect testID={`macro-fill-${key}`} x={0} y={0} height={BAR_H} rx={BAR_H / 2} fill={`url(#${gid})`} animatedProps={animatedProps} />
      </Svg>
    </View>
  );
}

// Three macro bars (protein/carbs/fat) with SVG gradient fills — tokens only.
export function MacroBars({ macros }: { macros: Macros }) {
  const { gradients } = useTheme();
  return (
    <View style={{ gap: 12, marginTop: 0 }}>
      <Bar label="Protein" value={macros.p} goal={macros.pGoal} gradient={gradients.green} />
      <Bar label="Carbs" value={macros.c} goal={macros.cGoal} gradient={gradients.amber} />
      <Bar label="Fat" value={macros.f} goal={macros.fGoal} gradient={gradients.blue} />
    </View>
  );
}
