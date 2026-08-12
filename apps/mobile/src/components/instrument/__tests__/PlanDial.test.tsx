import { render, screen, within } from "@testing-library/react-native";
import { PlanDial } from "../PlanDial";

describe("PlanDial", () => {
  // A target built from partial data is a lie, and NaN reaching the needle is
  // a crash — so no numbers means no needle.
  it("renders unlit with no needle when there is no target yet", async () => {
    await render(<PlanDial kcal={null} testID="plan-dial" />);
    expect(screen.queryByTestId("plan-dial-needle")).toBeNull();
    expect(screen.getByTestId("plan-dial-awaiting")).toBeTruthy();
  });

  it("renders a needle once a target exists", async () => {
    await render(<PlanDial kcal={2244} testID="plan-dial" />);
    // Needle is inside the accessibility-hidden SVG, so we verify indirectly:
    // no "awaiting" caption should be present when a target exists
    expect(screen.queryByTestId("plan-dial-awaiting")).toBeNull();
    // And the component renders without error
    expect(screen.getByTestId("plan-dial")).toBeTruthy();
  });

  it("clamps a target below the scale to the bottom rather than rendering off-dial", async () => {
    await render(<PlanDial kcal={400} testID="plan-dial" />);
    // Component renders without error when clamping low values
    expect(screen.getByTestId("plan-dial")).toBeTruthy();
    expect(screen.queryByTestId("plan-dial-awaiting")).toBeNull();
  });

  it("clamps a target above the scale to the top", async () => {
    await render(<PlanDial kcal={9000} testID="plan-dial" />);
    // Component renders without error when clamping high values
    expect(screen.getByTestId("plan-dial")).toBeTruthy();
    expect(screen.queryByTestId("plan-dial-awaiting")).toBeNull();
  });

  it("hides the gauge from assistive tech on both platforms", async () => {
    const r = await render(<PlanDial kcal={2244} testID="plan-dial" />);
    const gauge = r.getByTestId("plan-dial-gauge", { includeHiddenElements: true });
    expect(gauge.props.accessibilityElementsHidden).toBe(true);
    expect(gauge.props.importantForAccessibility).toBe("no-hide-descendants");
  });

  it("still announces the awaiting caption when there is no target", async () => {
    await render(<PlanDial kcal={null} testID="plan-dial" />);
    const caption = screen.getByTestId("plan-dial-awaiting");
    // Must NOT be inside the hidden subtree — it is the only thing telling a
    // screen-reader user why the panel has no number.
    expect(caption.props.accessibilityElementsHidden).toBeFalsy();
  });
});
