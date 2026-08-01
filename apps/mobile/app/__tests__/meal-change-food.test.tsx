import { render, fireEvent, waitFor } from "@testing-library/react-native";
import MealDetail from "../meal";

const mockEditMutate = jest.fn();
const mockDeleteMutate = jest.fn();
const mockRepeatMutate = jest.fn();
const mockBack = jest.fn();

let mockLogData:
  | {
      id: string;
      food_item_id?: string;
      logged_at: string;
      meal_slot: string;
      source: string;
      description: string;
      quantity_grams: number;
      kcal: number;
      protein_g: number;
      carbs_g: number;
      fat_g: number;
      provenance: string;
      input_phrase?: string;
    }
  | undefined;
let mockLogIsLoading = false;

jest.mock("expo-router", () => ({
  router: { back: () => mockBack() },
  useLocalSearchParams: () => ({
    id: "log1", name: "Brown rice", mealSlot: "breakfast", time: "8:00 AM",
    kcal: "300", protein: "6", carbs: "64", fat: "2", grams: "200",
  }),
}));

jest.mock("@/api/hooks", () => ({
  useLog: () => ({ data: mockLogData, isLoading: mockLogIsLoading }),
  useFoodSearch: () => ({
    data: [
      {
        item: {
          id: "f2",
          name: "Quinoa",
          brand: "",
          provenance: "seed",
          serving_desc: "1 cup",
          serving_grams: 185,
          kcal_per_100g: 120,
          protein_per_100g: 4.4,
          carbs_per_100g: 21.3,
          fat_per_100g: 1.9,
        },
        match_score: 1,
        match_tier: "fulltext",
      },
    ],
    isLoading: false,
    isError: false,
  }),
  useEditLog: () => ({ mutate: mockEditMutate, isPending: false }),
  useDeleteLog: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useRepeatLog: () => ({ mutate: mockRepeatMutate, isPending: false }),
  // mockLogData defaults to input_phrase: "brekkie eggs", so MealDetail mounts
  // AskAgainSheet in these tests too — it isn't exercised here (that's
  // meal-ask-again.test.tsx's job), but the hook it calls must exist on this
  // mock or rendering throws.
  useResolveText: () => ({ mutate: jest.fn(), isPending: false }),
  // The delete-undo path re-creates via useCreateLog — not exercised here
  // (that's meal-undo.test.tsx's job), but the hook must exist on this mock
  // or rendering throws.
  useCreateLog: () => ({ mutate: jest.fn(), isPending: false }),
}));

beforeEach(() => {
  mockEditMutate.mockClear();
  mockDeleteMutate.mockClear();
  mockRepeatMutate.mockClear();
  mockBack.mockClear();
  mockLogData = {
    id: "log1",
    food_item_id: "f1",
    logged_at: "2026-07-31T08:00:00Z",
    meal_slot: "breakfast",
    source: "ai_text",
    description: "Brown rice",
    quantity_grams: 200,
    kcal: 300,
    protein_g: 6,
    carbs_g: 64,
    fat_g: 2,
    provenance: "ai",
    input_phrase: "brekkie eggs",
  };
  mockLogIsLoading = false;
});

test("tapping the food name opens a picker and selecting PATCHes food_item_id along with the current portion and slot", async () => {
  const { getByLabelText, getByText } = await render(<MealDetail />);

  await fireEvent.press(getByLabelText("Change food"));
  await fireEvent.changeText(getByLabelText("Search foods"), "quinoa");
  await fireEvent.press(getByText("Quinoa"));

  await waitFor(() => expect(mockEditMutate).toHaveBeenCalled());
  // The server applies food_item_id, quantity_grams and meal_slot together —
  // sending the user's current (unedited) portion/slot here is a harmless
  // no-op, but it means the response legitimately reflects what the user
  // intended rather than echoing back stale values.
  expect(mockEditMutate).toHaveBeenCalledWith(
    { id: "log1", food_item_id: "f2", quantity_grams: 200, meal_slot: "breakfast" },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
  const [patch] = mockEditMutate.mock.calls[0];
  expect(patch).not.toHaveProperty("retract_correction");
});

test("editing the portion before changing the food sends the edited grams, and the edit survives the response", async () => {
  // Simulate a real PATCH round-trip: the server applies all three fields it
  // was sent and echoes them back, exactly like the "harmless no-op" comment
  // above claims — so this also proves that claim, not just the request shape.
  mockEditMutate.mockImplementationOnce((patch, opts) => {
    opts.onSuccess({
      log: {
        ...mockLogData,
        food_item_id: patch.food_item_id,
        description: "Quinoa",
        quantity_grams: patch.quantity_grams,
        meal_slot: patch.meal_slot,
      },
      aliasRecorded: false,
    });
  });

  const { getByLabelText, getByText } = await render(<MealDetail />);

  // Drag the portion from 200g to 210g (Save becomes enabled) ...
  await fireEvent.press(getByLabelText("Increase"));
  expect(getByText("210 g")).toBeTruthy();

  // ... then change the food before saving.
  await fireEvent.press(getByLabelText("Change food"));
  await fireEvent.changeText(getByLabelText("Search foods"), "quinoa");
  await fireEvent.press(getByText("Quinoa"));

  await waitFor(() => expect(mockEditMutate).toHaveBeenCalled());
  const [patch] = mockEditMutate.mock.calls[0];
  expect(patch).toMatchObject({ id: "log1", food_item_id: "f2", quantity_grams: 210, meal_slot: "breakfast" });

  // The 210g edit must not vanish once the server's response lands.
  expect(getByText("210 g")).toBeTruthy();
});

test("the sheet paints from route params before the fetch resolves", async () => {
  mockLogData = undefined;
  mockLogIsLoading = true;

  const { getAllByText, queryByText } = await render(<MealDetail />);

  expect(getAllByText("Brown rice").length).toBeGreaterThan(0);
  expect(queryByText("Loading…")).toBeNull();
});
