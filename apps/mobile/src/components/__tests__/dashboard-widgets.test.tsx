import { render } from "@testing-library/react-native";
import { ProvenanceChip } from "../ProvenanceChip";
import { MacroBars } from "@/components/home/MacroBars";
import { UNKNOWN_PROVENANCE } from "@/api/types";

test("ProvenanceChip labels verified vs estimate", async () => {
  const verified = await render(<ProvenanceChip provenance="afcd" />);
  expect(verified.getByText(/verified/i)).toBeTruthy();
  const estimate = await render(<ProvenanceChip provenance="user_estimate" />);
  expect(estimate.getByText(/estimate/i)).toBeTruthy();
});

// An offline-cache-synthesized food (see foodsFromPins/foodsFromSavedMeals in
// src/offline/foodCache.ts) has exact macros reverse-scaled from real
// numbers — it is not a model's guess, so it must not carry the "AI estimate
// ±15%" disclaimer that every OTHER unverified provenance gets.
test("ProvenanceChip renders nothing for an unknown/synthesized provenance", async () => {
  const { queryByText, toJSON } = await render(<ProvenanceChip provenance={UNKNOWN_PROVENANCE} />);
  expect(queryByText(/estimate/i)).toBeNull();
  expect(toJSON()).toBeNull();
});

describe("MacroBars v2", () => {
  it("renders three gradient fills sized to each macro percent", async () => {
    const { getByTestId } = await render(
      <MacroBars macros={{ p: 50, c: 100, f: 20, pGoal: 100, cGoal: 200, fGoal: 40, fib: 10, fibGoal: 30 }} />,
    );
    // 50/100 → width 50 in a 0..100 viewBox
    expect(getByTestId("macro-fill-protein").props.width).toBeCloseTo(50, 1);
    expect(getByTestId("macro-fill-carbs").props.width).toBeCloseTo(50, 1);
    expect(getByTestId("macro-fill-fat").props.width).toBeCloseTo(50, 1);
  });
  it("clamps over-goal to 100 and shows gram labels", async () => {
    const { getByTestId, getByText } = await render(
      <MacroBars macros={{ p: 200, c: 0, f: 0, pGoal: 100, cGoal: 200, fGoal: 40, fib: 0, fibGoal: 30 }} />,
    );
    expect(getByTestId("macro-fill-protein").props.width).toBeCloseTo(100, 1);
    expect(getByText("200g / 100g")).toBeTruthy();
  });
});
