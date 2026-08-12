import { useCallback, useMemo, useState } from "react";
import { View, type LayoutChangeEvent, type AccessibilityActionEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import Svg, { Line, Text as SvgText } from "react-native-svg";
import { useTheme } from "@/theme";
import { haptics, useMotionPrefs } from "@/motion";

const HEIGHT = 44;
const PX_PER_UNIT = 9;
const BASELINE = HEIGHT - 8;
// Ticks must render on first paint, before the real `onLayout` measurement
// arrives (RN testing-library never fires it), so width starts at a sane
// device-width estimate instead of 0 and is corrected once layout runs.
const FALLBACK_WIDTH = 320;

// Continuous mode: a numeric value dragged along a scale under a fixed
// centre index. Detented mode (labelled choices) is added by Task 6 as a
// sibling arm of the TickRulerProps union — kept here as its own type so
// that extension only adds a new arm and a branch, never a rewrite of this
// one.
export type ContinuousProps = {
  mode: "continuous";
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  formatLabel?: (value: number) => string;
  accessibilityLabel: string;
  testID?: string;
};

export type TickRulerProps = ContinuousProps;

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const quantize = (v: number, step: number): number => Math.round(v / step) * step;

// Floating-point noise makes 0.1+0.2-style drift visible on a 0.5-step ruler,
// so every reported value is rounded to the step's own decimal precision
// rather than a bare Math.round.
function snap(v: number, min: number, max: number, step: number): number {
  const decimals = (String(step).split(".")[1] ?? "").length;
  return Number(clamp(quantize(v, step), min, max).toFixed(decimals));
}

export function TickRuler(props: TickRulerProps) {
  const { instrument } = useTheme();
  const { reduceMotion } = useMotionPrefs();
  const { value, min, max, step, onChange, formatLabel, accessibilityLabel } = props;
  const testID = props.testID ?? "tick-ruler";
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);

  const report = useCallback(
    (next: number) => {
      const snapped = snap(next, min, max, step);
      if (snapped === value) return;
      // Reduce Motion users are also opting out of incidental vestibular/
      // haptic stimulation, so the per-tick buzz is skipped under that
      // preference — the value still reports on every step, only the
      // physical feedback is suppressed.
      if (!reduceMotion) haptics.selection();
      onChange(snapped);
    },
    [max, min, onChange, reduceMotion, step, value],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan().onChange((e) => {
        // Dragging left raises the value: the strip moves under a fixed
        // index, so the scale travels the opposite way to the finger.
        runOnJS(report)(value - e.changeX / PX_PER_UNIT);
      }),
    [report, value],
  );

  const onAccessibilityAction = useCallback(
    (e: AccessibilityActionEvent) => {
      const { actionName } = e.nativeEvent;
      if (actionName === "increment") report(value + step);
      if (actionName === "decrement") report(value - step);
    },
    [report, step, value],
  );

  const mid = width / 2;
  const ticks = useMemo(() => {
    if (!width) return [];
    const out: { key: string; x: number; major: boolean; label?: string }[] = [];
    const span = mid / PX_PER_UNIT;
    const first = Math.ceil(value - span);
    const last = Math.floor(value + span);
    for (let u = first; u <= last; u++) {
      if (u < min || u > max) continue;
      const major = u % 10 === 0;
      out.push({
        key: String(u),
        x: mid + (u - value) * PX_PER_UNIT,
        major,
        label: major ? String(u) : undefined,
      });
    }
    return out;
  }, [max, mid, min, value, width]);

  return (
    <GestureDetector gesture={pan}>
      <View
        testID={testID}
        onLayout={onLayout}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ text: formatLabel ? formatLabel(value) : String(value) }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={onAccessibilityAction}
        style={{ height: HEIGHT, width: "100%" }}
      >
        <Svg width="100%" height={HEIGHT}>
          {ticks.map((t) => (
            <Line
              key={t.key}
              testID={`${testID}-tick-${t.key}`}
              x1={t.x}
              y1={BASELINE}
              x2={t.x}
              y2={BASELINE - (t.major ? 16 : 7)}
              stroke={t.major ? instrument.ink : instrument.tick}
              strokeWidth={t.major ? 1.6 : 1}
            />
          ))}
          {ticks
            .filter((t) => t.label)
            .map((t) => (
              <SvgText
                key={`label-${t.key}`}
                x={t.x}
                y={BASELINE - 22}
                fill={instrument.mut}
                fontSize={9}
                textAnchor="middle"
              >
                {t.label}
              </SvgText>
            ))}
          {/* The fixed centre index — the only accent on the control. */}
          <Line
            testID={`${testID}-index`}
            x1={mid}
            y1={BASELINE + 4}
            x2={mid}
            y2={BASELINE - 24}
            stroke={instrument.accent}
            strokeWidth={2}
          />
        </Svg>
      </View>
    </GestureDetector>
  );
}
