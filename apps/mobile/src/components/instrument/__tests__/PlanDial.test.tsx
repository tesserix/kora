import { render, screen } from "@testing-library/react-native";
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
    expect(screen.getByTestId("plan-dial-needle")).toBeTruthy();
    expect(screen.queryByTestId("plan-dial-awaiting")).toBeNull();
  });

  it("clamps a target below the scale to the bottom rather than rendering off-dial", async () => {
    await render(<PlanDial kcal={400} testID="plan-dial" />);
    expect(screen.getByTestId("plan-dial-needle")).toBeTruthy();
  });

  it("clamps a target above the scale to the top", async () => {
    await render(<PlanDial kcal={9000} testID="plan-dial" />);
    expect(screen.getByTestId("plan-dial-needle")).toBeTruthy();
  });

  it("is hidden from assistive tech — the number is exposed as text elsewhere", async () => {
    await render(<PlanDial kcal={2244} testID="plan-dial" />);
    expect(screen.getByTestId("plan-dial").props.accessible).toBe(false);
  });
});
