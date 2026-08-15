import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { View } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { AppText } from "@/components/Text";
import { AnimatedNumber, REDUCED_MOTION_CROSSFADE_MS, springs, useMotionPrefs } from "@/motion";
import { useTheme } from "@/theme";
import type { InstrumentTokens } from "@/theme";
import { monoStyle } from "./typography";
import {
  buildGaugeTicks,
  needleFor,
  scaleAnchor,
  GAUGE_VIEW_H,
  GAUGE_VIEW_W,
  GAUGE_CENTER_X,
  GAUGE_CENTER_Y,
  type GaugeTick,
} from "./gauge";

// Critically damped (no overshoot) per spec: Motion > "damping ratio 1.0 ...
// response ~0.35" translated to reanimated's damping/stiffness pair.
const NEEDLE_SPRING = { damping: 30, stiffness: 250 };

const AnimatedLine = Animated.createAnimatedComponent(Line);

// "worklet" directive required: called from AnimatedGaugeTick's useAnimatedProps
// on the UI thread. Module scope alone (or same-file-ness) is NOT enough —
// reanimated's babel plugin only auto-workletizes the function literal passed
// directly to the hook; a *named function referenced inside* that worklet is a
// captured closure value, which crosses to the UI runtime as a remote function
// reference and crashes on-device with "[Worklets] Tried to synchronously call
// a Remote Function" — this hit exactly here (GaugeDial.tsx tickColorFor) and
// is the same underlying class as the AnimatedNumber crash (e557c50) and the
// gauge.ts needleFor/toXY fix. Every function called *from inside* a worklet
// needs its own "worklet" directive, full stop — do not remove this one.
// Only closes over plain serializable values (strings from InstrumentTokens,
// booleans), so it's safe to run on the UI thread as-is.
function tickColorFor(
  t: Pick<GaugeTick, "lit" | "red" | "major">,
  instrument: InstrumentTokens,
): string {
  "worklet";
  if (t.red) return t.lit ? instrument.accent : `${instrument.accent}73`; // 45% alpha suffix on hex
  if (!t.lit) return instrument.tick;
  return t.major ? instrument.tickLit : `${instrument.tickLit}8C`; // 55% alpha on minor lit ticks
}

// One tick's stroke color reacts live to the animated fraction as it springs
// from the previous value to the new one, so the lit/dimmed boundary visibly
// sweeps across the arc instead of jump-cutting (spec: Motion > "lit-tick
// fraction animate on data change"). Geometry (position/width) never depends
// on fraction — only color does — so only the animated prop needs a worklet.
interface AnimatedTickProps {
  index: number;
  geom: GaugeTick;
  fractionSV: SharedValue<number>;
  instrument: InstrumentTokens;
  testID: string;
}

function AnimatedGaugeTick({ index, geom, fractionSV, instrument, testID }: AnimatedTickProps) {
  const t = index / 40; // TICKS constant in gauge.ts — only used for the lit threshold below
  const animatedProps = useAnimatedProps(() => {
    "worklet";
    const lit = t <= fractionSV.value;
    // geom.red is already computed by buildGaugeTicks (t > 0.9) — reuse it
    // instead of re-deriving from index, so there's one source of truth.
    return { stroke: tickColorFor({ lit, red: geom.red, major: geom.major }, instrument) };
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
}

// The hub dot sits at GAUGE_CENTER_Y; keep this much vertical clearance above it
// so the center overlay's label never descends into the hub/needle-tail zone.
const HUB_CLEARANCE = 18;
// Distance, in SVG units, from the bottom of the viewBox up to the clearance
// line above the hub — used as the overlay's `bottom` inset so its content
// area ends above the hub instead of an eyeballed percentage.
const OVERLAY_BOTTOM = GAUGE_VIEW_H - (GAUGE_CENTER_Y - HUB_CLEARANCE);

// Pure helper (spec 2026-08-16-kora-ignition-design.md): shared by GaugeDial's
// center overlay and reused directly by other tasks in this milestone — keep
// the exact name/shape (over/magnitude/caption).
export function describeReserve(
  value: number,
  target: number,
): { over: boolean; magnitude: number; caption: string } {
  const diff = Math.round(target - value);
  return diff < 0
    ? { over: true, magnitude: -diff, caption: "kcal over budget" }
    : { over: false, magnitude: diff, caption: "kcal in reserve" };
}

export interface GaugeDialProps {
  value: number; // eaten kcal
  target: number; // budget kcal
  burned?: number;
  centerLabel?: string;
  testID?: string;
  // Once-a-day flourish (spec 2026-08-16-kora-ignition-design.md): needle
  // overshoots to full and springs back to the true fraction while the
  // center numeral counts down from the budget to the actual reserve.
  // Suppressed whenever the reading is over budget — see `showIgnition`.
  ignition?: boolean;
}

// Imperative escape hatch (spec: "pull-to-refresh sweep") — the needle runs
// full-and-back on demand (e.g. from Home's onRefresh) without the caller
// having to fake a value change to trigger motion.
export interface GaugeDialHandle {
  sweep: () => void;
}

export const GaugeDial = forwardRef<GaugeDialHandle, GaugeDialProps>(function GaugeDial(
  {
    value,
    target,
    burned,
    centerLabel = "kcal in reserve",
    testID = "gauge-dial",
    ignition = false,
  },
  ref,
) {
  const { instrument, fonts } = useTheme();
  const fraction = target > 0 ? Math.min(value / target, 1) : 0;
  const reserve = describeReserve(value, target);
  const mono = monoStyle(fonts);
  const { reduceMotion } = useMotionPrefs();
  // Ignition never plays over budget (spec) or under Reduce Motion — it is a
  // motion flourish with no reduced-motion substitute, only suppression.
  const showIgnition = ignition && !reserve.over && !reduceMotion;

  // Static geometry (position/width/major/red never depend on fraction — see
  // AnimatedGaugeTick); the argument here is arbitrary, only `.lit` (unused
  // below) would differ by it.
  const tickGeometry = buildGaugeTicks(0);

  // Springs from the current live position to the new fraction on every data
  // change. Reduced motion gets the spec's actual fallback (Motion >
  // prefers-reduced-motion, "needle sweeps become cross-fades"): the needle
  // fades out, the fraction — and with it the lit-tick boundary — swaps while
  // it is invisible, and it fades back in. It used to jump-cut, which is what
  // reanimated 4.5 degrades an animation to on its own and is precisely what
  // the guard was supposed to avoid.
  const fractionSV = useSharedValue(fraction);
  const needleOpacity = useSharedValue(1);
  // First paint has no previous position to cross-fade FROM.
  const firstRun = useRef(true);
  // Tracks the ignition overshoot separately from `firstRun` above: that ref
  // belongs to the reduced-motion cross-fade and flips to false on this
  // effect's very first run REGARDLESS of `showIgnition` — `useDailyIgnition`
  // always mounts `false` and flips `true` asynchronously after AsyncStorage
  // resolves, so by the time `ignition` actually becomes true, `firstRun`
  // would already be spent and the sequence would silently never play
  // (that was the bug). This ref instead latches on "has the ignition
  // sequence itself ever run" so it fires exactly once, whenever
  // `showIgnition` first turns true post-mount.
  const ignitionPlayed = useRef(false);
  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(fractionSV);
      if (firstRun.current) {
        fractionSV.value = fraction;
      } else {
        needleOpacity.value = withSequence(
          withTiming(0, { duration: REDUCED_MOTION_CROSSFADE_MS / 2 }, () => {
            "worklet";
            fractionSV.value = fraction;
          }),
          withTiming(1, { duration: REDUCED_MOTION_CROSSFADE_MS / 2 }),
        );
      }
      firstRun.current = false;
      return;
    }
    firstRun.current = false;
    const isIgnitionRun = showIgnition && !ignitionPlayed.current;
    if (isIgnitionRun) {
      ignitionPlayed.current = true;
      // Pin to zero right before the sweep so there is somewhere to sweep
      // up FROM — done here (not at useSharedValue init) because at mount
      // time `showIgnition` is still false (see comment above).
      fractionSV.value = 0;
      fractionSV.value = withSequence(
        withTiming(1, { duration: 650, easing: Easing.in(Easing.quad) }),
        withSpring(fraction, springs.ignition),
      );
    } else {
      fractionSV.value = withSpring(fraction, NEEDLE_SPRING);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fraction, reduceMotion, showIgnition]);

  // Pull-to-refresh sweep (spec Step 5): full-and-back, from wherever the
  // needle currently sits — NOT reset to 0 first like the ignition overshoot,
  // since a mid-scroll refresh shouldn't visually reset the reading before
  // sweeping. Skipped under Reduce Motion: a one-shot flourish has no calmer
  // substitute, only suppression (same rule as ignition). Also skipped while
  // the once-a-day ignition sequence is engaged — sweep()'s withSequence
  // would otherwise preempt the ignition needle mid-flight while the
  // countdown numeral above keeps counting on its own timeline, breaking the
  // choreography. `showIgnition` covers the whole overshoot-and-settle window
  // (it doesn't clear until the next render after `ignition` itself drops),
  // so gating on it is the simplest correct guard.
  useImperativeHandle(
    ref,
    () => ({
      sweep: () => {
        if (reduceMotion || showIgnition) return;
        fractionSV.value = withSequence(
          withTiming(1, { duration: 500, easing: Easing.out(Easing.quad) }),
          withSpring(fraction, NEEDLE_SPRING),
        );
      },
    }),
    [fraction, reduceMotion, showIgnition, fractionSV],
  );

  const needleAnimatedProps = useAnimatedProps(() => {
    "worklet";
    return { ...needleFor(fractionSV.value), opacity: needleOpacity.value };
  });

  // RN has no drop-shadow filter, so the needle's under-glow is a second,
  // wider stroke of the same geometry rendered beneath it (spec: "needle
  // under-glow"). It tracks the same fraction-driven position as the needle
  // but keeps its own static opacity rather than reduced-motion's cross-fade.
  const needleGlowAnimatedProps = useAnimatedProps(() => {
    "worklet";
    return needleFor(fractionSV.value);
  });

  // Count-down (spec: center numeral counts from budget down to reserve over
  // ~1650ms). AnimatedNumber only animates when its `value` prop CHANGES —
  // mounting it straight at `reserve.magnitude` would show the final figure
  // with nothing to count down from — so this starts pinned at `target` and
  // flips to the reserve one tick after mount to trigger that transition.
  const [countdownValue, setCountdownValue] = useState(target);
  useEffect(() => {
    if (!showIgnition) return;
    setCountdownValue(target);
    const id = setTimeout(() => setCountdownValue(reserve.magnitude), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showIgnition]);

  const centerNumeralStyle = [
    {
      fontSize: 44,
      lineHeight: 50,
      color: reserve.over ? instrument.danger : instrument.ink,
      letterSpacing: -1.2,
    },
    mono,
    // Lume glow reads as an instrument-face backlight, so the over-budget
    // numeral (already carrying the danger color) stays muted rather than
    // glowing (spec: "Over state has no lume").
    reserve.over
      ? null
      : {
          textShadowColor: instrument.lumeText,
          textShadowRadius: 22,
          textShadowOffset: { width: 0, height: 0 },
        },
  ];

  const footer: Array<[number, string]> = [
    [value, "Eaten"],
    ...(burned === undefined ? [] : ([[burned, "Burned"]] as Array<[number, string]>)),
    [target, "Budget"],
  ];

  const accessibilityLabel = `${reserve.magnitude.toLocaleString()} calories ${
    reserve.over ? "over budget" : "in reserve"
  } of ${Math.round(target).toLocaleString()}`;

  return (
    <View testID={testID} accessible accessibilityLabel={accessibilityLabel}>
      <View style={{ alignItems: "center" }}>
        <Svg width={GAUGE_VIEW_W} height={GAUGE_VIEW_H} viewBox={`0 0 ${GAUGE_VIEW_W} ${GAUGE_VIEW_H}`}>
          {tickGeometry.map((geom, i) => (
            <AnimatedGaugeTick
              key={i}
              index={i}
              geom={geom}
              fractionSV={fractionSV}
              instrument={instrument}
              testID={`gauge-tick-${i}`}
            />
          ))}
          {[0, 0.5, 1].map((t) => {
            const a = scaleAnchor(t);
            return (
              <SvgText key={t} x={a.x} y={a.y} textAnchor={a.anchor} fontSize={9} fill={instrument.mut}>
                {/* explicit rounding — scale numerals must never show API float noise */}
                {Math.round(target * t).toLocaleString()}
              </SvgText>
            );
          })}
          <AnimatedLine
            testID="gauge-needle-glow"
            stroke={instrument.accent}
            strokeWidth={7}
            strokeLinecap="round"
            opacity={0.28}
            animatedProps={needleGlowAnimatedProps}
          />
          <AnimatedLine
            testID="gauge-needle"
            stroke={instrument.accent}
            strokeWidth={3}
            strokeLinecap="round"
            animatedProps={needleAnimatedProps}
          />
          <Circle cx={GAUGE_CENTER_X} cy={GAUGE_CENTER_Y} r={4.5} fill={instrument.accent} />
        </Svg>
        <View
          testID="gauge-center-overlay"
          style={{
            position: "absolute",
            // top/bottom bound the overlay inside the Svg's own height so the
            // numeral's line box has room to breathe and can't clip — top clears
            // the scale-numeral band (~y 61), bottom (OVERLAY_BOTTOM, derived from
            // GAUGE_CENTER_Y and HUB_CLEARANCE) keeps the label above the hub dot
            // and the needle tail instead of an eyeballed percentage.
            top: "38%",
            bottom: OVERLAY_BOTTOM,
            left: 0,
            right: 0,
            alignItems: "center",
          }}
        >
          <AppText variant="body" style={centerNumeralStyle}>
            {showIgnition ? (
              // Passed explicitly (rather than relying on RN's nested-Text
              // style inheritance) so the rendered node itself carries the
              // font metrics — inheritance is invisible to a style-flattening
              // test/inspection of this specific Text node.
              <AnimatedNumber value={countdownValue} duration={1650} style={centerNumeralStyle} />
            ) : reserve.over ? (
              `+${reserve.magnitude.toLocaleString()}`
            ) : (
              // Odometer roll (spec Step 4): on a data change (a meal logged)
              // the numeral counts old -> new over ~550ms ease-out, reusing
              // AnimatedNumber — the same mechanism the ignition count-down
              // above already uses — rather than a second one-off tween.
              // AnimatedNumber itself is a no-op visually on first mount
              // (its shared value starts equal to `value`) and already
              // degrades to a cross-fade under Reduce Motion, so no extra
              // guard is needed here.
              <AnimatedNumber value={reserve.magnitude} duration={550} style={centerNumeralStyle} />
            )}
          </AppText>
          {/* Bespoke engraved caption (T6 exception): the dial's center label
              is literally part of the instrument face and keeps its own
              wider tracking (3 vs the shared recipe's 1.5) rather than
              routing through engravedStyle() — see typography.ts. */}
          <AppText
            variant="body"
            style={[
              {
                fontSize: 10,
                letterSpacing: 3,
                textTransform: "uppercase",
                color: reserve.over ? instrument.danger : instrument.accent,
                marginTop: 6,
                fontWeight: "600",
              },
              reserve.over
                ? null
                : {
                    textShadowColor: instrument.lumeAccent,
                    textShadowRadius: 14,
                    textShadowOffset: { width: 0, height: 0 },
                  },
            ]}
          >
            {reserve.over ? reserve.caption : centerLabel}
          </AppText>
        </View>
      </View>
      <View
        style={{
          flexDirection: "row",
          borderTopWidth: 1,
          borderTopColor: instrument.hairline,
          paddingTop: 12,
          marginTop: 4,
        }}
      >
        {footer.map(([v, k]) => (
          <View key={k} style={{ flex: 1, alignItems: "center" }}>
            <AppText variant="body" style={[{ fontSize: 15, fontWeight: "600", color: instrument.ink }, mono]}>
              {Math.round(Number(v)).toLocaleString()}
            </AppText>
            {/* Bespoke engraved caption (T6 exception): the footer row's
                Eaten/Burned/Budget labels keep their own size/tracking
                (9px/2 vs the shared recipe's 10px/1.5) as part of the dial
                face — see typography.ts. */}
            <AppText
              variant="body"
              style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: instrument.mut, marginTop: 3 }}
            >
              {k}
            </AppText>
          </View>
        ))}
      </View>
    </View>
  );
});
