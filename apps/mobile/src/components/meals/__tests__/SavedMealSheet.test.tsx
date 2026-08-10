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

// Save is now gated on readiness (see canSave in SavedMealSheet), so a
// whitespace-only name disables the button instead of allowing a press that
// surfaces "Enter a name." — the gate stops the invalid submission before it
// happens rather than after. save()'s own name check remains as a backstop
// for any state the gate doesn't cover.
test("empty name disables save", async () => {
  const { getByLabelText } = await render(
    <SavedMealSheet seed={{ mode: "create", meal: usual as any }} onClose={jest.fn()} />,
  );
  await fireEvent.changeText(getByLabelText("Meal name"), "   ");
  expect(getByLabelText("Save").props.accessibilityState.disabled).toBe(true);
  expect(mockCreate).not.toHaveBeenCalled();
});

test("create failure surfaces an error message", async () => {
  mockCreate.mockImplementationOnce((_body, opts) => opts.onError?.());
  const { getByText, getByLabelText } = await render(
    <SavedMealSheet seed={{ mode: "create", meal: usual as any }} onClose={jest.fn()} />,
  );
  await fireEvent.changeText(getByLabelText("Meal name"), "Eggs & Oats");
  await fireEvent.press(getByText("Save"));
  expect(mockCreate).toHaveBeenCalled();
  getByText("Couldn't save. Please try again.");
});

test("edit-seed shows Delete which calls delete", async () => {
  const saved = { id: "s1", name: "My Bfast", meal_slot: "lunch", items: [{ food_item_id: "f1", name: "Eggs", grams: 120, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 }], kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
  const { getByText } = await render(<SavedMealSheet seed={{ mode: "edit", meal: saved as any }} onClose={jest.fn()} />);
  await fireEvent.press(getByText("Delete saved meal"));
  expect(mockDelete).toHaveBeenCalledWith("s1", expect.any(Object));
});

test("a blank seed opens an empty sheet with save disabled", async () => {
  const { getByLabelText, queryByText } = await render(<SavedMealSheet seed={{ mode: "blank" }} onClose={() => {}} />);

  expect(getByLabelText("Meal name").props.value).toBe("");
  // Nothing to save yet — this must read as not-ready, not as an error the
  // user caused by opening the sheet.
  expect(getByLabelText("Save").props.accessibilityState.disabled).toBe(true);
  expect(queryByText("Add at least one item with grams.")).toBeNull();
});

test("a compose seed carries each row's entered unit into the sheet", async () => {
  const items = [
    { food_item_id: "f1", name: "NESCAFÉ Mocha", quantity_grams: 16.5, entered_amount: 1, entered_unit: "portion" },
    { food_item_id: "f2", name: "Milk", quantity_grams: 200, entered_amount: null, entered_unit: null },
  ];
  const { getByText, queryByText } = await render(<SavedMealSheet seed={{ mode: "compose", items }} onClose={() => {}} />);

  expect(getByText("NESCAFÉ Mocha")).toBeTruthy();
  expect(getByText("Milk")).toBeTruthy();
  // Name pre-filled from the first item so the user edits rather than types.
  expect(queryByText("Add at least one item with grams.")).toBeNull();
});
