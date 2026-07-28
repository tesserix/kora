import { fireEvent, render } from "@testing-library/react-native";

const mockLogMeal = jest.fn();
const mockLogFood = jest.fn();
let mockMemoryReturn: any = { data: undefined, isLoading: true, isError: false };

jest.mock("@/api/hooks", () => ({ useMemory: () => mockMemoryReturn }));
jest.mock("@/api/useInstantLog", () => ({ useInstantLog: () => ({ logMeal: mockLogMeal, logFood: mockLogFood }) }));
jest.mock("@/lib/mealSlot", () => ({ mealSlotForHour: () => "breakfast" }));

import { YourUsualStrip } from "../YourUsualStrip";

const meal = { id: "m1", name: "Oats & Egg", meal_slot: "breakfast", items: [{ food_item_id: "o", name: "Oats", meal_slot: "breakfast", grams: 60, kcal: 233, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, count: 3, last_logged_at: "" }], kcal: 376, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, count: 3, last_logged_at: "" };
const food = { food_item_id: "b", name: "Banana", meal_slot: "breakfast", grams: 120, kcal: 107, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, count: 4, last_logged_at: "" };

beforeEach(() => {
  mockLogMeal.mockClear();
  mockLogFood.mockClear();
});

test("renders nothing while loading", async () => {
  mockMemoryReturn = { data: undefined, isLoading: true, isError: false };
  const { toJSON } = await render(<YourUsualStrip />);
  expect(toJSON()).toBeNull();
});

test("renders nothing when there is nothing for the slot", async () => {
  mockMemoryReturn = { data: { recents: [], frequent: [], usual_meals: [] }, isLoading: false, isError: false };
  const { toJSON } = await render(<YourUsualStrip />);
  expect(toJSON()).toBeNull();
});

test("renders the slot title and rows, and taps log them", async () => {
  mockMemoryReturn = { data: { recents: [], frequent: [food], usual_meals: [meal] }, isLoading: false, isError: false };
  const { getByText } = await render(<YourUsualStrip />);
  getByText("Your usual breakfast");
  await fireEvent.press(getByText("Oats & Egg"));
  expect(mockLogMeal).toHaveBeenCalledTimes(1);
  await fireEvent.press(getByText("Banana"));
  expect(mockLogFood).toHaveBeenCalledTimes(1);
});
