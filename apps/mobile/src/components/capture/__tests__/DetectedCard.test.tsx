import { fireEvent, render } from "@testing-library/react-native";
import { DetectedCard } from "../DetectedCard";
import type { Resolution } from "@/api/types";

function makeResolution(overrides: Partial<Resolution> = {}): Resolution {
  return {
    candidates: [
      {
        item: {
          id: "1",
          name: "Grilled chicken breast",
          brand: "",
          provenance: "afcd",
          serving_desc: "1 breast",
          serving_grams: 140,
          kcal_per_100g: 165,
          protein_per_100g: 31,
          carbs_per_100g: 0,
          fat_per_100g: 3.6,
        },
        portion_grams: 140.4,
        kcal: 231.2,
        match_score: 0.958,
        match_tier: "auto",
      },
      {
        item: {
          id: "2",
          name: "Steamed broccoli",
          brand: "",
          provenance: "afcd",
          serving_desc: "1 cup",
          serving_grams: 90,
          kcal_per_100g: 34,
          protein_per_100g: 2.8,
          carbs_per_100g: 7,
          fat_per_100g: 0.4,
        },
        portion_grams: 90.2,
        kcal: 30.6,
        match_score: 0.912,
        match_tier: "auto",
      },
    ],
    tier: "auto",
    is_estimate: false,
    provenance: "afcd",
    ...overrides,
  };
}

test("renders candidate rows with row-sourced grams/match/kcal and a header count", async () => {
  const resolution = makeResolution();
  const { getByText } = await render(
    <DetectedCard
      resolution={resolution}
      mealSlot="lunch"
      onChangeMealSlot={jest.fn()}
      onAdd={jest.fn()}
      adding={false}
    />,
  );

  expect(getByText(/Detected · 2 items/i)).toBeTruthy();
  expect(getByText("Grilled chicken breast")).toBeTruthy();
  expect(getByText("140g · 96% match")).toBeTruthy();
  expect(getByText("231")).toBeTruthy();
  expect(getByText("Steamed broccoli")).toBeTruthy();
  expect(getByText("90g · 91% match")).toBeTruthy();
  expect(getByText("31")).toBeTruthy();
});

test("shows the summed kcal when the resolution is not an estimate", async () => {
  const resolution = makeResolution({ is_estimate: false });
  const { getByText } = await render(
    <DetectedCard
      resolution={resolution}
      mealSlot="lunch"
      onChangeMealSlot={jest.fn()}
      onAdd={jest.fn()}
      adding={false}
    />,
  );

  // 231.2 + 30.6 = 261.8 -> rounds to 262
  expect(getByText("262 kcal")).toBeTruthy();
});

test("shows a kcal range when the resolution is an estimate", async () => {
  const resolution = makeResolution({ is_estimate: true, kcal_low: 380, kcal_high: 440 });
  const { getByText } = await render(
    <DetectedCard
      resolution={resolution}
      mealSlot="lunch"
      onChangeMealSlot={jest.fn()}
      onAdd={jest.fn()}
      adding={false}
    />,
  );

  expect(getByText("380–440 kcal")).toBeTruthy();
});

test("pressing a meal-slot chip calls onChangeMealSlot with that slot", async () => {
  const onChangeMealSlot = jest.fn();
  const resolution = makeResolution();
  const { getByText } = await render(
    <DetectedCard
      resolution={resolution}
      mealSlot="lunch"
      onChangeMealSlot={onChangeMealSlot}
      onAdd={jest.fn()}
      adding={false}
    />,
  );

  fireEvent.press(getByText("Breakfast"));
  expect(onChangeMealSlot).toHaveBeenCalledWith("breakfast");
});

test("pressing add to diary calls onAdd", async () => {
  const onAdd = jest.fn();
  const resolution = makeResolution();
  const { getByText } = await render(
    <DetectedCard
      resolution={resolution}
      mealSlot="lunch"
      onChangeMealSlot={jest.fn()}
      onAdd={onAdd}
      adding={false}
    />,
  );

  fireEvent.press(getByText("Add to diary"));
  expect(onAdd).toHaveBeenCalledTimes(1);
});

test("shows a spinner and hides the label while adding", async () => {
  const resolution = makeResolution();
  const { queryByText, getByTestId } = await render(
    <DetectedCard
      resolution={resolution}
      mealSlot="lunch"
      onChangeMealSlot={jest.fn()}
      onAdd={jest.fn()}
      adding
    />,
  );

  expect(queryByText("Add to diary")).toBeNull();
  expect(getByTestId("detected-card-adding-spinner")).toBeTruthy();
});
