import { fireEvent, render } from "@testing-library/react-native";

const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
jest.mock("@/api/hooks", () => ({
  useCreateSavedMeal: () => ({ mutate: mockCreate, isPending: false }),
  useUpdateSavedMeal: () => ({ mutate: mockUpdate, isPending: false }),
  useDeleteSavedMeal: () => ({ mutate: mockDelete, isPending: false }),
}));
jest.mock("@/components/Sheet", () => ({ Sheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => (visible ? children : null) }));
jest.mock("@/components/Segmented", () => ({ Segmented: () => null }));

import { SavedMealSheet } from "../SavedMealSheet";

const usual = {
  id: "u1", name: "Eggs & Oats", meal_slot: "breakfast",
  items: [
    { food_item_id: "f1", name: "Eggs", meal_slot: "breakfast", grams: 100, kcal: 143, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
    { food_item_id: "f2", name: "Oats", meal_slot: "breakfast", grams: 60, kcal: 230, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
  ],
  kcal: 373, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, count: 5, last_logged_at: "2026-07-28T00:00:00Z",
};

beforeEach(() => { mockCreate.mockReset(); mockUpdate.mockReset(); mockDelete.mockReset(); });

test("create-seed prefills name + items, removing one and saving calls create with the kept item", async () => {
  const { getByText, getByLabelText, getByDisplayValue } = await render(
    <SavedMealSheet seed={{ mode: "create", meal: usual as any }} onClose={jest.fn()} />,
  );
  getByDisplayValue("Eggs & Oats"); // name prefilled
  await fireEvent.press(getByLabelText("Remove Oats")); // drop one item
  await fireEvent.press(getByText("Save"));
  expect(mockCreate).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Eggs & Oats", meal_slot: "breakfast", items: [{ food_item_id: "f1", grams: 100 }] }),
    expect.any(Object),
  );
});

test("empty name blocks save", async () => {
  const { getByText, getByLabelText } = await render(
    <SavedMealSheet seed={{ mode: "create", meal: usual as any }} onClose={jest.fn()} />,
  );
  await fireEvent.changeText(getByLabelText("Meal name"), "   ");
  await fireEvent.press(getByText("Save"));
  expect(mockCreate).not.toHaveBeenCalled();
  getByText("Enter a name.");
});

test("edit-seed shows Delete which calls delete", async () => {
  const saved = { id: "s1", name: "My Bfast", meal_slot: "lunch", items: [{ food_item_id: "f1", name: "Eggs", grams: 120, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 }], kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
  const { getByText } = await render(<SavedMealSheet seed={{ mode: "edit", meal: saved as any }} onClose={jest.fn()} />);
  await fireEvent.press(getByText("Delete saved meal"));
  expect(mockDelete).toHaveBeenCalledWith("s1", expect.any(Object));
});
