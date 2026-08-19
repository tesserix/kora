import { memo, useEffect } from "react";
import { View } from "react-native";
import Svg, { Circle, Line } from "react-native-svg";
import Animated, {
  useAnimatedProps,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { useTheme } from "@/theme";
import type { InstrumentTokens } from "@/theme";
import { AppText } from "@/components/Text";
import {
  buildGaugeTicks,
  needleFor,
  GAUGE_CENTER_X,
  GAUGE_CENTER_Y,
  GAUGE_TICKS,
  GAUGE_VIEW_H,
  GAUGE_VIEW_W,
  type GaugeTick,
} from "./gauge";

// GaugeDial is a PROGRESS instrument — value eaten against a budget, with an
// eaten/burned footer. This is a SETTING instrument: the needle sits at the
// target's position on a fixed scale, so changing activity sweeps the needle
// rather than nudging a fill. Same geometry, so the two read as one panel.
export const PLAN_DIAL_MIN = 1200;
export const PLAN_DIAL_MAX = 3600;

const AnimatedLine = Animated.createAnimatedComponent(Line);

// kora#238: the dial's FRACTION changes on every step a ruler drag crosses
// (#176 cut the JS wake-ups down to step boundaries but deliberately stopped at
// the ruler's edge). Its tick GEOMETRY does not change — x1/y1/x2/y2/width/major/
// red are functions of module constants only, so `buildGaugeTicks`' argument
// affects nothing but `.lit`, which is exactly what moves to the UI thread
// below. Built once at module load rather than per render.
const TICK_GEOMETRY: GaugeTick[] = buildGaugeTicks(0);

// "worklet" directive required: called from PlanGaugeTick's useAnimatedProps on
// the UI thread. A NAMED function referenced from inside a worklet is a captured
// closure value and crosses to the UI runtime as a remote function reference
// unless it carries its own directive — being in the same file as its call site
// does NOT save you (see gauge.ts's toXY comment and GaugeDial's tickColorFor
// for the on-device confirmation of that class: "[Worklets] Tried to
// synchronously call a Remote Function"). Do not remove.
//
// This reproduces PlanDial's ORIGINAL colour rule exactly — lit-and-red gets the
// accent, lit gets tickLit, unlit gets tick. It is deliberately NOT GaugeDial's
// `tickColorFor`, which alpha-fades unlit red ticks and minor lit ticks; the two
// dials look different on purpose and #238 is a pure performance change.
function planTickColor(lit: boolean, red: boolean, instrument: InstrumentTokens): string {
  "worklet";
  return lit ? (red ? instrument.accent : instrument.tickLit) : instrument.tick;
}

interface PlanGaugeTickProps {
  index: number;
  geom: GaugeTick;
  fractionSV: SharedValue<number>;
  instrument: InstrumentTokens;
  testID: string;
}

// memo + module-constant geometry is what makes the count in
// PlanDial.rebuild.test.tsx hold: every prop here is referentially stable across
// a target change (`geom` comes from TICK_GEOMETRY, `fractionSV` from a ref-backed
// shared value, `instrument` is a per-scheme module singleton), so a new `kcal`
// re-renders none of the 41 ticks. Only the stroke updates, on the UI thread.
const PlanGaugeTick = memo(function PlanGaugeTick({
  index,
  geom,
  fractionSV,
  instrument,
  testID,
}: PlanGaugeTickProps) {
  const t = index / GAUGE_TICKS;
  const animatedProps = useAnimatedProps(() => {
    "worklet";
    return { stroke: planTickColor(t <= fractionSV.value, geom.red, instrument) };
  });
  return (
    <AnimatedLine
      testID={testID}
      x1={geom.x1}
      y1={geom.y1}
      x2={geom.x2}
      y2={geom.y2}
      strokeWidth={geom.width}
      strokeLinecap="round"
      animatedProps={animatedProps}
    />
  );
});

interface PlanGaugeProps {
  hasTarget: boolean;
  fractionSV: SharedValue<number>;
  instrument: InstrumentTokens;
  testID: string;
}

// The whole SVG tree lives behind memo. `hasTarget` (needle vs. empty hub) is the
// only thing about it a target change can alter structurally — the needle's
// POSITION rides the shared value — so this body runs once per mount and once
// more if the dial ever crosses the has-a-number boundary.
const PlanGauge = memo(function PlanGauge({
  hasTarget,
  fractionSV,
  instrument,
  testID,
}: PlanGaugeProps) {
  const needleAnimatedProps = useAnimatedProps(() => {
    "worklet";
    return needleFor(fractionSV.value);
  });

  return (
    <Svg width="100%" height={GAUGE_VIEW_H} viewBox={`0 0 ${GAUGE_VIEW_W} ${GAUGE_VIEW_H}`}>
      {TICK_GEOMETRY.map((geom, i) => (
        <PlanGaugeTick
          key={i}
          index={i}
          geom={geom}
          fractionSV={fractionSV}
          instrument={instrument}
          testID={`${testID}-tick-${i}`}
        />
      ))}
      {hasTarget ? (
        <>
          <AnimatedLine
            testID={`${testID}-needle`}
            stroke={instrument.accent}
            strokeWidth={2.6}
            strokeLinecap="round"
            animatedProps={needleAnimatedProps}
          />
          <Circle cx={GAUGE_CENTER_X} cy={GAUGE_CENTER_Y} r={5} fill={instrument.accent} />
        </>
      ) : (
        <Circle
          cx={GAUGE_CENTER_X}
          cy={GAUGE_CENTER_Y}
          r={5}
          fill="none"
          stroke={instrument.tick}
          strokeWidth={1.4}
        />
      )}
    </Svg>
  );
});

interface PlanDialProps {
  kcal: number | null;
  testID?: string;
}

export function PlanDial({ kcal, testID = "plan-dial" }: PlanDialProps) {
  const { instrument } = useTheme();
  const hasTarget = kcal !== null && Number.isFinite(kcal);

  const fraction = hasTarget
    ? Math.min(1, Math.max(0, (kcal - PLAN_DIAL_MIN) / (PLAN_DIAL_MAX - PLAN_DIAL_MIN)))
    : 0;

  // Plain assignment, NOT withSpring: #238 is a performance change and the plan
  // is explicit that the dial must look unchanged. PlanDial has always jump-cut
  // to the new fraction (it is a SETTING instrument tracking a control the user
  // is physically dragging, not a reading that "arrives"), so springing it here
  // would be a motion change smuggled in under a perf fix. GaugeDial springs
  // because its value arrives from data; this one follows a finger.
  const fractionSV = useSharedValue(fraction);
  useEffect(() => {
    fractionSV.value = fraction;
  }, [fraction, fractionSV]);

  return (
    <View testID={testID}>
      {/* The gauge is decorative: the target is exposed once, as text, on the
          panel around this component. Announcing it here too would make a
          screen reader read the same number twice. */}
      <View
        testID={`${testID}-gauge`}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <PlanGauge
          hasTarget={hasTarget}
          fractionSV={fractionSV}
          instrument={instrument}
          testID={testID}
        />
      </View>
      {!hasTarget ? (
        <AppText
          testID={`${testID}-awaiting`}
          variant="caption"
          muted
          style={{ textAlign: "center", letterSpacing: 1.6, textTransform: "uppercase" }}
        >
          Awaiting your numbers
        </AppText>
      ) : null}
    </View>
  );
}
