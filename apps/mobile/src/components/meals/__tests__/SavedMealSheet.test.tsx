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

// FoodPicker itself is a real search UI backed by useFoodSearch — irrelevant
// to what this suite is testing (the seeding math in SavedMealSheet's own
// addItem handler). Stubbed the way other suites stub a heavy child
// component (see sign-in.test.tsx's LinkAccountPrompt mock): a single
// pressable, gated on `visible`, that fires onSelect with a fixed food —
// a 16.5 g sachet with one named serving {portion, amount 1, base_amount
// 16.5} — so addItem's derivation is what the test actually exercises.
jest.mock("@/components/meal/FoodPicker", () => {
  const { Pressable, Text } = require("react-native");
  return {
    FoodPicker: ({ visible, onSelect }: { visible: boolean; onSelect: (item: unknown) => void }) =>
      visible ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Select NESCAFÉ Mocha"
          onPress={() =>
            onSelect({
              id: "sachet1",
              name: "NESCAFÉ Mocha",
              brand: "Nescafé",
              provenance: "afcd",
              serving_desc: "1 portion",
              serving_grams: 16.5,
              kcal_per_100g: 400,
              protein_per_100g: 10,
              carbs_per_100g: 60,
              fat_per_100g: 12,
              serving_units: [{ name: "portion", amount: 1, base_amount: 16.5 }],
            })
          }
        >
          <Text>Select NESCAFÉ Mocha</Text>
        </Pressable>
      ) : null,
  };
});

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
  await fireEvent.press(getByLabelText("Save"));
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
  await fireEvent.press(getByLabelText("Save"));
  expect(mockCreate).not.toHaveBeenCalled();
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

test("adding an ingredient seeds it as a named serving, not raw grams", async () => {
  const { getByText, getByLabelText } = await render(<SavedMealSheet seed={{ mode: "blank" }} onClose={() => {}} />);

  await fireEvent.press(getByText("+ Add ingredient"));
  // FoodPicker is mocked in this suite to select a fixed food — a sachet whose
  // serving_grams is 16.5 with one named serving {portion, 1, 16.5}.
  await fireEvent.press(getByLabelText("Select NESCAFÉ Mocha"));

  // Seeded as one portion, NOT as "16.5 g" — the whole point of the unit work.
  expect(getByText("1 portion (16.5 g)")).toBeTruthy();
});

test("adding an ingredient to an existing meal appends rather than replaces", async () => {
  const items = [{ food_item_id: "f2", name: "Milk", quantity_grams: 200, entered_amount: null, entered_unit: null }];
  const { getByText, getByLabelText } = await render(<SavedMealSheet seed={{ mode: "compose", items }} onClose={() => {}} />);

  await fireEvent.press(getByText("+ Add ingredient"));
  await fireEvent.press(getByLabelText("Select NESCAFÉ Mocha"));

  expect(getByText("Milk")).toBeTruthy();
  expect(getByText("NESCAFÉ Mocha")).toBeTruthy();
});

// Regression for fix-round-1 finding: rows used to be keyed by food_item_id,
// which collides the moment the same food is added twice (a legitimate case
// — e.g. two different portions of the same milk logged separately). With a
// colliding key, when the FIRST of two same-keyed rows is removed, React's
// array reconciler matches the sole surviving element positionally against
// the OLD position-0 fiber — i.e. the REMOVED row's own fiber — and reuses
// its hooks. PortionField's `enteredExactMode` (see PortionField.tsx) is
// genuinely local-only, never resynced from props (unlike exactText, which a
// resync effect keeps in step with amount/unit and would mask this), so a
// toggle made on the second row before the first is removed would otherwise
// silently vanish — the survivor renders back in stepper mode. This never
// touches the entered data, only the UI mode, and reuses the SAME food both
// times, so no props-only diff between the two rows could tell them apart —
// only two robustly distinct client identities can.
test("adding the same food twice keeps each row's own exact-mode toggle when the OTHER row is removed", async () => {
  const { getByText, getAllByText, getAllByLabelText, getByLabelText, queryByText } = await render(
    <SavedMealSheet seed={{ mode: "blank" }} onClose={() => {}} />,
  );

  await fireEvent.press(getByText("+ Add ingredient"));
  await fireEvent.press(getByLabelText("Select NESCAFÉ Mocha"));
  await fireEvent.press(getByText("+ Add ingredient"));
  await fireEvent.press(getByLabelText("Select NESCAFÉ Mocha"));

  // Both rows render — same food, two independent rows.
  expect(getAllByText("NESCAFÉ Mocha")).toHaveLength(2);
  expect(getAllByText("1 portion (16.5 g)")).toHaveLength(2);

  // Toggle the SECOND row into exact mode — a pure local UI change, no data
  // mutation, so the two rows' entered pairs stay identical.
  await fireEvent.press(getAllByText("Enter exact amount")[1]);

  // Remove the FIRST row (still in stepper mode).
  await fireEvent.press(getAllByLabelText("Remove NESCAFÉ Mocha")[0]);

  // The survivor is the second row, which was switched to exact mode — it
  // must still show that entry field, not the stepper it never displayed.
  expect(getByLabelText("Amount")).toBeTruthy();
  expect(queryByText("1 portion (16.5 g)")).toBeNull();
});
