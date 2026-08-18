import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dimensions, View, type LayoutChangeEvent, type AccessibilityActionEvent } from "react-native";
import { Gesture, GestureDetector, type PanGesture } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Line, Path, Text as SvgText } from "react-native-svg";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";
import { haptics, springs } from "@/motion";

const HEIGHT = 44;
// Row above the ticks holding the numeric readout (kora#165). Fixed rather
// than intrinsic so the ruler's overall height never changes as the value
// grows a digit — a control that reflows while you drag it is unusable.
const READOUT_HEIGHT = 20;
const PX_PER_UNIT = 9;
const BASELINE = HEIGHT - 8;
// The scale is drawn ONCE at full width and then translated (kora#176), so
// this is only the fallback for the centre index's position before the real
// `onLayout` measurement arrives (RN testing-library never fires it).
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

// UIScrollView's deceleration rate. The projection below is the closed form
// of "where would this keep sliding to", which is what makes a flick travel
// further than the finger did (Apple §6) instead of dead-stopping on release.
const DECELERATION = 0.998;

// Apple's rubber-band constant. Higher gives more travel past the end.
const RUBBER_BAND_COEFFICIENT = 0.55;

// How far the finger must commit horizontally before the ruler claims the
// touch, and how far vertically before it gives up (kora#176). Onboarding
// stacks TEN rulers inside AuthScaffold's vertical ScrollView; without these
// the Pan activates on the first pixel of movement in ANY direction, then
// applies a translationX of ~0, so a vertical swipe started on a ruler
// scrolls nothing and the page reads as frozen.
const ACTIVE_OFFSET_X = 10;
const FAIL_OFFSET_Y = 15;

const clamp = (v: number, min: number, max: number): number => {
  "worklet";
  return Math.min(max, Math.max(min, v));
};

const quantize = (v: number, step: number): number => {
  "worklet";
  return Math.round(v / step) * step;
};

// Floating-point noise makes 0.1+0.2-style drift visible on a 0.5-step ruler,
// so every reported value is rounded to the step's own decimal precision
// rather than a bare Math.round.
function snap(v: number, min: number, max: number, step: number): number {
  "worklet";
  const decimals = (String(step).split(".")[1] ?? "").length;
  return Number(clamp(quantize(v, step), min, max).toFixed(decimals));
}

/**
 * Where a release would keep sliding to, given the speed it was released at.
 * `position` and `velocity` must be in the SAME units (this control works in
 * scale units per second, not pixels, so one formula serves both modes).
 *
 * Velocity zero projects nowhere, which is what makes a slow, deliberate
 * release land exactly where the finger left it.
 */
export function projectMomentum(position: number, velocity: number): number {
  "worklet";
  return position + (velocity / 1000) * (DECELERATION / (1 - DECELERATION));
}

/**
 * Apple's rubber-band curve: how far the scale actually moves when dragged
 * `overshoot` past its end. Asymptotic in `overshoot`, so resistance rises
 * the further you pull and the scale can never run away — dragging past the
 * end reads as "there is nothing more here" rather than as a frozen control,
 * which is what a hard clamp reads as (kora#176, Apple §9).
 *
 * `dimension` is the visible width the band is scaled against.
 */
export function rubberBand(overshoot: number, dimension: number): number {
  "worklet";
  const c = RUBBER_BAND_COEFFICIENT;
  return (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));
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
  "worklet";
  return snap(startValue - translationX / PX_PER_UNIT, min, max, step);
}

/**
 * The stop index a detented drag has reached. Mirrors `valueFromDrag`:
 * computed from the index at gesture start plus the CUMULATIVE translation,
 * never a per-frame delta, and always rounded + clamped to a whole stop —
 * detented mode never reports a fractional or out-of-range index.
 */
export function indexFromDrag(startIndex: number, translationX: number, stopCount: number): number {
  "worklet";
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
 * kora#176: the drag now runs on the UI thread. `offset` is the live scale
 * position in SCALE UNITS (values for continuous, stop indices for detented)
 * and is what the ticks are translated by, so the scale tracks the finger
 * without waiting for React. It may sit outside [lo, hi] while rubber-banding;
 * the REPORTED value never does.
 *
 * `compute` must be a worklet, and must already return a fully snapped and
 * clamped value (as `valueFromDrag`/`indexFromDrag` do) — this hook only
 * decides WHETHER to report (equality short-circuit, haptic rate-limiting)
 * and HOW the gesture is wired, never how a raw drag distance turns into a
 * value. `compute(position, 0)` is therefore also how an arbitrary position
 * gets snapped, which is what the release projection needs.
 *
 * `atBound` says whether a value is at the end of the scale. Only the caller
 * knows what "the end" means (min/max for continuous, first/last stop for
 * detented), and the end is the one place on this control where a haptic
 * genuinely earns its keep — the value stops moving there, and without a
 * distinct feel it just goes silent, which reads as the control breaking.
 */
function useDragReport({
  current,
  testID,
  compute,
  atBound,
  onReport,
  pxPerUnit,
  lo,
  hi,
  width,
}: {
  current: number;
  testID: string;
  compute: (start: number, translationX: number) => number;
  atBound: (value: number) => boolean;
  onReport: (next: number) => void;
  pxPerUnit: number;
  lo: number;
  hi: number;
  width: number;
}): { pan: PanGesture; report: (next: number) => void; offset: SharedValue<number> } {
  // `current` is a JS-thread closure that only refreshes after React
  // re-renders. currentRef always holds the latest so the haptic decisions
  // below never read a stale one.
  const currentRef = useRef(current);
  currentRef.current = current;

  // Rate-limit state. `lastHapticAt` is a wall-clock stamp rather than a
  // counter so the limit tracks real drag speed, and `wasAtBound` makes the
  // bound impact fire on ARRIVAL only, not on every frame the finger keeps
  // pushing past a limit the value has already stopped at. Seeded from the
  // starting value so a ruler that opens already pinned to min/max does not
  // thump on the first frame of the first drag.
  const lastHapticAt = useRef(0);
  const wasAtBound = useRef(atBound(current));
  // The last value this control itself put on the wire. The parent echoes
  // every reported value straight back as a new `current`, and the sync
  // effect below has to be able to tell that echo apart from a value changed
  // from OUTSIDE the drag — otherwise it would fight the finger.
  const lastReportedRef = useRef<number | null>(null);

  const report = useCallback(
    (next: number) => {
      if (next === currentRef.current) return;
      // Adopt the reported value immediately instead of waiting for the
      // parent to echo it back on the next render. A gesture can produce
      // several reports before React commits, and a stale currentRef would
      // let one value report twice — which the bound impact below would feel
      // as two separate arrivals at the same end of the scale.
      currentRef.current = next;
      lastReportedRef.current = next;
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

  // The live scale position driving the ticks, in scale units.
  const offset = useSharedValue(current);
  // The position the current gesture started from, captured once per gesture
  // so every update computes an absolute position from cumulative translation.
  const dragStart = useSharedValue(current);
  // The last value handed to `report`, tracked on the UI thread so the
  // crossing into a new step — not every frame — is what wakes the JS thread.
  const lastSnapped = useSharedValue(current);

  // Adopt a value that changed from OUTSIDE this control — the accessibility
  // increment/decrement actions, or a parent that rejected what we reported.
  // The echo of our own report is deliberately ignored: it arrives on every
  // frame of a drag, and adopting it would snap the scale to the last whole
  // step and cancel the rubber-band the finger is currently stretching.
  useEffect(() => {
    if (current !== lastReportedRef.current) offset.value = current;
  }, [current, offset]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // Tags the gesture so tests can address it via `getByGestureTestId`
        // (react-native-gesture-handler/jest-utils) and fire simulated events
        // at it directly — the only way to pin the wiring (translationX vs
        // changeX) rather than just the math.
        .withTestId(`${testID}-pan`)
        // Kept in this one chain rather than factored into a builder: the
        // repo's gesture-worklet-boundary guard reads each gesture chain for
        // its `runOnJS` hop, and splitting the chain across a helper hides
        // that declaration from it (see src/motion/__tests__).
        .activeOffsetX([-ACTIVE_OFFSET_X, ACTIVE_OFFSET_X])
        .failOffsetY([-FAIL_OFFSET_Y, FAIL_OFFSET_Y])
        .onBegin(() => {
          "worklet";
          dragStart.value = offset.value;
          lastSnapped.value = compute(offset.value, 0);
        })
        .onUpdate((e) => {
          "worklet";
          const raw = dragStart.value - e.translationX / pxPerUnit;
          const bounded = clamp(raw, lo, hi);
          // Past an end, the scale keeps moving but with rising resistance.
          // Purely visual: the snapped value below is clamped, so nothing out
          // of range is ever reported.
          const overshootPx = (raw - bounded) * pxPerUnit;
          offset.value = bounded + rubberBand(overshootPx, width) / pxPerUnit;

          // The JS thread is woken only when the drag crosses into a new
          // step — not on every frame, which is what used to re-render the
          // whole onboarding screen under the finger.
          const snapped = compute(dragStart.value, e.translationX);
          if (snapped !== lastSnapped.value) {
            lastSnapped.value = snapped;
            runOnJS(report)(snapped);
          }
        })
        .onEnd((e) => {
          "worklet";
          const position = dragStart.value - e.translationX / pxPerUnit;
          // Velocity arrives in px/s along the finger's axis; the scale moves
          // the opposite way, and this control thinks in scale units.
          const velocity = -(e.velocityX ?? 0) / pxPerUnit;
          const target = compute(projectMomentum(position, velocity), 0);
          // Released past an end, the only motion left is the return — that is
          // a settle, not a throw, so it uses the critically damped spring.
          const outOfBounds = position < lo || position > hi;
          offset.value = outOfBounds
            ? withSpring(target, springs.standard)
            : withSpring(target, { ...springs.lively, velocity });
          if (target !== lastSnapped.value) {
            lastSnapped.value = target;
            runOnJS(report)(target);
          }
        }),
    [compute, dragStart, hi, lastSnapped, lo, offset, pxPerUnit, report, testID, width],
  );

  return { pan, report, offset };
}

function ContinuousRuler(props: ContinuousProps) {
  const { instrument } = useTheme();
  const { value, min, max, step, onChange, formatLabel, unit, accessibilityLabel } = props;
  const testID = props.testID ?? "tick-ruler";
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);

  const compute = useCallback(
    (start: number, translationX: number) => {
      "worklet";
      return valueFromDrag(start, translationX, min, max, step);
    },
    [max, min, step],
  );

  const atBound = useCallback((v: number) => v <= min || v >= max, [max, min]);

  const { pan, report, offset } = useDragReport({
    current: value,
    testID,
    compute,
    atBound,
    onReport: onChange,
    pxPerUnit: PX_PER_UNIT,
    lo: min,
    hi: max,
    width,
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

  // kora#176: the WHOLE scale is built once and then translated on the UI
  // thread, rather than a window of ticks recomputed from the `value` prop on
  // every React render. The widest scale in the app (lb, 80–400) is 320 ticks
  // — cheap to draw once, and it makes the drag a pure transform.
  // A viewport of blank scale on each side. Without it the SVG's own left
  // edge sits exactly on the first tick, so `min`'s centred label is cut in
  // half the moment the ruler is dragged to the bottom of its range — the SVG
  // clips anything at a negative local x. Costs nothing but a wider (empty)
  // canvas.
  const pad = width;
  const scaleWidth = (max - min) * PX_PER_UNIT + pad * 2;
  // kora#245: the graduations are TWO <Path> nodes, not one <Line> per tick.
  // The widest scale (lb, 80-400) is 321 graduations, and onboarding mounts ten
  // rulers at once — 3,000+ SVG nodes on one screen made its initial render
  // roughly 10x heavier than it needed to be and flaked CI on a slow runner.
  // A path is one native view however many segments it holds, so this keeps
  // #176's render-once-and-translate design while paying for it once.
  //
  // Majors and minors stay separate because they differ in stroke weight and
  // colour; merging them would need per-segment styling a single path cannot
  // express. Labels remain their own nodes, but only majors carry one — about
  // a tenth of the graduations.
  const { minorPath, majorPath, labels } = useMemo(() => {
    let minor = "";
    let major = "";
    const out: { key: string; x: number; text: string }[] = [];
    for (let u = Math.ceil(min); u <= Math.floor(max); u++) {
      const x = pad + (u - min) * PX_PER_UNIT;
      if (u % 10 === 0) {
        major += `M${x} ${BASELINE}L${x} ${BASELINE - 16}`;
        out.push({ key: String(u), x, text: String(u) });
      } else {
        minor += `M${x} ${BASELINE}L${x} ${BASELINE - 7}`;
      }
    }
    return { minorPath: minor, majorPath: major, labels: out };
  }, [max, min, pad]);

  const scaleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: mid - pad - (offset.value - min) * PX_PER_UNIT }],
  }));

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
        style={{ height: HEIGHT + READOUT_HEIGHT, width: "100%", overflow: "hidden" }}
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
        <View style={{ height: HEIGHT }}>
          <Animated.View style={[{ width: scaleWidth, height: HEIGHT }, scaleStyle]}>
            <Svg width={scaleWidth} height={HEIGHT}>
              <Path
                testID={`${testID}-ticks-minor`}
                d={minorPath}
                stroke={instrument.tick}
                strokeWidth={1}
              />
              <Path
                testID={`${testID}-ticks-major`}
                d={majorPath}
                stroke={instrument.ink}
                strokeWidth={1.6}
              />
              {labels.map((t) => (
                <SvgText
                  key={`label-${t.key}`}
                  x={t.x}
                  y={BASELINE - 22}
                  fill={instrument.mut}
                  fontSize={9}
                  textAnchor="middle"
                >
                  {t.text}
                </SvgText>
              ))}
            </Svg>
          </Animated.View>
          {/* The fixed centre index — the only accent on the control, and the
              one thing that must NOT move with the scale. */}
          <Svg
            width="100%"
            height={HEIGHT}
            style={{ position: "absolute", left: 0, top: 0 }}
            pointerEvents="none"
          >
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
    (start: number, translationX: number) => {
      "worklet";
      return indexFromDrag(start, translationX, labels.length);
    },
    [labels.length],
  );

  const atBound = useCallback((i: number) => i <= 0 || i >= labels.length - 1, [labels.length]);

  const { pan, report, offset } = useDragReport({
    current: index,
    testID,
    compute,
    atBound,
    onReport: onChange,
    pxPerUnit: DETENT_PX,
    lo: 0,
    hi: labels.length - 1,
    width,
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
  // Same reason as continuous mode's `pad`: the first and last stops' labels
  // are centred on their tick, so without a margin the SVG clips half of each.
  // The first stop is SELECTED by default on every detented ruler in
  // onboarding, so this was visible immediately ("Lose weight" -> "veight").
  const pad = width;
  const scaleWidth = Math.max(1, (labels.length - 1) * DETENT_PX) + pad * 2;

  const scaleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: mid - pad - offset.value * DETENT_PX }],
  }));

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
        style={{ height: HEIGHT + 8, width: "100%", overflow: "hidden" }}
      >
        <Animated.View style={[{ width: scaleWidth, height: HEIGHT + 8 }, scaleStyle]}>
          <Svg width={scaleWidth} height={HEIGHT + 8}>
            {labels.map((label, i) => {
              const on = i === index;
              return (
                <Line
                  key={`stop-${label}`}
                  testID={`${testID}-stop-${i}`}
                  x1={pad + i * DETENT_PX}
                  y1={BASELINE + 8}
                  x2={pad + i * DETENT_PX}
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
                x={pad + i * DETENT_PX}
                y={BASELINE - 14}
                fill={i === index ? instrument.ink : instrument.mut}
                fontSize={10}
                fontWeight={i === index ? "600" : "500"}
                textAnchor="middle"
              >
                {label}
              </SvgText>
            ))}
          </Svg>
        </Animated.View>
        {/* The fixed centre index — the only accent on the control, and the
            one thing that must NOT move with the scale. */}
        <Svg
          width="100%"
          height={HEIGHT + 8}
          style={{ position: "absolute", left: 0, top: 0 }}
          pointerEvents="none"
        >
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
