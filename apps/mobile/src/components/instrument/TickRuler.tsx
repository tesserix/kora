import { useCallback, useMemo, useRef, useState } from "react";
import { Dimensions, View, type LayoutChangeEvent, type AccessibilityActionEvent } from "react-native";
import { Gesture, GestureDetector, type PanGesture } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import Svg, { Line, Text as SvgText } from "react-native-svg";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";
import { haptics } from "@/motion";

const HEIGHT = 44;
// Row above the ticks holding the numeric readout (kora#165). Fixed rather
// than intrinsic so the ruler's overall height never changes as the value
// grows a digit — a control that reflows while you drag it is unusable.
const READOUT_HEIGHT = 20;
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
  /**
   * Unit suffix for the on-screen readout ("cm", "kg", "lb", "years").
   * Display only — `value` is whatever the parent chose to put on the scale,
   * so a screen showing imperial passes lb/in here while still storing
   * metric. Omitted when `formatLabel` already carries the unit (ft/in).
   */
  unit?: string;
  accessibilityLabel: string;
  testID?: string;
};

/**
 * The one string both the readout and (minus the unit) the accessibility
 * value are built from, so the number a sighted user reads can never drift
 * from the one VoiceOver announces.
 */
export function formatReadout(
  value: number,
  formatLabel?: (value: number) => string,
  unit?: string,
): string {
  const base = formatLabel ? formatLabel(value) : String(value);
  return unit ? `${base} ${unit}` : base;
}

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

// Floor on the gap between two drag buzzes. At PX_PER_UNIT = 9 a moderate
// 900px/s drag steps ~100 times a second, and buzzing on every one of them is
// exactly the over-feedback that trains people to ignore all feedback (Apple
// §13, Utility). ~40ms still reads as continuous texture under the finger
// while cutting the actual count by an order of magnitude.
const HAPTIC_MIN_INTERVAL_MS = 40;

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

/**
 * The drag machinery both ruler modes share. Kept in one place because it
 * carries the subtle part: the gesture must never close over the current
 * value, and must compute an absolute position from a start captured once
 * per gesture plus the CUMULATIVE translation. Getting that wrong makes the
 * drag silently drop movement between renders, which is invisible to tests
 * that only drive the accessibility path.
 *
 * `compute` must already return a fully snapped/clamped value (as
 * `valueFromDrag`/`indexFromDrag` do) — this hook only decides WHETHER to
 * report (equality short-circuit, haptic rate-limiting) and HOW the gesture is
 * wired, never how a raw drag distance turns into a value.
 *
 * `atBound` says whether a value is at the end of the scale. Only the caller
 * knows what "the end" means (min/max for continuous, first/last stop for
 * detented), and the end is the one place on this control where a haptic
 * genuinely earns its keep — the value stops moving there, and without a
 * distinct feel it just goes silent, which reads as the control breaking.
 */
function useDragReport<T>({
  current,
  testID,
  compute,
  atBound,
  onReport,
}: {
  current: T;
  testID: string;
  compute: (start: T, translationX: number) => T;
  atBound: (value: T) => boolean;
  onReport: (next: T) => void;
}): { pan: PanGesture; report: (next: T) => void } {
  // `current` is a JS-thread closure that only refreshes after React
  // re-renders — dozens of SVG nodes deep, slower than touch-move events
  // land. currentRef always holds the latest so the gesture never reads a
  // stale one; dragStart is captured once per gesture so every update
  // computes an absolute position from cumulative translation instead of
  // per-frame deltas that can silently drop movement between renders.
  const currentRef = useRef(current);
  currentRef.current = current;
  const dragStart = useRef(current);

  // Rate-limit state. `lastHapticAt` is a wall-clock stamp rather than a
  // counter so the limit tracks real drag speed, and `wasAtBound` makes the
  // bound impact fire on ARRIVAL only, not on every frame the finger keeps
  // pushing past a limit the value has already stopped at. Seeded from the
  // starting value so a ruler that opens already pinned to min/max does not
  // thump on the first frame of the first drag.
  const lastHapticAt = useRef(0);
  const wasAtBound = useRef(atBound(current));

  const report = useCallback(
    (next: T) => {
      if (next === currentRef.current) return;
      const nowAtBound = atBound(next);
      if (nowAtBound) {
        // Deliberately NOT rate-limited: it can only fire on the transition.
        if (!wasAtBound.current) {
          haptics.impactLight();
          lastHapticAt.current = Date.now();
        }
      } else {
        // Reduce Motion deliberately does NOT suppress this. It is a
        // vestibular preference; a haptic has no vestibular component, and on
        // this control the buzz is the primary confirmation that the value
        // moved at all.
        const now = Date.now();
        if (now - lastHapticAt.current >= HAPTIC_MIN_INTERVAL_MS) {
          haptics.selection();
          lastHapticAt.current = now;
        }
      }
      wasAtBound.current = nowAtBound;
      onReport(next);
    },
    [atBound, onReport],
  );

  const beginDrag = useCallback(() => {
    dragStart.current = currentRef.current;
  }, []);

  const applyDrag = useCallback(
    (translationX: number) => {
      report(compute(dragStart.current, translationX));
    },
    [compute, report],
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

  return { pan, report };
}

function ContinuousRuler(props: ContinuousProps) {
  const { instrument } = useTheme();
  const { value, min, max, step, onChange, formatLabel, unit, accessibilityLabel } = props;
  const testID = props.testID ?? "tick-ruler";
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);

  const compute = useCallback(
    (start: number, translationX: number) => valueFromDrag(start, translationX, min, max, step),
    [max, min, step],
  );

  const atBound = useCallback((v: number) => v <= min || v >= max, [max, min]);

  const { pan, report } = useDragReport<number>({
    current: value,
    testID,
    compute,
    atBound,
    onReport: onChange,
  });

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
        style={{ height: HEIGHT + READOUT_HEIGHT, width: "100%" }}
      >
        {/* kora#165: the value in plain sight. A real RN Text rather than an
            SVG one so it inherits the app's type scale and Dynamic Type, and
            it sits INSIDE the `accessible` wrapper above — which collapses
            its children — so it cannot double up the accessibilityValue that
            assistive tech already reads correctly. */}
        <AppText
          testID={`${testID}-readout`}
          style={{
            // minHeight, NOT height, and no fixed lineHeight (kora#173). The
            // no-reflow requirement this row exists for is about the value
            // gaining a digit MID-DRAG, and a floor satisfies that completely:
            // the digits never change height, so the row never moves while you
            // drag it. Pinning height and lineHeight to 20 also pinned them
            // against a fontSize that Dynamic Type scales, so at accessibility
            // text sizes the readout was clipped through the middle of the
            // glyphs — the value in plain sight, unreadable, which is the exact
            // failure kora#165 set out to fix. Growth here happens only when the
            // user changes their text size, which is not during a drag.
            minHeight: READOUT_HEIGHT,
            textAlign: "center",
            fontSize: 15,
            fontWeight: "700",
            letterSpacing: 0.4,
            color: instrument.ink,
          }}
        >
          {formatReadout(value, formatLabel, unit)}
        </AppText>
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
  const { index, labels, onChange, accessibilityLabel } = props;
  const testID = props.testID ?? "tick-ruler";
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);

  const compute = useCallback(
    (start: number, translationX: number) => indexFromDrag(start, translationX, labels.length),
    [labels.length],
  );

  const atBound = useCallback((i: number) => i <= 0 || i >= labels.length - 1, [labels.length]);

  const { pan, report } = useDragReport<number>({
    current: index,
    testID,
    compute,
    atBound,
    onReport: onChange,
  });

  const onAccessibilityAction = useCallback(
    (e: AccessibilityActionEvent) => {
      // Detented mode reports stops, never positions: a fractional index
      // would reach the plan formula as an invalid activity level, so
      // increment/decrement clamp to a whole stop before reporting, exactly
      // as `indexFromDrag` clamps a dragged position.
      if (e.nativeEvent.actionName === "increment") report(clamp(index + 1, 0, labels.length - 1));
      if (e.nativeEvent.actionName === "decrement") report(clamp(index - 1, 0, labels.length - 1));
    },
    [index, labels.length, report],
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
