import { render } from "@testing-library/react-native";

const mockLogFood = jest.fn();
const mockToggle = jest.fn();
let mockPinsResult: { data?: unknown; isLoading?: boolean; isError?: boolean } = { data: [] };

jest.mock("@/api/hooks", () => ({ usePins: () => mockPinsResult }));
jest.mock("@/api/usePinToggle", () => ({ usePinToggle: () => ({ pinnedIds: new Set(["f1"]), toggle: mockToggle }) }));
jest.mock("@/api/useInstantLog", () => ({ useInstantLog: () => ({ logFood: mockLogFood, logMeal: jest.fn() }) }));

import { PinnedStrip } from "../PinnedStrip";

beforeEach(() => { mockPinsResult = { data: [] }; });

test("renders null when there are no pins", async () => {
  mockPinsResult = { data: [] };
  const { toJSON } = await render(<PinnedStrip />);
  expect(toJSON()).toBeNull();
});

test("renders a Pinned section with the pinned foods", async () => {
  mockPinsResult = { data: [{ food_item_id: "f1", name: "Egg", meal_slot: "breakfast", grams: 100, kcal: 143, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 }] };
  const { getByText } = await render(<PinnedStrip />);
  getByText("Pinned");
  getByText("Egg");
});
