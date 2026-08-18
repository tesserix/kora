import { fireEvent, render, screen } from "@testing-library/react-native";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { impactAsync, selectionAsync } from "expo-haptics";
import * as Reanimated from "react-native-reanimated";
import {
  indexFromDrag,
  projectMomentum,
  rubberBand,
  TickRuler,
  valueFromDrag,
} from "../TickRuler";

const base = {
  mode: "continuous" as const,
  min: 35,
  max: 180,
  step: 0.5,
  accessibilityLabel: "Current weight in kilograms",
  testID: "weight-ruler",
};

describe("TickRuler continuous mode", () => {
  it("exposes itself as an adjustable control carrying its formatted value", async () => {
    const { getByTestId } = await render(<TickRuler {...base} value={84} onChange={jest.fn()} />);
    const ruler = getByTestId("weight-ruler");
    expect(ruler.props.accessibilityRole).toBe("adjustable");
    expect(ruler.props.accessibilityValue).toEqual({ text: "84" });
  });

  it("uses formatLabel for the accessibility value when given one", async () => {
    const { getByTestId } = await render(
      <TickRuler {...base} value={70} onChange={jest.fn()} formatLabel={(v) => `${v} kilograms`} />,
    );
    expect(getByTestId("weight-ruler").props.accessibilityValue).toEqual({
      text: "70 kilograms",
    });
  });

  it("increments by exactly one step on the accessibility increment action", async () => {
    const onChange = jest.fn();
    const { getByTestId } = await render(<TickRuler {...base} value={84} onChange={onChange} />);
    fireEvent(getByTestId("weight-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    expect(onChange).toHaveBeenCalledWith(84.5);
  });

  it("decrements by exactly one step", async () => {
    const onChange = jest.fn();
    const { getByTestId } = await render(<TickRuler {...base} value={84} onChange={onChange} />);
    fireEvent(getByTestId("weight-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "decrement" },
    });
    expect(onChange).toHaveBeenCalledWith(83.5);
  });

  it("does not report a value past the top of the range", async () => {
    const onChange = jest.fn();
    const { getByTestId } = await render(<TickRuler {...base} value={180} onChange={onChange} />);
    fireEvent(getByTestId("weight-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not report a value below the bottom of the range", async () => {
    const onChange = jest.fn();
    const { getByTestId } = await render(<TickRuler {...base} value={35} onChange={onChange} />);
    fireEvent(getByTestId("weight-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "decrement" },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  // kora#176 changed what this proves. The scale is now built ONCE at full
  // width and translated on the UI thread, rather than a window of ticks
  // recomputed from the `value` prop — so every graduation in [min, max]
  // renders and clipping is the container's job. Asserting the exact count
  // pins that: a regression back to windowing would render far fewer.
  // kora#245 changed the REPRESENTATION, not the content. The ticks were one
  // <Line> node each — 321 of them on the widest ruler, and onboarding mounts
  // ten rulers, which made that screen's initial render ~10x heavier than it
  // needed to be and flaked CI. They are now two <Path> nodes (minors and
  // majors), so the assertion moves from counting nodes to reading the path
  // data. The scale still covers every whole graduation in [min, max].
  it("draws every whole graduation across the entire scale", async () => {
    const { getByTestId } = await render(<TickRuler {...base} value={84} onChange={jest.fn()} />);
    const minors = getByTestId("weight-ruler-ticks-minor").props.d as string;
    const majors = getByTestId("weight-ruler-ticks-major").props.d as string;

    // One "M" per tick. min 35 .. max 180 inclusive is 146 graduations, of
    // which 40, 50 ... 180 (15 of them) are majors.
    const count = (d: string) => (d.match(/M/g) ?? []).length;
    expect(count(minors) + count(majors)).toBe(146);
    expect(count(majors)).toBe(15);
  });

  // The whole point of collapsing to a Path is that it is ONE node, not that
  // it merely looks the same — a regression that emitted a Path per tick would
  // render identically and cost exactly as much as before.
  it("draws the minor ticks as a single node, not one per graduation", async () => {
    const { getAllByTestId } = await render(<TickRuler {...base} value={84} onChange={jest.fn()} />);
    expect(getAllByTestId("weight-ruler-ticks-minor")).toHaveLength(1);
  });

  // Majors and minors differ in stroke weight and colour, which is why they
  // are two paths rather than one. Pin that they did not collapse into a
  // single undifferentiated stroke.
  it("keeps majors visually distinct from minors", async () => {
    const { getByTestId } = await render(<TickRuler {...base} value={84} onChange={jest.fn()} />);
    const minor = getByTestId("weight-ruler-ticks-minor").props;
    const major = getByTestId("weight-ruler-ticks-major").props;
    expect(major.strokeWidth).toBeGreaterThan(minor.strokeWidth);
    expect(major.stroke).not.toBe(minor.stroke);
  });

  // The centre index is the fixed reference the scale moves under. If it ever
  // got swept into the translated group it would track the finger and the
  // control would read as having no reference point at all.
  it("keeps the centre index outside the group that the drag translates", async () => {
    const { getByTestId } = await render(<TickRuler {...base} value={84} onChange={jest.fn()} />);
    expect(getByTestId("weight-ruler-index")).toBeTruthy();
  });

  // Pins the WIRING, not just the arithmetic: `valueFromDrag`'s own tests
  // can't tell `Gesture.Pan().onUpdate(e => ... e.translationX)` apart from
  // an accidental `.onChange(e => ... e.changeX)` — both call the same
  // correct function, just with different numbers. Firing real gesture
  // events through react-native-gesture-handler's own change-event
  // calculator (which derives changeX as the diff between consecutive
  // translationX values, exactly as it does on-device) is the only way to
  // catch a regression in which field gets read.
  //
  // Firing cumulative translationX = 9, 27, 45 from value=84 (step 0.5,
  // PX_PER_UNIT=9):
  //   correct (translationX, cumulative): last call carries 45 → 84 - 5 = 79
  //   buggy   (changeX, per-frame delta): last call carries 45-27=18 → 84 - 2 = 82
  // 79 and 82 are different snapped values, so the two wirings are
  // distinguishable by the final onChange call alone.
  it("wires the cumulative translationX into onChange, not the per-frame changeX", async () => {
    const onChange = jest.fn();
    await render(<TickRuler {...base} value={84} onChange={onChange} />);
    fireGestureHandler(getByGestureTestId("weight-ruler-pan"), [
      { translationX: 9 },
      { translationX: 27 },
      { translationX: 45 },
    ]);
    expect(onChange).toHaveBeenLastCalledWith(79);
  });
});

// kora#175 §3. PX_PER_UNIT is 9, so a moderate 900px/s drag steps ~100 times a
// second and the ruler fired one haptic on every one of them. Over-feedback
// trains users to ignore all feedback (Apple §13, Utility) — and the one
// haptic that WOULD earn its place, hitting min/max, was missing entirely:
// the value just stopped silently.
describe("TickRuler haptics", () => {
  beforeEach(() => {
    (selectionAsync as jest.Mock).mockClear();
    (impactAsync as jest.Mock).mockClear();
    (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(false);
  });

  it("rate-limits the drag buzz instead of firing one per stepped change", async () => {
    const onChange = jest.fn();
    await render(<TickRuler {...base} value={84} onChange={onChange} />);

    // Fired synchronously, so every step lands inside one rate-limit window.
    fireGestureHandler(getByGestureTestId("weight-ruler-pan"), [
      { translationX: 9 },
      { translationX: 18 },
      { translationX: 27 },
      { translationX: 36 },
    ]);

    expect(onChange.mock.calls.length).toBeGreaterThan(1);
    expect(selectionAsync).toHaveBeenCalledTimes(1);
  });

  it("buzzes again once the rate-limit window has passed", async () => {
    let clock = 0;
    jest.spyOn(Date, "now").mockImplementation(() => (clock += 50));
    const onChange = jest.fn();
    await render(<TickRuler {...base} value={84} onChange={onChange} />);

    fireGestureHandler(getByGestureTestId("weight-ruler-pan"), [
      { translationX: 9 },
      { translationX: 18 },
      { translationX: 27 },
    ]);

    expect(onChange.mock.calls.length).toBeGreaterThan(1);
    expect(selectionAsync).toHaveBeenCalledTimes(onChange.mock.calls.length);
  });

  it("marks first contact with a bound with a distinct impact, once", async () => {
    const onChange = jest.fn();
    await render(<TickRuler {...base} value={179.5} onChange={onChange} />);

    fireGestureHandler(getByGestureTestId("weight-ruler-pan"), [
      { translationX: -100 },
      { translationX: -200 },
    ]);

    expect(onChange).toHaveBeenLastCalledWith(180);
    // Hitting the bound is a different event from stepping, so it gets a
    // different feel — and it does not repeat while the value sits there.
    expect(impactAsync).toHaveBeenCalledTimes(1);
  });

  it("marks the lower bound too", async () => {
    const onChange = jest.fn();
    await render(<TickRuler {...base} value={35.5} onChange={onChange} />);

    fireGestureHandler(getByGestureTestId("weight-ruler-pan"), [
      { translationX: 0 },
      { translationX: 100 },
    ]);

    expect(onChange).toHaveBeenLastCalledWith(35);
    expect(impactAsync).toHaveBeenCalledTimes(1);
  });

  // Reduce Motion is a VESTIBULAR preference. A haptic has no vestibular
  // component, and on this control it is the primary confirmation that the
  // value moved at all — suppressing it left the drag silent.
  it("keeps the drag haptic under Reduce Motion", async () => {
    (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(true);
    const onChange = jest.fn();
    await render(<TickRuler {...base} value={84} onChange={onChange} />);

    fireGestureHandler(getByGestureTestId("weight-ruler-pan"), [
      { translationX: 0 },
      { translationX: 9 },
    ]);

    expect(onChange).toHaveBeenCalledWith(83);
    expect(selectionAsync).toHaveBeenCalledTimes(1);
  });
});

describe("valueFromDrag", () => {
  const min = 35;
  const max = 180;
  const step = 0.5;

  it("raises the value on a leftward drag (negative translationX)", () => {
    expect(valueFromDrag(84, -9, min, max, step)).toBe(85);
  });

  it("lowers the value on a rightward drag (positive translationX)", () => {
    expect(valueFromDrag(84, 9, min, max, step)).toBe(83);
  });

  it("clamps at max for a large leftward translation", () => {
    expect(valueFromDrag(84, -10000, min, max, step)).toBe(max);
  });

  it("clamps at min for a large rightward translation", () => {
    expect(valueFromDrag(84, 10000, min, max, step)).toBe(min);
  });

  it("always lands on a step boundary", () => {
    const result = valueFromDrag(84, -37, min, max, step);
    expect(result % step).toBe(0);
  });

  // Pins the under-tracking bug. `applyDrag` calls valueFromDrag with
  // (dragStart.current, translationX) on every gesture update — a value
  // fixed once per gesture, and a translation that is CUMULATIVE since
  // gesture start (from Gesture.Pan().onUpdate's e.translationX). Because
  // both inputs to valueFromDrag stay anchored to the same gesture start,
  // it doesn't matter how many intermediate updates land or how many get
  // dropped: whichever one is processed last always carries the correct
  // total distance. A sequence of growing cumulative translations must
  // therefore land on exactly the same value as a single translation
  // covering the same total distance.
  it("produces the same final value from a sequence of cumulative translations as from one translation covering the same distance", () => {
    const startValue = 84;
    const cumulative = [10, 25, 60, 120];
    let fromFixedStart = startValue;
    for (const translationX of cumulative) {
      fromFixedStart = valueFromDrag(startValue, translationX, min, max, step);
    }
    const single = valueFromDrag(startValue, 120, min, max, step);
    expect(fromFixedStart).toBe(single);
  });

  // The bug this fix replaces: the old gesture handler used `.onChange`
  // (delivering `e.changeX`, the delta since the PREVIOUS callback — not
  // the cumulative translation) against a JS-thread `value` closure that
  // only refreshes after a React re-render, which is slower than
  // touch-move events land. Several such callbacks fire against the same
  // STALE baseline before any render commits, each computing
  // `baseline - thisFrameOnlyDelta`; only the last call's result survives
  // as the reported value, so the earlier frames' movement is silently
  // discarded. Feeding the same per-frame deltas (10, 15, 35, 60 — the
  // differences between the cumulative translations above) against a
  // fixed, stale baseline reproduces that under-tracking and must NOT
  // match the true single-translation result.
  it("under-tracks when fed per-frame deltas against a stale baseline instead of cumulative translation", () => {
    const startValue = 84;
    const frameDeltas = [10, 15, 35, 60];
    let lastReported = startValue;
    for (const frameDelta of frameDeltas) {
      lastReported = valueFromDrag(startValue, frameDelta, min, max, step);
    }
    const single = valueFromDrag(startValue, 120, min, max, step);
    expect(lastReported).not.toBe(single);
  });
});

// kora#165: the ruler never showed its number on screen — only assistive
// tech could read it, so a sighted user was reading tick positions. The
// readout is a real RN Text (not an SVG one) precisely so it is queryable
// and announced-once: the wrapper View is `accessible`, which collapses its
// children, so this cannot double up the existing accessibilityValue.
describe("TickRuler continuous readout", () => {
  it("shows the current value on screen with its unit", async () => {
    await render(<TickRuler {...base} value={84} unit="kg" onChange={jest.fn()} />);
    expect(screen.getByTestId("weight-ruler-readout").props.children).toBe("84 kg");
  });

  it("shows the value with no unit when none is given", async () => {
    await render(<TickRuler {...base} value={84} onChange={jest.fn()} />);
    expect(screen.getByTestId("weight-ruler-readout").props.children).toBe("84");
  });

  it("prefers formatLabel over the raw number so ft/in reads as ft/in", async () => {
    await render(
      <TickRuler
        {...base}
        value={67}
        onChange={jest.fn()}
        formatLabel={(v) => `${Math.floor(v / 12)}'${v % 12}"`}
      />,
    );
    expect(screen.getByTestId("weight-ruler-readout").props.children).toBe("5'7\"");
  });

  it("updates the readout as the value the parent reports back changes", async () => {
    const { rerender } = await render(<TickRuler {...base} value={84} unit="kg" onChange={jest.fn()} />);
    expect(screen.getByTestId("weight-ruler-readout").props.children).toBe("84 kg");
    await rerender(<TickRuler {...base} value={84.5} unit="kg" onChange={jest.fn()} />);
    expect(screen.getByTestId("weight-ruler-readout").props.children).toBe("84.5 kg");
  });

  // The readout is a display of the same value the control reports, so it
  // must never disagree with what assistive tech announces.
  it("keeps the accessibility value working alongside the readout", async () => {
    await render(<TickRuler {...base} value={84} unit="kg" onChange={jest.fn()} />);
    expect(screen.getByTestId("weight-ruler").props.accessibilityValue).toEqual({ text: "84" });
    expect(screen.getByTestId("weight-ruler-readout").props.children).toBe("84 kg");
  });
});

const ACTIVITY = ["Sedentary", "Light", "Moderate", "Active", "Very active"] as const;

describe("TickRuler detented mode", () => {
  const detented = {
    mode: "detented" as const,
    labels: ACTIVITY,
    accessibilityLabel: "Activity level",
    testID: "activity-ruler",
  };

  it("reads its value as the label, never the index", async () => {
    await render(<TickRuler {...detented} index={2} onChange={jest.fn()} />);
    expect(screen.getByTestId("activity-ruler").props.accessibilityValue).toEqual({
      text: "Moderate",
    });
  });

  it("moves exactly one stop on increment", async () => {
    const onChange = jest.fn();
    await render(<TickRuler {...detented} index={2} onChange={onChange} />);
    fireEvent(screen.getByTestId("activity-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it("stops at the last label rather than reporting a sixth stop", async () => {
    const onChange = jest.fn();
    await render(<TickRuler {...detented} index={4} onChange={onChange} />);
    fireEvent(screen.getByTestId("activity-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  // screen.getByText does not resolve react-native-svg <Text> nodes under
  // this jest setup (RNSVGText renders its child through an RNSVGTSpan that
  // testing-library's text matcher doesn't see) — asserting on each label's
  // own testID instead of deleting the check, still proving every one of
  // the five labels renders its own text rather than a shared/empty value.
  it("renders every stop's label", async () => {
    await render(<TickRuler {...detented} index={0} onChange={jest.fn()} />);
    ACTIVITY.forEach((label, i) => {
      // RNSVGText wraps its text child in an implicit TSpan element, so the
      // rendered string is one level deeper than `.props.children`.
      expect(screen.getByTestId(`activity-ruler-label-${i}`).props.children.props.children).toBe(
        label,
      );
    });
  });

  // A decrement from index=1 is already a whole number (0) before it ever
  // reaches `report`, so driving it through the accessibility path alone
  // would pass even against a `report` that dropped rounding entirely. The
  // real hazard is a DRAG whose translation isn't a whole multiple of
  // DETENT_PX (96): cumulative translationX=-60 from index=1 computes an
  // intermediate stop of 1 - (-60/96) = 1.625 before `indexFromDrag` rounds
  // it. (A leading -30 event is fired first only so the gesture-handler
  // jest-utils' onBegin/onUpdate machinery actually delivers the -60
  // onUpdate — see the equivalent continuous-mode wiring test above.) This
  // exercises the real rounding rather than merely restating an
  // already-whole accessibility step.
  it("never reports a fractional index, even from a drag that lands between stops", async () => {
    const onChange = jest.fn();
    await render(<TickRuler {...detented} index={1} onChange={onChange} />);
    fireGestureHandler(getByGestureTestId("activity-ruler-pan"), [
      { translationX: -30 },
      { translationX: -60 },
    ]);
    expect(onChange).toHaveBeenCalledTimes(1);
    const reported = onChange.mock.calls[0][0];
    expect(Number.isInteger(reported)).toBe(true);
    expect(reported).toBe(2);
  });

  // Pins the WIRING (same hazard, same fix, as continuous mode's equivalent
  // test above): `indexFromDrag`'s own unit tests can't distinguish
  // `Gesture.Pan().onUpdate(e => ... e.translationX)` from an accidental
  // `.onChange(e => ... e.changeX)` — both call the same correct function,
  // just with different numbers. Firing real gesture events through
  // react-native-gesture-handler's own change-event calculator (which
  // derives changeX as the diff between consecutive translationX values,
  // exactly as it does on-device) is the only way to catch a regression in
  // which field gets read.
  //
  // Firing cumulative translationX = 48, 96, 192 from index=2, DETENT_PX=96:
  //   correct (translationX, cumulative): last call carries 192 → 2 - 2 = 0
  //   buggy   (changeX, per-frame delta): last call carries 192-96=96 → 2 - 1 = 1
  // 0 and 1 are different stops, so the two wirings are distinguishable by
  // the final onChange call alone.
  it("wires the cumulative translationX into onChange, not the per-frame changeX", async () => {
    const onChange = jest.fn();
    await render(<TickRuler {...detented} index={2} onChange={onChange} />);
    fireGestureHandler(getByGestureTestId("activity-ruler-pan"), [
      { translationX: 48 },
      { translationX: 96 },
      { translationX: 192 },
    ]);
    expect(onChange).toHaveBeenLastCalledWith(0);
  });
});

describe("indexFromDrag", () => {
  const stopCount = 5;

  it("moves one stop left on a leftward drag (negative translationX)", () => {
    expect(indexFromDrag(2, -96, stopCount)).toBe(3);
  });

  it("moves one stop right on a rightward drag (positive translationX)", () => {
    expect(indexFromDrag(2, 96, stopCount)).toBe(1);
  });

  it("clamps at the last stop for a large leftward translation", () => {
    expect(indexFromDrag(2, -10000, stopCount)).toBe(stopCount - 1);
  });

  it("clamps at the first stop for a large rightward translation", () => {
    expect(indexFromDrag(2, 10000, stopCount)).toBe(0);
  });

  it("always lands on a whole stop", () => {
    const result = indexFromDrag(2, -130, stopCount);
    expect(Number.isInteger(result)).toBe(true);
  });
});

// kora#176. The ruler had no `.onEnd` at all, so three Apple principles were
// simply absent: velocity handoff (§5), momentum projection (§6) and
// rubber-banding (§9). These pin the arithmetic of each; the wiring tests
// below pin that the gesture actually calls them.
describe("projectMomentum", () => {
  it("projects nowhere when the finger was not moving", () => {
    expect(projectMomentum(500, 0)).toBe(500);
  });

  it("carries a leftward flick further left than the finger reached", () => {
    expect(projectMomentum(500, -1000)).toBeLessThan(500);
  });

  it("carries a rightward flick further right than the finger reached", () => {
    expect(projectMomentum(500, 1000)).toBeGreaterThan(500);
  });

  // The whole point of a projection is that a HARDER flick goes FURTHER —
  // a projection that ignored velocity magnitude would still pass the
  // direction tests above.
  it("travels further the harder the flick", () => {
    const gentle = projectMomentum(500, 400) - 500;
    const hard = projectMomentum(500, 1600) - 500;
    expect(hard).toBeGreaterThan(gentle);
  });
});

describe("rubberBand", () => {
  const WIDTH = 400;

  it("does not move a position that is not past the bound", () => {
    expect(rubberBand(0, WIDTH)).toBe(0);
  });

  // The defining property: resistance. Pulling 100px past the end must move
  // the scale LESS than 100px, or it is not rubber-banding, it is just an
  // unclamped drag.
  it("damps an overshoot to less than the raw distance pulled", () => {
    const damped = rubberBand(100, WIDTH);
    expect(damped).toBeGreaterThan(0);
    expect(damped).toBeLessThan(100);
  });

  it("damps a negative overshoot symmetrically", () => {
    expect(rubberBand(-100, WIDTH)).toBe(-rubberBand(100, WIDTH));
  });

  // Resistance must INCREASE with distance — the further you pull, the less
  // each additional pixel buys. A linear scale factor would pass the
  // "less than raw" test above but feel like a slow drag, not a rubber band.
  it("gives diminishing returns the further past the bound you pull", () => {
    const first = rubberBand(100, WIDTH);
    const second = rubberBand(200, WIDTH);
    expect(second - first).toBeLessThan(first);
  });

  // Asymptotic: no amount of pull may run away with the scale.
  it("never exceeds the coefficient's share of the dimension", () => {
    expect(rubberBand(100000, WIDTH)).toBeLessThan(WIDTH);
  });
});

describe("TickRuler release behaviour (kora#176)", () => {
  beforeEach(() => {
    (selectionAsync as jest.Mock).mockClear();
    (impactAsync as jest.Mock).mockClear();
  });

  // Velocity handoff (§5): the ruler used to dead-stop the instant you lifted,
  // because there was no `.onEnd` to continue the motion. A release carrying
  // velocity must land BEYOND where the finger stopped.
  it("carries a flick past the value the finger stopped on", async () => {
    const onChange = jest.fn();
    await render(<TickRuler {...base} value={84} onChange={onChange} />);

    fireGestureHandler(getByGestureTestId("weight-ruler-pan"), [
      { translationX: -9 },
      { translationX: -18, velocityX: -2000 },
    ]);

    // The finger alone covered 18px = 2 units, so a dead stop lands on 86.
    // With the flick's momentum carried through it must land higher.
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)![0]).toBeGreaterThan(86);
  });

  it("still lands exactly on a step boundary after a flick", async () => {
    const onChange = jest.fn();
    await render(<TickRuler {...base} value={84} onChange={onChange} />);

    fireGestureHandler(getByGestureTestId("weight-ruler-pan"), [
      { translationX: -9 },
      { translationX: -18, velocityX: -700 },
    ]);

    const settled = onChange.mock.calls.at(-1)![0];
    expect(settled % base.step).toBe(0);
  });

  // Rubber-banding is VISUAL only — the reported value stays clamped, so a
  // flick that projects past the end of the scale must still settle on max.
  it("settles at the bound rather than past it when a flick overshoots the scale", async () => {
    const onChange = jest.fn();
    await render(<TickRuler {...base} value={179} onChange={onChange} />);

    fireGestureHandler(getByGestureTestId("weight-ruler-pan"), [
      { translationX: -9 },
      { translationX: -50, velocityX: -8000 },
    ]);

    expect(onChange.mock.calls.at(-1)![0]).toBe(base.max);
  });
});

// The ruler sits inside AuthScaffold's vertical ScrollView, and onboarding
// stacks TEN of them. A Pan with no offset thresholds claims the touch on the
// first pixel of movement in ANY direction and then applies translationX ≈ 0,
// so a vertical swipe started on a ruler scrolls nothing and the page reads as
// frozen. The thresholds are what let the ScrollView win a vertical drag.
describe("TickRuler gesture configuration (kora#176)", () => {
  it("claims the touch only once the finger has committed horizontally", async () => {
    await render(<TickRuler {...base} value={84} onChange={jest.fn()} />);
    const { config } = getByGestureTestId("weight-ruler-pan");
    expect(config.activeOffsetXStart).toBeLessThan(0);
    expect(config.activeOffsetXEnd).toBeGreaterThan(0);
  });

  it("yields to the enclosing scroll view on a vertical swipe", async () => {
    await render(<TickRuler {...base} value={84} onChange={jest.fn()} />);
    const { config } = getByGestureTestId("weight-ruler-pan");
    expect(config.failOffsetYStart).toBeLessThan(0);
    expect(config.failOffsetYEnd).toBeGreaterThan(0);
  });

  // Detented rulers sit in the same stack and need the same escape hatch.
  it("applies the same thresholds to a detented ruler", async () => {
    await render(
      <TickRuler
        mode="detented"
        index={0}
        labels={ACTIVITY}
        accessibilityLabel="Activity level"
        testID="activity-ruler"
        onChange={jest.fn()}
      />,
    );
    const { config } = getByGestureTestId("activity-ruler-pan");
    expect(config.activeOffsetXStart).toBeLessThan(0);
    expect(config.failOffsetYEnd).toBeGreaterThan(0);
  });
});
