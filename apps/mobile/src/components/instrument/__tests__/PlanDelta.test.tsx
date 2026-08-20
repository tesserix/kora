import { StyleSheet } from "react-native";
import { act, render } from "@testing-library/react-native";
import { PlanDelta, RESERVE_TEXT } from "../PlanDelta";

async function announce(kcal: number, next: number, floored = false) {
  const r = await render(<PlanDelta kcal={kcal} floored={floored} revision={0} testID="delta" />);
  await r.rerender(<PlanDelta kcal={next} floored={floored} revision={1} testID="delta" />);
  await act(async () => {
    jest.advanceTimersByTime(600);
  });
  return r;
}

describe("PlanDelta", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Announcing on mount would tell a user their target "changed" before they
  // touched anything.
  it("says nothing on first render", async () => {
    const r = await render(<PlanDelta kcal={2244} floored={false} revision={0} testID="delta" />);
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(r.queryByTestId("delta-text")).toBeNull();
  });

  it("names the size and direction of an increase", async () => {
    const r = await render(<PlanDelta kcal={2244} floored={false} revision={0} testID="delta" />);
    await r.rerender(<PlanDelta kcal={2484} floored={false} revision={1} testID="delta" />);
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(r.getByTestId("delta-text")).toHaveTextContent("+240 kcal from that change");
  });

  it("names a decrease", async () => {
    const r = await render(<PlanDelta kcal={2244} floored={false} revision={0} testID="delta" />);
    await r.rerender(<PlanDelta kcal={2044} floored={false} revision={1} testID="delta" />);
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(r.getByTestId("delta-text")).toHaveTextContent("−200 kcal from that change");
  });

  // The clamp is the one moment the target stops obeying the user. Saying
  // nothing would undo the trust the whole screen exists to earn. Revision
  // increments (the user dragged again) even though kcal itself is unchanged
  // because the floor is binding — this is the case a [floored, kcal]
  // dependency array cannot observe.
  it("says the target was held when revision increments, floored is true, and kcal is unchanged", async () => {
    const r = await render(<PlanDelta kcal={726} floored revision={0} testID="delta" />);
    await r.rerender(<PlanDelta kcal={726} floored revision={1} testID="delta" />);
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(r.getByTestId("delta-text")).toHaveTextContent("held at your resting burn");
  });

  // The bug the coordinator caught in round 1: an effect with no dependency
  // array (or one keyed on props that happen not to change) reprocesses on
  // ANY parent re-render, not just ones the user caused. Pin it here: same
  // revision, same floored/kcal — must say nothing, even though the raw
  // ingredients for a "held" message are present.
  it("says nothing when the parent re-renders with the same revision", async () => {
    const r = await render(<PlanDelta kcal={726} floored revision={0} testID="delta" />);
    await r.rerender(<PlanDelta kcal={726} floored revision={0} testID="delta" />);
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(r.queryByTestId("delta-text")).toBeNull();
  });

  it("debounces two rapid revisions into a single announcement", async () => {
    const r = await render(<PlanDelta kcal={2244} floored={false} revision={0} testID="delta" />);
    await r.rerender(<PlanDelta kcal={2344} floored={false} revision={1} testID="delta" />);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    // The first bump's timer has not fired yet — it must be canceled by the
    // second bump rather than firing a message of its own.
    expect(r.queryByTestId("delta-text")).toBeNull();
    await r.rerender(<PlanDelta kcal={2484} floored={false} revision={2} testID="delta" />);
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(r.getAllByTestId("delta-text")).toHaveLength(1);
    expect(r.getByTestId("delta-text")).toHaveTextContent("+140 kcal from that change");
  });

  // Deleting `return () => clearTimeout(timer)` would let a superseded timer
  // fire alongside the surviving one. Both write to the same `message`
  // state, so a "both fired" assertion made only after the fact can't tell
  // the difference — the second write silently overwrites the first and the
  // final DOM looks correct either way. The only way to catch a leaked timer
  // is to look at a moment BETWEEN the two firings: with cleanup, nothing has
  // been said yet; without it, the stale announcement is already on screen.
  it("cancels a superseded announcement rather than letting both fire", async () => {
    const r = await render(<PlanDelta kcal={2000} floored={false} revision={0} testID="delta" />);
    // revision 1 at t=0 schedules "+100" for t=600
    await r.rerender(<PlanDelta kcal={2100} floored={false} revision={1} testID="delta" />);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    // revision 2 at t=300 supersedes it and schedules "+40" for t=900
    await r.rerender(<PlanDelta kcal={2140} floored={false} revision={2} testID="delta" />);
    await act(async () => {
      jest.advanceTimersByTime(350);
    });
    // t=650. Without the cleanup, the superseded t=600 timer has already
    // fired and "+100 kcal from that change" is on screen. With it, nothing
    // has been announced yet.
    expect(r.queryByTestId("delta-text")).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    // t=950: only the surviving announcement lands.
    expect(r.getByTestId("delta-text")).toHaveTextContent("+40 kcal from that change");
  });

  it("announces politely so a drag does not interrupt the screen reader", async () => {
    const r = await render(<PlanDelta kcal={2244} floored={false} revision={0} testID="delta" />);
    await r.rerender(<PlanDelta kcal={2484} floored={false} revision={1} testID="delta" />);
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(r.getByTestId("delta-text").props.accessibilityLiveRegion).toBe("polite");
  });

  // kora#284. The line used to be absent until the first message, then
  // appeared and pushed the rulers down by its own height — under a sticky
  // header, while a finger was on the ruler. These four pin the geometry
  // rather than the copy.
  describe("reserved line", () => {
    it("holds a real, non-empty line open before anything has been said", async () => {
      const r = await render(<PlanDelta kcal={2244} floored={false} revision={0} testID="delta" />);
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      const reserve = r.getByTestId("delta-reserve", { includeHiddenElements: true });
      expect(reserve).toHaveTextContent(RESERVE_TEXT);
      expect(RESERVE_TEXT.length).toBeGreaterThan(0);
    });

    // The only thing in flow is the placeholder, and the placeholder never
    // changes: same string, same variant, same type-affecting style, whether
    // or not there is a message. Jest cannot measure a line box, so this is
    // the strongest statement available here — the height SOURCE is identical
    // across the transition.
    it("does not change the laid-out line between the empty and message states", async () => {
      const empty = await render(
        <PlanDelta kcal={2244} floored={false} revision={0} testID="delta" />,
      );
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      const before = empty.getByTestId("delta-reserve", { includeHiddenElements: true }).props;

      const said = await announce(2244, 2484);
      const after = said.getByTestId("delta-reserve", { includeHiddenElements: true }).props;

      expect(after.children).toEqual(before.children);
      expect(StyleSheet.flatten(after.style)).toEqual(StyleSheet.flatten(before.style));
    });

    it("keeps the message out of flow so neither its arrival nor a change can move anything", async () => {
      const r = await announce(2244, 2484);
      expect(StyleSheet.flatten(r.getByTestId("delta-text").props.style).position).toBe("absolute");

      // message -> different message: still absolute, still the same reserve.
      const reserve = StyleSheet.flatten(r.getByTestId("delta-reserve", { includeHiddenElements: true }).props.style);
      await r.rerender(<PlanDelta kcal={2600} floored={false} revision={2} testID="delta" />);
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      expect(r.getByTestId("delta-text")).toHaveTextContent("+116 kcal from that change");
      expect(StyleSheet.flatten(r.getByTestId("delta-text").props.style).position).toBe("absolute");
      expect(StyleSheet.flatten(r.getByTestId("delta-reserve", { includeHiddenElements: true }).props.style)).toEqual(reserve);
    });

    // An empty line that VoiceOver reads, or stops on, would be worse than the
    // shift it replaces.
    it("says nothing to a screen reader while it is empty", async () => {
      const r = await render(<PlanDelta kcal={2244} floored={false} revision={0} testID="delta" />);
      await act(async () => {
        jest.advanceTimersByTime(600);
      });
      // Not reachable by a default query at all: RNTL excludes hidden
      // elements the same way VoiceOver's element order does, so this is the
      // assertion, and the props below are why it holds.
      expect(r.queryByTestId("delta-reserve")).toBeNull();
      const reserve = r.getByTestId("delta-reserve", { includeHiddenElements: true }).props;
      expect(reserve.accessibilityLiveRegion).toBeUndefined();
      expect(reserve.accessible).toBe(false);
      expect(reserve.accessibilityElementsHidden).toBe(true);
      expect(reserve.importantForAccessibility).toBe("no-hide-descendants");
      expect(StyleSheet.flatten(reserve.style).opacity).toBe(0);
    });

    // The reservation is only sound if it is the widest thing that can land in
    // it — otherwise a long message overflows the box it was meant to fit.
    // Character count is the proxy jest can check; the real guarantee is that
    // the placeholder is built from the same template as the message.
    it.each([
      ["an increase", 2244, 2484, false],
      ["a decrease", 2244, 2044, false],
      ["the held message", 726, 726, true],
      ["the largest plausible rise", 1, 9999, false],
      ["the largest plausible fall", 9999, 1, false],
    ])("reserves at least as much text as %s", async (_name, from, to, floored) => {
      const r = await announce(from as number, to as number, floored as boolean);
      const said = r.getByTestId("delta-text").props.children as string;
      expect(said.length).toBeLessThanOrEqual(RESERVE_TEXT.length);
    });
  });
});
