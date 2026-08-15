import type { ComponentProps } from "react";
import { createRef } from "react";
import { render, within } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import * as Reanimated from "react-native-reanimated";
import { springs } from "@/motion";
import { buildGaugeTicks, needleFor, GAUGE_VIEW_H, GAUGE_CENTER_Y } from "../gauge";
import { describeReserve, GaugeDial, type GaugeDialHandle } from "../GaugeDial";

const renderGauge = async (props: ComponentProps<typeof GaugeDial>) => render(<GaugeDial {...props} />);

afterEach(() => {
  jest.clearAllMocks();
  // clearAllMocks resets call history but not a mockReturnValue override — restore
  // the default (reduced motion off) so it doesn't bleed into the next test.
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(false);
});

const flattenStyle = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : (style as Record<string, unknown>);

test("builds 41 ticks with the redline in the last tenth", () => {
  const ticks = buildGaugeTicks(0.65);
  expect(ticks).toHaveLength(41);
  expect(ticks.filter((t) => t.red)).toHaveLength(4); // indices 37..40
  expect(ticks[26].lit).toBe(true); // 26/40 = 0.65 — last lit
  expect(ticks[27].lit).toBe(false);
});

test("the needle tracks the fraction monotonically to the right", () => {
  expect(needleFor(0.9).x2).toBeGreaterThan(needleFor(0.2).x2);
});

test("shows the remaining energy as the center numeral", async () => {
  const { getByText } = await render(<GaugeDial value={1430} target={2200} burned={304} />);
  expect(getByText("770")).toBeTruthy();
  expect(getByText("kcal in reserve")).toBeTruthy();
  expect(getByText("1,430")).toBeTruthy(); // eaten, footer
  expect(getByText("2,200")).toBeTruthy(); // budget, footer + scale numeral dedupe is fine
});

// Finding 2 (Dynamic Type cap pass): the center overlay has fixed insets —
// the cap IS the overflow protection at accessibility text sizes, so the
// hero numeral and its caption must carry an explicit maxFontSizeMultiplier.
test("caps the center numeral and caption at the spec'd Dynamic Type multipliers", async () => {
  const { getByText } = await render(<GaugeDial value={1430} target={2200} burned={304} />);
  expect(getByText("770").props.maxFontSizeMultiplier).toBe(1.6);
  expect(getByText("kcal in reserve").props.maxFontSizeMultiplier).toBe(1.4);
});

// Was "never renders a negative reserve" / expected "0" — value > target now
// renders the explicit over-budget state (spec 2026-08-16-kora-ignition-design.md)
// instead of clamping to zero, so this asserts the new +N over-budget reading.
test("renders the over-budget reading instead of clamping to zero", async () => {
  const { getByText } = await render(<GaugeDial value={2500} target={2200} />);
  expect(getByText("+300")).toBeTruthy();
});

test("rounds raw API floats in the footer instead of showing decimals", async () => {
  const { getByText, queryByText } = await render(
    <GaugeDial value={105.02} target={1794.531} burned={42.9} />,
  );
  expect(getByText("105")).toBeTruthy(); // eaten, footer — rounded, not "105.02"
  expect(getByText("43")).toBeTruthy(); // burned, footer — rounded, not "42.9"
  expect(queryByText("105.02")).toBeNull();
  expect(queryByText("1,794.531")).toBeNull();
});

test("the center reserve numeral carries an explicit lineHeight so it can't clip", async () => {
  const { getByText } = await render(<GaugeDial value={1430} target={2200} burned={304} />);
  const flat = flattenStyle(getByText("770").props.style);
  expect(flat.fontSize).toBe(44);
  expect(flat.lineHeight).toBe(50);
  expect(flat.lineHeight as number).toBeGreaterThanOrEqual((flat.fontSize as number) * 1.1);
});

// Reduced Motion (spec: Motion > prefers-reduced-motion) means the needle and
// lit-tick boundary jump straight to the new fraction — no spring sweep.
test("under reduced motion, the needle renders statically at the target fraction with no spring", async () => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(true);
  const spy = jest.spyOn(Reanimated, "withSpring");

  const { getByTestId } = await render(<GaugeDial value={1100} target={2200} />);

  expect(spy).not.toHaveBeenCalled();
  const needle = getByTestId("gauge-needle").props;
  const expected = needleFor(0.5);
  expect(needle.x2).toBeCloseTo(expected.x2);
  expect(needle.y2).toBeCloseTo(expected.y2);

  spy.mockRestore();
});

// kora#175 §4. The comment above cited the spec's "needle sweeps become
// cross-fades" and then implemented a jump cut. A cross-fade has no vestibular
// component, so it is the fallback the preference actually asks for.
test("under reduced motion, a data change cross-fades the needle instead of jump-cutting", async () => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(true);
  const timing = jest.spyOn(Reanimated, "withTiming");
  const spring = jest.spyOn(Reanimated, "withSpring");

  const { rerender } = await render(<GaugeDial value={1100} target={2200} />);
  // Nothing to cross-fade FROM on first paint.
  expect(timing).not.toHaveBeenCalled();

  await rerender(<GaugeDial value={1650} target={2200} />);

  expect(timing).toHaveBeenCalled();
  expect(spring).not.toHaveBeenCalled();

  timing.mockRestore();
  spring.mockRestore();
});

test("outside reduced motion, the needle springs via withSpring toward the target fraction", async () => {
  const spy = jest.spyOn(Reanimated, "withSpring");

  await render(<GaugeDial value={1100} target={2200} />);

  expect(spy).toHaveBeenCalledWith(0.5, { damping: 30, stiffness: 250 });

  spy.mockRestore();
});

// kora ignition review: useDailyIgnition always mounts `false` and only
// flips `true` asynchronously (after AsyncStorage resolves), so the real
// call site never has `ignition={true}` on the very first render — it is
// always a false -> true transition post-mount. This is exactly the path
// that let the "sequence never plays" bug ship, so it's the path this test
// exercises directly, rather than mounting straight at `ignition={true}`.
test("the ignition sequence engages when `ignition` flips false -> true post-mount, using springs.ignition for the settle", async () => {
  const springSpy = jest.spyOn(Reanimated, "withSpring");
  const timingSpy = jest.spyOn(Reanimated, "withTiming");

  const { rerender } = await render(<GaugeDial value={1100} target={2200} ignition={false} />);
  springSpy.mockClear();
  timingSpy.mockClear();

  await rerender(<GaugeDial value={1100} target={2200} ignition={true} />);

  // The overshoot ramp to full scale, and the settle spring using the
  // dedicated (deliberately underdamped) ignition spring — NOT the
  // critically-damped NEEDLE_SPRING used by ordinary data-change springs.
  expect(timingSpy).toHaveBeenCalledWith(1, expect.objectContaining({ duration: 650 }));
  // Third arg is the ignition-settle haptic callback (Task 9) — asserted
  // separately below, so only its presence (any function) matters here.
  expect(springSpy).toHaveBeenCalledWith(0.5, springs.ignition, expect.any(Function));

  springSpy.mockRestore();
  timingSpy.mockRestore();
});

// Task 9 haptics sweep: the settle spring's callback (asserted above via
// `expect.any(Function)`) fires `haptics.impactLight()` once the overshoot
// spring actually comes to rest — the jest.setup.js reanimated mock invokes
// withSpring's callback synchronously with `finished = true`.
test("the ignition settle plays an impactLight haptic once the overshoot spring comes to rest", async () => {
  const { rerender } = await render(<GaugeDial value={1100} target={2200} ignition={false} />);
  (Haptics.impactAsync as jest.Mock).mockClear();

  await rerender(<GaugeDial value={1100} target={2200} ignition={true} />);

  expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
});

test("the center overlay is bounded above the hub dot, derived from the gauge geometry", async () => {
  const { getByTestId } = await render(<GaugeDial value={1430} target={2200} burned={304} />);
  const flat = flattenStyle(getByTestId("gauge-center-overlay").props.style);
  // The overlay's content area must end (bottom inset from the SVG's bottom
  // edge) above the hub dot's top edge, not just above its center — leaves
  // room for the "kcal in reserve" label and the needle tail that pivots there.
  const hubTopEdge = GAUGE_CENTER_Y - 4.5; // hub circle radius, GaugeDial.tsx
  const overlayContentBottomY = GAUGE_VIEW_H - (flat.bottom as number);
  expect(overlayContentBottomY).toBeLessThan(hubTopEdge);
});

// Step 4 (spec 2026-08-16-kora-ignition-design.md): a data change (a meal
// logged) rolls the center numeral old -> new over ~550ms via AnimatedNumber
// — the same countdown mechanism the ignition sequence already uses.
test("a data change rolls the center numeral via AnimatedNumber over ~550ms", async () => {
  const timing = jest.spyOn(Reanimated, "withTiming");

  const { rerender, getByTestId } = await render(<GaugeDial value={1100} target={2200} />);
  const overlay = () => within(getByTestId("gauge-center-overlay"));
  expect(overlay().getByText("1,100")).toBeTruthy();
  timing.mockClear();

  await rerender(<GaugeDial value={1650} target={2200} />);

  // The mock's useAnimatedReaction is a NOOP (see jest.setup.js), so the
  // rendered digit itself is not observable mid-flight here — asserting the
  // withTiming call is the mechanism-level equivalent of the needle-spring
  // assertions elsewhere in this file (they check the call, not pixels).
  expect(timing).toHaveBeenCalledWith(550, expect.objectContaining({ duration: 550 }));

  timing.mockRestore();
});

// Step 5: an imperative sweep() sends the needle full-and-back without a
// value change, for Home's pull-to-refresh.
test("ref.sweep() sends the needle to full and back via NEEDLE_SPRING", async () => {
  const timing = jest.spyOn(Reanimated, "withTiming");
  const spring = jest.spyOn(Reanimated, "withSpring");
  const ref = createRef<GaugeDialHandle>();

  await render(<GaugeDial ref={ref} value={1100} target={2200} />);
  timing.mockClear();
  spring.mockClear();

  ref.current?.sweep();

  expect(timing).toHaveBeenCalledWith(1, expect.objectContaining({ duration: 500 }));
  expect(spring).toHaveBeenCalledWith(0.5, { damping: 30, stiffness: 250 });

  timing.mockRestore();
  spring.mockRestore();
});

// sweep() is a one-shot flourish with no calmer substitute (same rule as
// ignition) — Reduce Motion suppresses it entirely rather than degrading it.
test("ref.sweep() is a no-op under reduced motion", async () => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(true);
  const spring = jest.spyOn(Reanimated, "withSpring");
  const ref = createRef<GaugeDialHandle>();

  await render(<GaugeDial ref={ref} value={1100} target={2200} />);
  spring.mockClear();

  ref.current?.sweep();

  expect(spring).not.toHaveBeenCalled();

  spring.mockRestore();
});

// kora ignition review Finding 1: `showIgnition` used to gate sweep() too,
// and it never clears, so refresh sweeps were disabled all session after the
// once-a-day sequence fired even once. The jest reanimated mock invokes
// withSpring's `finished` callback synchronously (see jest.setup.js), so the
// settle — and with it the runOnJS-bridged `sequenceInFlight` clear — has
// already happened by the time this rerender call returns. sweep() must be
// callable (i.e. retarget the needle) immediately after.
test("ref.sweep() retargets the needle once the ignition sequence has settled", async () => {
  const spring = jest.spyOn(Reanimated, "withSpring");
  const timing = jest.spyOn(Reanimated, "withTiming");
  const ref = createRef<GaugeDialHandle>();

  const { rerender } = await render(<GaugeDial ref={ref} value={1100} target={2200} ignition={false} />);
  await rerender(<GaugeDial ref={ref} value={1100} target={2200} ignition={true} />);
  spring.mockClear();
  timing.mockClear();

  ref.current?.sweep();

  expect(timing).toHaveBeenCalledWith(1, expect.objectContaining({ duration: 500 }));
  expect(spring).toHaveBeenCalledWith(0.5, { damping: 30, stiffness: 250 });

  spring.mockRestore();
  timing.mockRestore();
});

// Finding 1 regression: after the sequence settles, the hero numeral must
// release back to the normal odometer branch so a later meal log rolls it —
// it used to stay pinned to the (now-stale) countdown mechanism forever,
// because the old gate (`showIgnition`) never cleared. (The reanimated mock
// NOOPs useAnimatedReaction — see AnimatedNumber.tsx — so, same as the
// existing "data change rolls the center numeral" test above, the mechanism
// is asserted via the withTiming call rather than the rendered digit.)
test("after the ignition sequence settles, a later value change engages the 550ms odometer branch, not the countdown branch", async () => {
  const timing = jest.spyOn(Reanimated, "withTiming");
  const ref = createRef<GaugeDialHandle>();

  const { rerender } = await render(<GaugeDial ref={ref} value={1100} target={2200} ignition={false} />);
  // Sequence fires; the mock settles it synchronously (finished callback
  // runs inline), clearing `sequenceInFlight` back to false before this
  // await resolves.
  await rerender(<GaugeDial ref={ref} value={1100} target={2200} ignition={true} />);
  timing.mockClear();

  // A new value arrives (e.g. a meal logged) after settle.
  await rerender(<GaugeDial ref={ref} value={1650} target={2200} ignition={true} />);

  // The 550ms odometer branch engaged for this transition, not the 1650ms
  // countdown branch — proof the numeral released back to the normal path.
  expect(timing).toHaveBeenCalledWith(550, expect.objectContaining({ duration: 550 }));
  expect(timing).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ duration: 1650 }));

  // sweep() is callable (retargets) post-settle too.
  const spring = jest.spyOn(Reanimated, "withSpring");
  spring.mockClear();
  ref.current?.sweep();
  expect(spring).toHaveBeenCalledWith(0.75, { damping: 30, stiffness: 250 }); // fraction: 1650/2200

  spring.mockRestore();
  timing.mockRestore();
});

// Finding 1 follow-up (kora ignition re-review): the settle callback used to
// clear `sequenceInFlight` only `if (finished)`. A re-render mid-sequence
// (fraction/showIgnition changing from a refetch, plausible right at
// app-open) takes the plain `withSpring(fraction, NEEDLE_SPRING)` branch on
// the NEXT effect run, which cancels the still-in-flight ignition spring —
// its callback then fires with `finished=false`, and the flag used to get
// stuck `true` for the rest of the session. It must clear unconditionally.
test("sequenceInFlight clears even when the settle spring is interrupted (finished=false)", async () => {
  const springSpy = jest.spyOn(Reanimated, "withSpring");
  const timingSpy = jest.spyOn(Reanimated, "withTiming");
  const ref = createRef<GaugeDialHandle>();

  const { rerender } = await render(<GaugeDial ref={ref} value={1100} target={2200} ignition={false} />);
  springSpy.mockClear();

  await rerender(<GaugeDial ref={ref} value={1100} target={2200} ignition={true} />);

  // Find the settle spring's own call (the one configured with
  // springs.ignition) and grab its `finished` callback — the mock already
  // invoked it with `true` automatically, but calling it again ourselves
  // with `false` exercises the interrupted-settle path directly, the same
  // way a cancelled real spring would (called directly, not wrapped in RTL's
  // `act` — the mock applies the resulting setState synchronously, and
  // wrapping it in a second, outer `act()` here disrupts the render queue
  // that the subsequent `await rerender(...)` below depends on).
  const settleCall = springSpy.mock.calls.find(([, config]) => config === springs.ignition);
  expect(settleCall).toBeDefined();
  const settleCallback = settleCall?.[2] as (finished: boolean) => void;
  settleCallback(false);

  // sweep() must be callable (retargets) immediately — the flag cleared.
  springSpy.mockClear();
  ref.current?.sweep();
  expect(springSpy).toHaveBeenCalledWith(0.5, { damping: 30, stiffness: 250 });

  // A later value change engages the 550ms odometer branch, not the stale
  // countdown mechanism.
  timingSpy.mockClear();
  await rerender(<GaugeDial ref={ref} value={1650} target={2200} ignition={true} />);
  expect(timingSpy).toHaveBeenCalledWith(550, expect.objectContaining({ duration: 550 }));

  springSpy.mockRestore();
  timingSpy.mockRestore();
});

describe("over budget", () => {
  it("describeReserve reports overage", () => {
    expect(describeReserve(2320, 2100)).toEqual({ over: true, magnitude: 220, caption: "kcal over budget" });
    expect(describeReserve(860, 2100)).toEqual({ over: false, magnitude: 1240, caption: "kcal in reserve" });
  });
  it("renders +N in danger with the over caption and pins the needle", async () => {
    const { getByText } = await renderGauge({ value: 2320, target: 2100 });
    expect(getByText("+220")).toBeTruthy();
    expect(getByText(/kcal over budget/i)).toBeTruthy();
  });
  it("keeps the calm reserve reading under budget", async () => {
    const { getByText } = await renderGauge({ value: 860, target: 2100 });
    expect(getByText("1,240")).toBeTruthy();
  });
});
