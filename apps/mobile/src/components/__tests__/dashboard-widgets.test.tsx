import { render } from "@testing-library/react-native";
import { ProvenanceChip } from "../ProvenanceChip";
import { MacroBars } from "@/components/home/MacroBars";

test("ProvenanceChip labels verified vs estimate", async () => {
  const verified = await render(<ProvenanceChip provenance="afcd" />);
  expect(verified.getByText(/verified/i)).toBeTruthy();
  const estimate = await render(<ProvenanceChip provenance="user_estimate" />);
  expect(estimate.getByText(/estimate/i)).toBeTruthy();
});

describe("MacroBars v2", () => {
  it("renders three gradient fills sized to each macro percent", async () => {
    const { getByTestId } = await render(
      <MacroBars macros={{ p: 50, c: 100, f: 20, pGoal: 100, cGoal: 200, fGoal: 40 }} />,
    );
    // 50/100 → width 50 in a 0..100 viewBox
    expect(getByTestId("macro-fill-protein").props.width).toBeCloseTo(50, 1);
    expect(getByTestId("macro-fill-carbs").props.width).toBeCloseTo(50, 1);
    expect(getByTestId("macro-fill-fat").props.width).toBeCloseTo(50, 1);
  });
  it("clamps over-goal to 100 and shows gram labels", async () => {
    const { getByTestId, getByText } = await render(
      <MacroBars macros={{ p: 200, c: 0, f: 0, pGoal: 100, cGoal: 200, fGoal: 40 }} />,
    );
    expect(getByTestId("macro-fill-protein").props.width).toBeCloseTo(100, 1);
    expect(getByText("200g / 100g")).toBeTruthy();
  });
});
