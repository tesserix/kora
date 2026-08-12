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
    const r = await render(<PlanDelta kcal={2244} floored={false} testID="delta" />);
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(r.queryByTestId("delta-text")).toBeNull();
  });

  it("names the size and direction of an increase", async () => {
    const r = await render(<PlanDelta kcal={2244} floored={false} testID="delta" />);
    await r.rerender(<PlanDelta kcal={2484} floored={false} testID="delta" />);
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(r.getByTestId("delta-text")).toHaveTextContent("+240 kcal from that change");
  });

  it("names a decrease", async () => {
    const r = await render(<PlanDelta kcal={2244} floored={false} testID="delta" />);
    await r.rerender(<PlanDelta kcal={2044} floored={false} testID="delta" />);
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(r.getByTestId("delta-text")).toHaveTextContent("−200 kcal from that change");
  });

  // The clamp is the one moment the target stops obeying the user. Saying
  // nothing would undo the trust the whole screen exists to earn.
  it("says the target was held when the floor binds and the number did not move", async () => {
    const r = await render(<PlanDelta kcal={726} floored testID="delta" />);
    await r.rerender(<PlanDelta kcal={726} floored testID="delta" />);
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(r.getByTestId("delta-text")).toHaveTextContent("held at your resting burn");
  });

  it("announces politely so a drag does not interrupt the screen reader", async () => {
    const r = await render(<PlanDelta kcal={2244} floored={false} testID="delta" />);
    await r.rerender(<PlanDelta kcal={2484} floored={false} testID="delta" />);
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(r.getByTestId("delta-text").props.accessibilityLiveRegion).toBe("polite");
  });
});
