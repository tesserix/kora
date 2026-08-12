import { fireEvent, render, screen } from "@testing-library/react-native";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";
import { indexFromDrag, TickRuler, valueFromDrag } from "../TickRuler";

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

  it("renders a tick for every major graduation in view", async () => {
    const { getAllByTestId } = await render(<TickRuler {...base} value={84} onChange={jest.fn()} />);
    expect(getAllByTestId(/^weight-ruler-tick-/).length).toBeGreaterThan(0);
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

  it("never reports a fractional index", async () => {
    const onChange = jest.fn();
    await render(<TickRuler {...detented} index={1} onChange={onChange} />);
    fireEvent(screen.getByTestId("activity-ruler"), "accessibilityAction", {
      nativeEvent: { actionName: "decrement" },
    });
    const reported = onChange.mock.calls[0][0];
    expect(Number.isInteger(reported)).toBe(true);
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
