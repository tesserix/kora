import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedProps,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { AppText } from "@/components/Text";
import { AnimatedNumber, REDUCED_MOTION_CROSSFADE_MS, haptics, springs, useMotionPrefs } from "@/motion";
import { useTheme } from "@/theme";
import type { InstrumentTokens } from "@/theme";
import { monoStyle } from "./typography";
import {
  buildGaugeTicks,
  captionFitsInFace,
  instrumentScale,
  needleFor,
  scaleAnchor,
  GAUGE_TICKS,
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
  const t = index / GAUGE_TICKS; // only used for the lit threshold below
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
  // The face scales with Dynamic Type (kora#268): a fixed viewBox draws at one
  // physical size from xSmall to AX5, so the numeral doubles while the dial it
  // sits in does not. useWindowDimensions, not PixelRatio.getFontScale(): the
  // former is reactive, the latter is a snapshot taken at mount.
  const { fontScale } = useWindowDimensions();
  // The ceiling on `s` is this component's AVAILABLE width, not the window's.
  // On a 393pt device the two differ by enough to flip the caption-fit result
  // (window says fits by 0.15pt; Home's real content box is ~325pt after its
  // paddingHorizontal, BezelCluster's rim and the hero card's own padding, and
  // it does not) — so it is measured, not assumed.
  //
  // NaN, not 0: instrumentScale treats a non-finite width as "not measured
  // yet" and returns the unclamped want, where a real-looking 0 would clamp to
  // the floor. That is the kora#270 failure mode — a dimension that resolves
  // to 0 on an early frame and reads as deliberate layout forever. At the
  // default text size this costs nothing anyway: `want` is already 1, so the
  // pre-layout frame and every frame after it are identical and there is no
  // second-frame jump in the common case.
  const [availableWidth, setAvailableWidth] = useState(Number.NaN);
  const onRootLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setAvailableWidth((prev) => (prev === w ? prev : w));
  }, []);
  const faceScale = instrumentScale(fontScale, availableWidth);
  // False ejects the caption out of the face to below the dial, where its room
  // is unbounded. The numeral never ejects — it is the instrument's readout,
  // and kora#268 rejected paying for the caption's position with it.
  const captionInFace = captionFitsInFace(faceScale, fontScale);
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
  // `showIgnition` never clears (it just gates whether the sequence should
  // START, per the prop doc above) so it can't also stand in for "is the
  // overshoot-and-settle sequence currently playing" — that conflated the
  // once-a-day countdown numeral and the sweep() guard with a flag that was
  // permanently true for the rest of the session once ignition fired once,
  // leaving the hero numeral stuck on the countdown branch and refresh sweep
  // disabled all session (kora ignition review, Finding 1). This state is the
  // actual "sequence in flight" signal: set when the overshoot run starts,
  // cleared in the settle spring's `finished` callback below.
  const [sequenceInFlight, setSequenceInFlight] = useState(false);
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
      setSequenceInFlight(true);
      // Pin to zero right before the sweep so there is somewhere to sweep
      // up FROM — done here (not at useSharedValue init) because at mount
      // time `showIgnition` is still false (see comment above).
      fractionSV.value = 0;
      fractionSV.value = withSequence(
        withTiming(1, { duration: 650, easing: Easing.in(Easing.quad) }),
        withSpring(fraction, springs.ignition, (finished) => {
          "worklet";
          // Settle thump (spec: ignition-settle haptic) — fires once the
          // overshoot spring has actually come to rest, not on every
          // intermediate frame, so it stays gated on `finished`. runOnJS
          // crosses back from the UI thread; haptics.impactLight is safe to
          // call from any thread boundary since it's already a fire-and-forget
          // promise wrapper.
          if (finished) runOnJS(haptics.impactLight)();
          // `sequenceInFlight` clears UNCONDITIONALLY, finished or not — a
          // re-render mid-sequence (e.g. `fraction`/`showIgnition` changing
          // from a refetch, plausible right at app-open) takes the `else`
          // branch below on the NEXT effect run, which calls
          // `withSpring(fraction, NEEDLE_SPRING)` and cancels this in-flight
          // spring — its callback then fires with `finished=false`. Gating
          // the clear on `finished` left the flag stuck `true` for the rest
          // of the session in exactly that case (kora ignition re-review,
          // Finding 1 follow-up): a cancelled sequence is no longer in
          // flight either way, so the JS-thread state that ungates the
          // odometer numeral branch and the sweep() guard must always cross
          // back over this same runOnJS bridge.
          runOnJS(setSequenceInFlight)(false);
        }),
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
  // choreography. Gated on `sequenceInFlight` (not `showIgnition`, which
  // never clears) so refresh sweeps work again once the sequence settles.
  useImperativeHandle(
    ref,
    () => ({
      sweep: () => {
        if (reduceMotion || sequenceInFlight) return;
        fractionSV.value = withSequence(
          withTiming(1, { duration: 500, easing: Easing.out(Easing.quad) }),
          withSpring(fraction, NEEDLE_SPRING),
        );
      },
    }),
    [fraction, reduceMotion, sequenceInFlight, fractionSV],
  );

  const needleAnimatedProps = useAnimatedProps(() => {
    "worklet";
    return { ...needleFor(fractionSV.value), opacity: needleOpacity.value };
  });

  // RN has no drop-shadow filter, so the needle's under-glow is a second,
  // wider stroke of the same geometry rendered beneath it (spec: "needle
  // under-glow"). It tracks the same fraction-driven position as the needle
  // AND the needle's own opacity — the glow used to hold a flat 0.28 while
  // the needle cross-faded under Reduce Motion, which left a full-opacity
  // halo floating over an invisible needle mid-crossfade. Baking the 0.28
  // base into the animated opacity (rather than the JSX `opacity` prop)
  // keeps the two strokes visually locked together at every frame.
  const needleGlowAnimatedProps = useAnimatedProps(() => {
    "worklet";
    return { ...needleFor(fractionSV.value), opacity: 0.28 * needleOpacity.value };
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

  // Bespoke engraved caption (T6 exception): the dial's center label is
  // literally part of the instrument face and keeps its own wider tracking (3
  // vs the shared recipe's 1.5) rather than routing through engravedStyle() —
  // see typography.ts.
  //
  // Hoisted so the in-face and ejected branches cannot drift: same text, same
  // size/tracking/weight, same danger-vs-accent rule, and the same "over has
  // no lume" rule (spec: "Over state has no lume"). Ejection is a position
  // change and nothing else.
  const caption = (id: string) => (
    <AppText
      testID={id}
      variant="body"
      maxFontSizeMultiplier={1.4}
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
  );

  const accessibilityLabel = `${reserve.magnitude.toLocaleString()} calories ${
    reserve.over ? "over budget" : "in reserve"
  } of ${Math.round(target).toLocaleString()}`;

  return (
    // `accessible` on the root collapses this whole subtree into ONE element
    // announcing `accessibilityLabel`, so no descendant is separately
    // focusable and the ejected caption cannot become a second stop that reads
    // the caption text again. The announcement is identical in both branches
    // because it is built from the reading, not from the layout.
    <View testID={testID} accessible accessibilityLabel={accessibilityLabel} onLayout={onRootLayout}>
      <View style={{ alignItems: "center" }}>
        {/* Rendered size scales; the viewBox does not. Pure vector scale — no
            tick, needle worklet or anchor below is touched. */}
        <Svg
          testID="gauge-face"
          width={GAUGE_VIEW_W * faceScale}
          height={GAUGE_VIEW_H * faceScale}
          viewBox={`0 0 ${GAUGE_VIEW_W} ${GAUGE_VIEW_H}`}
        >
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
            // `top` is a percentage and already tracks the scaled Svg;
            // OVERLAY_BOTTOM is in POINTS and does not, so it has to be scaled
            // by hand or the overlay's floor stays pinned at the design size
            // while the face grows under it. That single missing multiply is
            // kora#268 in miniature.
            top: "38%",
            bottom: OVERLAY_BOTTOM * faceScale,
            left: 0,
            right: 0,
            alignItems: "center",
          }}
        >
          {/* maxFontSizeMultiplier 1.6 (Finding 2): the overlay has fixed
              insets (see OVERLAY_BOTTOM above) — the cap IS the overflow
              protection, there is no room for this 44px numeral to grow
              unbounded at accessibility text sizes. */}
          <AppText variant="body" maxFontSizeMultiplier={1.6} style={centerNumeralStyle}>
            {sequenceInFlight ? (
              // Passed explicitly (rather than relying on RN's nested-Text
              // style inheritance) so the rendered node itself carries the
              // font metrics — inheritance is invisible to a style-flattening
              // test/inspection of this specific Text node. Gated on
              // `sequenceInFlight` (not `showIgnition`) so once the sequence
              // settles this branch releases back to the normal odometer
              // roll below — otherwise the hero numeral would stay pinned to
              // the countdown mechanism for the rest of the session on any
              // day the sequence has ever fired (Finding 1).
              <AnimatedNumber
                value={countdownValue}
                duration={1650}
                style={centerNumeralStyle}
                maxFontSizeMultiplier={1.6}
              />
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
              <AnimatedNumber
                value={reserve.magnitude}
                duration={550}
                style={centerNumeralStyle}
                maxFontSizeMultiplier={1.6}
              />
            )}
          </AppText>
          {captionInFace ? caption("gauge-caption") : null}
        </View>
      </View>
      {/* Ejected below the face, NOT inside the alignItems:"center" wrapper
          above. That wrapper is the overlay's positioning context, so a child
          added to it would grow its height and drag the numeral off centre via
          the `top: "38%"` inset — the overlay must keep measuring exactly the
          Svg. */}
      {captionInFace ? null : (
        <View style={{ alignItems: "center" }}>{caption("gauge-caption")}</View>
      )}
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
            <AppText
              variant="body"
              maxFontSizeMultiplier={1.6}
              style={[{ fontSize: 15, fontWeight: "600", color: instrument.ink }, mono]}
            >
              {Math.round(Number(v)).toLocaleString()}
            </AppText>
            {/* Bespoke engraved caption (T6 exception): the footer row's
                Eaten/Burned/Budget labels keep their own size/tracking
                (9px/2 vs the shared recipe's 10px/1.5) as part of the dial
                face — see typography.ts. */}
            <AppText
              variant="body"
              maxFontSizeMultiplier={1.4}
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
