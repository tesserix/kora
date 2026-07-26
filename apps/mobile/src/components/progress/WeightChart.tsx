import { useEffect } from "react";
import { View } from "react-native";
import Svg, { Defs, LinearGradient, Stop, Polygon, Polyline, Circle } from "react-native-svg";
import Animated, { Easing, useAnimatedProps, useSharedValue, withTiming } from "react-native-reanimated";
import { useMotionPrefs } from "@/motion";
import { useTheme } from "@/theme";

type Props = { points: number[] };

const AnimatedPolyline = Animated.createAnimatedComponent(Polyline);
const AnimatedPolygon = Animated.createAnimatedComponent(Polygon);
const DRAW_DURATION = 700;

// Weight trend chart: an SVG polyline + gradient-filled area. Callers are
// responsible for the >=2-point guard (see app/(tabs)/progress.tsx) — this
// component assumes points.length >= 2 and does no internal guarding, exactly
// as before.
export function WeightChart({ points }: Props) {
  const { colors } = useTheme();
  const { reduceMotion } = useMotionPrefs();
  const w = 300;
  const h = 130;
  const pad = 10;
  const min = Math.min(...points) - 0.4;
  const max = Math.max(...points) + 0.4;
  const x = (i: number) => pad + (i * (w - pad * 2)) / (points.length - 1);
  const y = (v: number) => pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
  const line = points.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${x(0)},${h - pad} ${line} ${x(points.length - 1)},${h - pad}`;

  // On-screen length of the polyline (sum of segment lengths). Used as the
  // strokeDasharray so a single dash spans the whole path — animating its
  // strokeDashoffset from `length` (fully hidden) to 0 (fully revealed)
  // draws the line in left-to-right.
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(x(i) - x(i - 1), y(points[i]) - y(points[i - 1]));
  }

  // Key the redraw effect off the actual values (not just array identity —
  // `points` is a fresh array every render) so a range switch that yields a
  // different series retriggers the draw-in, while unrelated re-renders don't.
  const pointsKey = points.join(",");

  // Reduced motion renders already-settled (fully drawn, opaque) on the very
  // first paint — no tween ever runs. Full motion starts hidden so the first
  // mount (and every subsequent points change) genuinely draws in.
  const dashOffset = useSharedValue(reduceMotion ? 0 : length);
  const areaOpacity = useSharedValue(reduceMotion ? 1 : 0);

  useEffect(() => {
    if (reduceMotion) {
      dashOffset.value = 0;
      areaOpacity.value = 1;
      return;
    }
    dashOffset.value = length;
    dashOffset.value = withTiming(0, { duration: DRAW_DURATION, easing: Easing.out(Easing.cubic) });
    areaOpacity.value = 0;
    areaOpacity.value = withTiming(1, { duration: DRAW_DURATION, easing: Easing.out(Easing.cubic) });
  }, [pointsKey, reduceMotion]); // eslint-disable-line react-hooks/exhaustive-deps

  const lineAnimatedProps = useAnimatedProps(() => ({ strokeDashoffset: dashOffset.value }));
  const areaAnimatedProps = useAnimatedProps(() => ({ opacity: areaOpacity.value }));

  return (
    <View>
      <Svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`}>
        <Defs>
          <LinearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={colors.accent} stopOpacity={0.12} />
            <Stop offset="100%" stopColor={colors.accent} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <AnimatedPolygon testID="weight-chart-area" points={area} fill="url(#wg)" animatedProps={areaAnimatedProps} />
        <AnimatedPolyline
          testID="weight-chart-line"
          points={line}
          fill="none"
          stroke={colors.primary}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={length}
          animatedProps={lineAnimatedProps}
        />
        {points.map((v, i) => (
          <Circle key={i} cx={x(i)} cy={y(v)} r={i === points.length - 1 ? 4.5 : 2.5} fill={colors.primary} stroke={colors.background} strokeWidth={1.5} />
        ))}
      </Svg>
    </View>
  );
}
