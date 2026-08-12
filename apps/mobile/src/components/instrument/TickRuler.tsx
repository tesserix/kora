import { useCallback, useMemo, useRef, useState } from "react";
import { Dimensions, View, type LayoutChangeEvent, type AccessibilityActionEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import Svg, { Line, Text as SvgText } from "react-native-svg";
import { useTheme } from "@/theme";
import { haptics, useMotionPrefs } from "@/motion";

const HEIGHT = 44;
const PX_PER_UNIT = 9;
const BASELINE = HEIGHT - 8;
// Ticks must render on first paint, before the real `onLayout` measurement
// arrives (RN testing-library never fires it), so width starts from the
// window width instead of 0 — the onLayout correction is then a few points
// of container padding rather than a visible sideways jump of every tick.
const FALLBACK_WIDTH = Dimensions.get("window").width;

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

// Detented mode: a fixed set of labelled stops (goal, activity level, pace)
// under the same fixed centre index as continuous mode. Reports a stop
// INDEX, never a position — a fractional or out-of-range index would reach
// the plan formula as an invalid activity level, so `report` below always
// rounds and clamps before calling `onChange`.
export type DetentedProps = {
  mode: "detented";
  index: number;
  labels: readonly string[];
  onChange: (index: number) => void;
  accessibilityLabel: string;
  testID?: string;
};

export type TickRulerProps = ContinuousProps | DetentedProps;

// Pixels of drag per detent stop. Deliberately coarser than PX_PER_UNIT
// (continuous mode's px-per-value-unit) since a detented drag only needs to
// cross a handful of stops, not glide through a numeric range.
const DETENT_PX = 96;

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const quantize = (v: number, step: number): number => Math.round(v / step) * step;

// Floating-point noise makes 0.1+0.2-style drift visible on a 0.5-step ruler,
// so every reported value is rounded to the step's own decimal precision
// rather than a bare Math.round.
function snap(v: number, min: number, max: number, step: number): number {
  const decimals = (String(step).split(".")[1] ?? "").length;
  return Number(clamp(quantize(v, step), min, max).toFixed(decimals));
}

/**
 * The value a drag has reached. Computed from the value at gesture start
 * plus the CUMULATIVE translation, never from a per-frame delta against a
 * possibly-stale prop — several touch-move events can land between React
 * renders, and per-frame deltas silently drop that movement.
 */
export function valueFromDrag(
  startValue: number,
  translationX: number,
  min: number,
  max: number,
  step: number,
): number {
  return snap(startValue - translationX / PX_PER_UNIT, min, max, step);
}

/**
 * The stop index a detented drag has reached. Mirrors `valueFromDrag`:
 * computed from the index at gesture start plus the CUMULATIVE translation,
 * never a per-frame delta, and always rounded + clamped to a whole stop —
 * detented mode never reports a fractional or out-of-range index.
 */
export function indexFromDrag(startIndex: number, translationX: number, stopCount: number): number {
  return clamp(Math.round(startIndex - translationX / DETENT_PX), 0, stopCount - 1);
}

function ContinuousRuler(props: ContinuousProps) {
  const { instrument } = useTheme();
  const { reduceMotion } = useMotionPrefs();
  const { value, min, max, step, onChange, formatLabel, accessibilityLabel } = props;
  const testID = props.testID ?? "tick-ruler";
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);

  // `value` is a JS-thread closure that only refreshes after React
  // re-renders — dozens of SVG nodes deep, slower than touch-move events
  // land. valueRef always holds the latest so the gesture never reads a
  // stale one; dragStart is captured once per gesture so every update
  // computes an absolute position from cumulative translation instead of
  // per-frame deltas that can silently drop movement between renders.
  const valueRef = useRef(value);
  valueRef.current = value;
  const dragStart = useRef(value);

  const report = useCallback(
    (snapped: number) => {
      if (snapped === valueRef.current) return;
      // Reduce Motion users are also opting out of incidental vestibular/
      // haptic stimulation, so the per-tick buzz is skipped under that
      // preference — the value still reports on every step, only the
      // physical feedback is suppressed.
      if (!reduceMotion) haptics.selection();
      onChange(snapped);
    },
    [onChange, reduceMotion],
  );

  const beginDrag = useCallback(() => {
    dragStart.current = valueRef.current;
  }, []);

  const applyDrag = useCallback(
    (translationX: number) => {
      report(valueFromDrag(dragStart.current, translationX, min, max, step));
    },
    [max, min, report, step],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // Tags the gesture so tests can address it via
        // `getByGestureTestId` (react-native-gesture-handler/jest-utils)
        // and fire simulated events at it directly — the only way to pin
        // the wiring (translationX vs changeX) rather than just the math.
        .withTestId(`${testID}-pan`)
        .onBegin(() => {
          runOnJS(beginDrag)();
        })
        .onUpdate((e) => {
          runOnJS(applyDrag)(e.translationX);
        }),
    [applyDrag, beginDrag, testID],
  );

  const onAccessibilityAction = useCallback(
    (e: AccessibilityActionEvent) => {
      const { actionName } = e.nativeEvent;
      if (actionName === "increment") report(snap(value + step, min, max, step));
      if (actionName === "decrement") report(snap(value - step, min, max, step));
    },
    [max, min, report, step, value],
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

function DetentedRuler(props: DetentedProps) {
  const { instrument } = useTheme();
  const { reduceMotion } = useMotionPrefs();
  const { index, labels, onChange, accessibilityLabel } = props;
  const testID = props.testID ?? "tick-ruler";
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);

  // Same hazard as continuous mode: `index` is a JS-thread closure that only
  // refreshes after a React re-render, slower than touch-move events land.
  // indexRef always holds the latest so the gesture never reads a stale
  // one; dragStart is captured once per gesture so every update computes an
  // absolute stop from cumulative translation, never a per-frame delta.
  const indexRef = useRef(index);
  indexRef.current = index;
  const dragStart = useRef(index);

  const report = useCallback(
    (next: number) => {
      // Detented mode reports stops, never positions: a fractional index
      // would reach the plan formula as an invalid activity level.
      const stop = clamp(Math.round(next), 0, labels.length - 1);
      if (stop === indexRef.current) return;
      if (!reduceMotion) haptics.selection();
      onChange(stop);
    },
    [labels.length, onChange, reduceMotion],
  );

  const beginDrag = useCallback(() => {
    dragStart.current = indexRef.current;
  }, []);

  const applyDrag = useCallback(
    (translationX: number) => {
      report(indexFromDrag(dragStart.current, translationX, labels.length));
    },
    [labels.length, report],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .withTestId(`${testID}-pan`)
        .onBegin(() => {
          runOnJS(beginDrag)();
        })
        .onUpdate((e) => {
          runOnJS(applyDrag)(e.translationX);
        }),
    [applyDrag, beginDrag, testID],
  );

  const onAccessibilityAction = useCallback(
    (e: AccessibilityActionEvent) => {
      if (e.nativeEvent.actionName === "increment") report(index + 1);
      if (e.nativeEvent.actionName === "decrement") report(index - 1);
    },
    [index, report],
  );

  const mid = width / 2;

  return (
    <GestureDetector gesture={pan}>
      <View
        testID={testID}
        onLayout={onLayout}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ text: labels[index] }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={onAccessibilityAction}
        style={{ height: HEIGHT + 8, width: "100%" }}
      >
        <Svg width="100%" height={HEIGHT + 8}>
          {labels.map((label, i) => {
            const x = mid + (i - index) * DETENT_PX;
            const on = i === index;
            return (
              <Line
                key={`stop-${label}`}
                testID={`${testID}-stop-${i}`}
                x1={x}
                y1={BASELINE + 8}
                x2={x}
                y2={BASELINE - 6}
                // instrument.accent is reserved for the fixed centre index
                // below — selected-stop emphasis uses instrument.ink instead.
                stroke={on ? instrument.ink : instrument.tick}
                strokeWidth={on ? 2 : 1.4}
              />
            );
          })}
          {labels.map((label, i) => (
            <SvgText
              key={`stop-label-${label}`}
              testID={`${testID}-label-${i}`}
              x={mid + (i - index) * DETENT_PX}
              y={BASELINE - 14}
              fill={i === index ? instrument.ink : instrument.mut}
              fontSize={10}
              fontWeight={i === index ? "600" : "500"}
              textAnchor="middle"
            >
              {label}
            </SvgText>
          ))}
          {/* The fixed centre index — the only accent on the control. */}
          <Line
            testID={`${testID}-index`}
            x1={mid}
            y1={BASELINE + 12}
            x2={mid}
            y2={BASELINE - 10}
            stroke={instrument.accent}
            strokeWidth={2}
          />
        </Svg>
      </View>
    </GestureDetector>
  );
}

export function TickRuler(props: TickRulerProps) {
  return props.mode === "detented" ? <DetentedRuler {...props} /> : <ContinuousRuler {...props} />;
}
