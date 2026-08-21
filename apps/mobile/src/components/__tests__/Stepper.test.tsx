import { act, render, fireEvent } from "@testing-library/react-native";
import { Stepper } from "../Stepper";

test("increments by step and decrements clamped at min", async () => {
  const onChange = jest.fn();
  const { getByLabelText, rerender } = await render(<Stepper value={100} onChange={onChange} step={10} min={10} />);
  await fireEvent.press(getByLabelText("Increase"));
  expect(onChange).toHaveBeenLastCalledWith(110);

  await rerender(<Stepper value={10} onChange={onChange} step={10} min={10} />);
  await fireEvent.press(getByLabelText("Decrease"));
  expect(onChange).toHaveBeenLastCalledWith(10); // clamped, not 0
});

// kora#237 §3 reported both ± buttons as passing a STATIC `style={btn}` with no
// press-down visual. They do not — `btn` has been a `(state) => style` function
// since 7a088fe5 (the kora#175 feedback sweep), and pressFeedback.test.tsx
// already pins that it dims. The issue is stale on that point.
//
// What was NOT pinned anywhere is the thing that made the report worth
// checking: these buttons carry `onPressIn`/`onPressOut` for the repeat timers,
// so the `style` function and the timer handlers share the same press. These
// two pin that they do not fight — the hold still repeats, and the release
// still does not tick a second time on top of it.
describe("the press-down dim does not disturb the repeat-step timers", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // Two idioms this file cannot do without, both of which fail QUIETLY:
  //  - `advance` runs inside act() because the interval calls onChange, which
  //    is a setState in the parent, and RNTL will not see it otherwise.
  //  - every fireEvent is AWAITED. An un-awaited one under fake timers leaves
  //    its act() scope open ("overlapping act() calls" on stderr, not a
  //    failure), and the renderer stays poisoned for the REST OF THE FILE —
  //    the next test's render finds no elements at all. The symptom points at
  //    the wrong test entirely.
  const advance = async (ms: number) => {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
  };

  it("repeats while held and does not add a trailing tick on release", async () => {
    const onChange = jest.fn();
    const { getByLabelText } = await render(<Stepper value={100} onChange={onChange} step={10} />);
    const inc = getByLabelText("Increase");

    await fireEvent(inc, "pressIn");
    expect(onChange).not.toHaveBeenCalled(); // 400ms arming delay — nothing yet

    await advance(400);
    expect(onChange).toHaveBeenLastCalledWith(110);

    await advance(240); // two more 120ms intervals
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenLastCalledWith(130);

    // Release: onPressOut clears the timers, and the trailing onPress has to be
    // swallowed because the hold already ticked.
    await fireEvent(inc, "pressOut");
    await fireEvent.press(inc);
    expect(onChange).toHaveBeenCalledTimes(3);

    await advance(1000);
    expect(onChange).toHaveBeenCalledTimes(3); // the interval really is cleared
  });

  it("still ticks exactly once for a tap that never reaches the repeat delay", async () => {
    const onChange = jest.fn();
    const { getByLabelText } = await render(<Stepper value={100} onChange={onChange} step={10} />);
    const dec = getByLabelText("Decrease");

    await fireEvent(dec, "pressIn");
    await advance(100);
    await fireEvent(dec, "pressOut");
    await fireEvent.press(dec);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(90);
  });
});
