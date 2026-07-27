import type { ReactNode } from "react";
import { useEffect, useId } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";
import Animated, { useAnimatedProps, useSharedValue, withSpring } from "react-native-reanimated";
import { useTheme } from "@/theme";
import { springs, useMotionPrefs } from "@/motion";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

type Props = {
  value: number;
  max: number;
  size?: number;
  stroke?: number;
  gradient?: [string, string];
  color?: string;
  track?: string;
  children?: ReactNode;
};

// Filled gradient progress ring. Animates only strokeDashoffset (a number) on
// the UI thread — no JS fn ever runs in a worklet (AnimatedNumber crash class).
// Reduced motion seeds the settled offset so the first paint is correct.
export function GaugeRing({ value, max, size = 72, stroke = 8, gradient, color, track, children }: Props) {
  const { colors } = useTheme();
  const { reduceMotion } = useMotionPrefs();
  const gid = useId();
  const trackColor = track ?? colors.muted;
  const pct = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const half = size / 2;
  const targetOffset = circumference * (1 - pct);
  const strokeColor = gradient ? `url(#${gid})` : (color ?? colors.primary);

  const offset = useSharedValue(targetOffset);
  useEffect(() => {
    offset.value = reduceMotion ? targetOffset : withSpring(targetOffset, springs.standard);
  }, [targetOffset, reduceMotion, offset]);

  const animatedProps = useAnimatedProps(() => ({ strokeDashoffset: offset.value }));

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        {gradient ? (
          <Defs>
            <LinearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0%" stopColor={gradient[0]} />
              <Stop offset="100%" stopColor={gradient[1]} />
            </LinearGradient>
          </Defs>
        ) : null}
        <Circle cx={half} cy={half} r={r} stroke={trackColor} strokeWidth={stroke} fill="none" />
        <AnimatedCircle
          testID="gauge-arc"
          cx={half}
          cy={half}
          r={r}
          stroke={strokeColor}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          animatedProps={animatedProps}
          transform={`rotate(-90 ${half} ${half})`}
        />
      </Svg>
      <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>{children}</View>
    </View>
  );
}
