import { useEffect } from "react";
import { View } from "react-native";
import Svg, { Defs, LinearGradient, Line, Stop, Polygon, Polyline, Circle, G } from "react-native-svg";
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useMotionPrefs } from "@/motion";
import { useTheme } from "@/theme";

type Props = {
  points: number[];
  /**
   * Indices AFTER which the series must not be joined, because the next point
   * came from a different instrument (kora#45). Produced by
   * `metricSeries().breaksAfter` in src/lib/bodyCompositionSeries.ts.
   *
   * Omitted — the weight case, and every single-instrument history — the chart
   * renders exactly as it always has: one polyline, one area, one endpoint dot.
   */
  breaksAfter?: readonly number[];
};

const AnimatedPolyline = Animated.createAnimatedComponent(Polyline);
const AnimatedPolygon = Animated.createAnimatedComponent(Polygon);
// Kora ignition Task 8: Weight is now the screen's BezelCluster hero, so its
// chart draw-in gets the slower ~1100ms sweep (was 700ms) to read as the
// panel's signature motion, mirroring the needle-draw weight the GaugeDial
// gives its own hero reveal.
const DRAW_DURATION = 1100;
// Endpoint dot geometry (spec: "endpoint dot accent r 3.5 with halo circle
// opacity 0.22 r 8") — the chart's one accent element besides the stroke.
const ENDPOINT_DOT_RADIUS = 3.5;
const ENDPOINT_HALO_RADIUS = 8;
const ENDPOINT_HALO_OPACITY = 0.22;

// Trend chart: an SVG polyline + gradient-filled area. Callers are responsible
// for the >=2-point guard (see app/(tabs)/progress.tsx) — this component
// assumes points.length >= 2 and does no internal guarding, exactly as before.
//
// Since #45 it draws any of the body-composition metrics, not only weight, and
// the `breaksAfter` prop is what keeps that honest: a run of points measured by
// one instrument is one polyline, and the next instrument's run is another,
// with a dashed rule marking where the two meet. Joining them would turn a
// change of scale into what reads as a change of body — Renpho's 48.9%
// skeletal muscle against Omron's 25.7% for the same person. The chart draws
// the discontinuity; it does not decide it (that is `isComparable`).
export function WeightChart({ points, breaksAfter = [] }: Props) {
  const { instrument } = useTheme();
  const { reduceMotion } = useMotionPrefs();
  const w = 300;
  const h = 130;
  const pad = 10;
  const min = Math.min(...points) - 0.4;
  const max = Math.max(...points) + 0.4;
  const x = (i: number) => pad + (i * (w - pad * 2)) / (points.length - 1);
  const y = (v: number) => pad + (1 - (v - min) / (max - min)) * (h - pad * 2);

  // The x axis stays GLOBAL across segments — every point keeps the slot its
  // position in the series gives it — so a break is a visible gap in the line
  // rather than a re-flow that would move earlier points sideways.
  const segments = splitSegments(points.length, breaksAfter).map((indices) => {
    const line = indices.map((i) => `${x(i)},${y(points[i])}`).join(" ");
    let length = 0;
    for (let k = 1; k < indices.length; k++) {
      const a = indices[k - 1];
      const b = indices[k];
      length += Math.hypot(x(b) - x(a), y(points[b]) - y(points[a]));
    }
    return {
      indices,
      line,
      length,
      area: `${x(indices[0])},${h - pad} ${line} ${x(indices[indices.length - 1])},${h - pad}`,
    };
  });

  // Key the redraw effect off the actual values (not just array identity —
  // `points` is a fresh array every render) so a range switch that yields a
  // different series retriggers the draw-in, while unrelated re-renders don't.
  // The break list joins the key for the same reason: switching to a metric
  // with the same values but a different instrument history is a different
  // picture.
  const pointsKey = `${points.join(",")}|${breaksAfter.join(",")}`;

  // One progress value for the whole chart rather than one per segment: the
  // segment count varies with the data, and a hook per segment would be a hook
  // count that changes between renders. It runs 1 -> 0, so each segment can
  // derive its own dash offset from its own length. Reduced motion renders
  // already-settled (fully drawn, opaque) on the very first paint — no tween
  // ever runs.
  const progress = useSharedValue(reduceMotion ? 0 : 1);

  useEffect(() => {
    if (reduceMotion) {
      progress.value = 0;
      return;
    }
    progress.value = 1;
    progress.value = withTiming(0, { duration: DRAW_DURATION, easing: Easing.out(Easing.cubic) });
  }, [pointsKey, reduceMotion]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastIndex = points.length - 1;

  return (
    <View>
      <Svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`}>
        <Defs>
          {/* Instrument glass: accent stroke, subtle 10% area fill fading to nothing —
              spec's "accent sparkline + subtle area fill + end dot" for the Weight panel. */}
          <LinearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={instrument.accent} stopOpacity={0.1} />
            <Stop offset="100%" stopColor={instrument.accent} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        {segments.map((segment, s) => (
          <ChartSegment
            key={s}
            area={segment.area}
            line={segment.line}
            length={segment.length}
            progress={progress}
            accent={instrument.accent}
            // The first segment keeps the original testIDs so the weight case —
            // and everything asserting on it — is untouched.
            testIDLine={s === 0 ? "weight-chart-line" : `weight-chart-line-${s}`}
            testIDArea={s === 0 ? "weight-chart-area" : `weight-chart-area-${s}`}
          />
        ))}
        {breaksAfter.map((i) => (
          // The discontinuity, drawn where the reader would otherwise read a
          // slope: a dashed rule between the last reading of one instrument and
          // the first of the next. Legend copy lives with the caller — this is
          // only the mark.
          <Line
            key={`break-${i}`}
            testID={`weight-chart-break-after-${i}`}
            x1={(x(i) + x(i + 1)) / 2}
            y1={pad}
            x2={(x(i) + x(i + 1)) / 2}
            y2={h - pad}
            stroke={instrument.tick}
            strokeWidth={1}
            strokeDasharray={[3, 3]}
          />
        ))}
        {points.map((v, i) => {
          const isEndpoint = i === lastIndex;
          return isEndpoint ? (
            <G key={i}>
              <Circle
                testID="weight-chart-endpoint-halo"
                cx={x(i)}
                cy={y(v)}
                r={ENDPOINT_HALO_RADIUS}
                fill={instrument.accent}
                opacity={ENDPOINT_HALO_OPACITY}
              />
              <Circle
                testID="weight-chart-endpoint"
                cx={x(i)}
                cy={y(v)}
                r={ENDPOINT_DOT_RADIUS}
                fill={instrument.accent}
                stroke={instrument.glass}
                strokeWidth={1.5}
              />
            </G>
          ) : (
            <Circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill={instrument.accent} stroke={instrument.glass} strokeWidth={1.5} />
          );
        })}
      </Svg>
    </View>
  );
}

/**
 * The runs of indices that may be drawn as one continuous line.
 *
 * A break AFTER index i ends a run at i and starts the next at i+1, so a
 * two-instrument history yields two runs and the point count is preserved —
 * nothing is dropped or duplicated at the seam.
 */
function splitSegments(count: number, breaksAfter: readonly number[]): number[][] {
  const all = Array.from({ length: count }, (_, i) => i);
  return all.reduce<number[][]>((runs, i) => {
    const current = runs.length ? runs[runs.length - 1] : [];
    const next = runs.length ? [...runs.slice(0, -1), [...current, i]] : [[i]];
    return breaksAfter.includes(i) ? [...next, []] : next;
  }, []).filter((run) => run.length > 0);
}

type SegmentProps = {
  line: string;
  area: string;
  length: number;
  progress: SharedValue<number>;
  accent: string;
  testIDLine: string;
  testIDArea: string;
};

// One comparable run. Split into its own component so each run can hold its own
// animated props off the shared progress value without the parent taking a hook
// per segment.
function ChartSegment({ line, area, length, progress, accent, testIDLine, testIDArea }: SegmentProps) {
  const lineAnimatedProps = useAnimatedProps(() => ({ strokeDashoffset: length * progress.value }));
  const areaAnimatedProps = useAnimatedProps(() => ({ opacity: 1 - progress.value }));
  // A run of ONE point (a brand-new instrument's first reading) has no line to
  // draw. Its dot still renders, from the caller's own point loop — but a zero
  // strokeDasharray would make the dash cycle degenerate, so the stroke is
  // skipped entirely rather than given a meaningless length.
  if (length === 0) return null;
  return (
    <>
      <AnimatedPolygon testID={testIDArea} points={area} fill="url(#wg)" animatedProps={areaAnimatedProps} />
      <AnimatedPolyline
        testID={testIDLine}
        points={line}
        fill="none"
        stroke={accent}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={length}
        animatedProps={lineAnimatedProps}
      />
    </>
  );
}
