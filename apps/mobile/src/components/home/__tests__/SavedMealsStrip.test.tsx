import { render } from "@testing-library/react-native";

const mockLogMeal = jest.fn();
const mockOpenEdit = jest.fn();
let mockSaved: { data?: unknown; isLoading?: boolean; isError?: boolean } = { data: [] };

jest.mock("@/api/hooks", () => ({ useSavedMeals: () => mockSaved }));
jest.mock("@/api/useInstantLog", () => ({ useInstantLog: () => ({ logMeal: mockLogMeal, logFood: jest.fn() }) }));
jest.mock("@/components/meals/SavedMealSheetProvider", () => ({ useSavedMealEditor: () => ({ openCreate: jest.fn(), openEdit: mockOpenEdit }) }));

import { SavedMealsStrip } from "../SavedMealsStrip";

beforeEach(() => { mockSaved = { data: [] }; });

test("null when there are no saved meals", async () => {
  const { toJSON } = await render(<SavedMealsStrip />);
  expect(toJSON()).toBeNull();
});

test("renders a Saved section with the meals", async () => {
  mockSaved = { data: [{ id: "s1", name: "My Bfast", meal_slot: "breakfast", items: [{ food_item_id: "f1", name: "Eggs", grams: 100, kcal: 143, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 }], kcal: 143, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 }] };
  const { getByText } = await render(<SavedMealsStrip />);
  getByText("Saved");
  getByText("My Bfast");
});
