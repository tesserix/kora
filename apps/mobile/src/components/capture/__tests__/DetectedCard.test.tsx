import { fireEvent, render } from "@testing-library/react-native";
import { DetectedCard } from "../DetectedCard";
import type { Resolution } from "@/api/types";

function renderCard(resolution: Resolution, onResolveUncertain?: (index: number) => void) {
  return render(
    <DetectedCard
      resolution={resolution}
      mealSlot="snack"
      onChangeMealSlot={() => {}}
      onAdd={() => {}}
      adding={false}
      onResolveUncertain={onResolveUncertain}
    />,
  );
}

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

test("renders candidate rows with row-sourced grams/kcal and a header count", async () => {
  const resolution = makeResolution();
  const { getByText, queryByText } = await render(
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
  // The portion stays; the raw "% match" is gone — it was false precision.
  expect(getByText("140g")).toBeTruthy();
  expect(queryByText(/% match/)).toBeNull();
  expect(getByText("231 kcal")).toBeTruthy();
  expect(getByText("Steamed broccoli")).toBeTruthy();
  expect(getByText("90g")).toBeTruthy();
  expect(getByText("31 kcal")).toBeTruthy();
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
  const { getByLabelText } = await render(
    <DetectedCard
      resolution={resolution}
      mealSlot="lunch"
      onChangeMealSlot={jest.fn()}
      onAdd={onAdd}
      adding={false}
    />,
  );

  fireEvent.press(getByLabelText("Add to diary"));
  expect(onAdd).toHaveBeenCalledTimes(1);
});

test("shows a spinner and hides the label while adding", async () => {
  const resolution = makeResolution();
  const { queryByText, getByTestId, getByLabelText } = await render(
    <DetectedCard
      resolution={resolution}
      mealSlot="lunch"
      onChangeMealSlot={jest.fn()}
      onAdd={jest.fn()}
      adding
    />,
  );

  expect(queryByText("Add 2 items to diary")).toBeNull();
  expect(getByTestId("detected-card-adding-spinner")).toBeTruthy();
  expect(getByLabelText("Adding to diary")).toBeTruthy();
});

// The second candidate is demoted to follow_up; the first stays confident.
function makeMixedResolution(): Resolution {
  const base = makeResolution();
  return {
    ...base,
    candidates: [
      { ...base.candidates[0], tier: "auto" },
      { ...base.candidates[1], tier: "follow_up" },
    ],
  };
}

test("an uncertain item shows a prompt instead of a kcal figure", async () => {
  const { getAllByText, queryByText } = await renderCard(makeMixedResolution());

  expect(queryByText("Not sure which — tap to confirm")).toBeTruthy();
  // 30.6 rounds to 31 — the uncertain row must not print it.
  expect(queryByText("31 kcal")).toBeNull();
  expect(queryByText("—")).toBeTruthy();
  // The confident row still shows its own kcal; the header total matches it.
  expect(getAllByText("231 kcal")).toHaveLength(2);
});

test("the header total counts only what will be logged", async () => {
  const { getAllByText, queryByText } = await renderCard(makeMixedResolution());

  // 231.2 alone, not 231.2 + 30.6 (which would be 262).
  expect(getAllByText("231 kcal")).toHaveLength(2);
  expect(queryByText("262 kcal")).toBeNull();
});

test("the CTA counts loggable items, not detected ones", async () => {
  const { getByText } = await renderCard(makeMixedResolution());

  expect(getByText("Detected · 2 items")).toBeTruthy();
  expect(getByText("Add 1 item to diary")).toBeTruthy();
});

test("the CTA is disabled when every item is uncertain", async () => {
  const base = makeResolution();
  const allUncertain = {
    ...base,
    candidates: base.candidates.map((c) => ({ ...c, tier: "follow_up" as const })),
  };
  const { getByLabelText } = await renderCard(allUncertain);

  expect(getByLabelText("Add to diary").props.accessibilityState.disabled).toBe(true);
});

test("tapping an uncertain row asks to resolve it by index", async () => {
  const onResolveUncertain = jest.fn();
  const { getByLabelText } = await renderCard(makeMixedResolution(), onResolveUncertain);

  fireEvent.press(getByLabelText("Confirm Steamed broccoli"));

  expect(onResolveUncertain).toHaveBeenCalledWith(1);
});

// The row the user resolved by hand is loggable — it counts toward the CTA —
// but no server kcal exists for it yet. It must render "—", never "0 kcal".
// A naive "only uncertain rows hide kcal" implementation passes every other
// test in this file and fails only this one.
test("a hand-picked row is loggable but still shows no kcal", async () => {
  const base = makeResolution();
  const promoted = {
    ...base,
    candidates: [
      { ...base.candidates[0], tier: "auto" as const },
      { ...base.candidates[1], tier: "confirm" as const, kcal: 0, kcal_unknown: true },
    ],
  };
  const { getAllByText, getByText, queryByText } = await renderCard(promoted);

  expect(getByText("Add 2 items to diary")).toBeTruthy();
  expect(queryByText("0 kcal")).toBeNull();
  expect(queryByText("—")).toBeTruthy();
  expect(getAllByText("231 kcal")).toHaveLength(2);
});
