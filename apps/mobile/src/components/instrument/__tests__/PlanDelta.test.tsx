import { act, render } from "@testing-library/react-native";
import { PlanDelta } from "../PlanDelta";

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
});
