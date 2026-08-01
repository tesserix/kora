import { render, fireEvent, waitFor } from "@testing-library/react-native";
import MealDetail from "../meal";

const mockEditMutate = jest.fn();
const mockDeleteMutate = jest.fn();
const mockRepeatMutate = jest.fn();
const mockResolveTextMutate = jest.fn();
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

jest.mock("expo-router", () => ({
  router: { back: () => mockBack() },
  useLocalSearchParams: () => ({
    id: "log1", name: "Brown rice", mealSlot: "breakfast", time: "8:00 AM",
    kcal: "300", protein: "6", carbs: "64", fat: "2", grams: "200",
  }),
}));

jest.mock("@/api/hooks", () => ({
  useLog: () => ({ data: mockLogData, isLoading: false }),
  useFoodSearch: () => ({ data: [], isLoading: false, isError: false }),
  useEditLog: () => ({ mutate: mockEditMutate, isPending: false }),
  useDeleteLog: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useRepeatLog: () => ({ mutate: mockRepeatMutate, isPending: false }),
  useResolveText: () => ({ mutate: mockResolveTextMutate, isPending: false }),
  // The delete-undo path re-creates via useCreateLog — not exercised here
  // (that's meal-undo.test.tsx's job), but the hook must exist on this mock
  // or rendering throws.
  useCreateLog: () => ({ mutate: jest.fn(), isPending: false }),
}));

beforeEach(() => {
  mockEditMutate.mockClear();
  mockDeleteMutate.mockClear();
  mockRepeatMutate.mockClear();
  mockResolveTextMutate.mockClear();
  mockBack.mockClear();
  mockLogData = {
    id: "log1",
    food_item_id: "f1",
    logged_at: "2026-07-31T08:00:00Z",
    meal_slot: "breakfast",
    source: "manual",
    description: "Brown rice",
    quantity_grams: 200,
    kcal: 300,
    protein_g: 6,
    carbs_g: 64,
    fat_g: 2,
    provenance: "manual",
    input_phrase: undefined,
  };
});

test("Ask Kora again is hidden when the log has no input_phrase", async () => {
  const { queryByLabelText } = await render(<MealDetail />);
  expect(queryByLabelText("Ask Kora again")).toBeNull();
});

test("Ask Kora again is shown for an ai_text log and re-resolves the edited phrase", async () => {
  mockLogData = { ...mockLogData!, source: "ai_text", provenance: "ai", input_phrase: "brekkie eggs" };

  const { getByLabelText, getByDisplayValue } = await render(<MealDetail />);

  expect(getByLabelText("Ask Kora again")).toBeTruthy();
  await fireEvent.press(getByLabelText("Ask Kora again"));

  const input = getByDisplayValue("brekkie eggs");
  await fireEvent.changeText(input, "scrambled eggs");
  await fireEvent.press(getByLabelText("Submit phrase to Kora"));

  expect(mockResolveTextMutate).toHaveBeenCalledWith(
    "scrambled eggs",
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

test("choosing a candidate from the re-run PATCHes that food", async () => {
  mockLogData = { ...mockLogData!, source: "ai_text", provenance: "ai", input_phrase: "brekkie eggs" };
  mockResolveTextMutate.mockImplementation((_phrase, opts) => {
    opts.onSuccess({
      candidates: [
        {
          item: {
            id: "f9",
            name: "Scrambled eggs",
            brand: "",
            provenance: "seed",
            serving_desc: "2 eggs",
            serving_grams: 100,
            kcal_per_100g: 150,
            protein_per_100g: 12,
            carbs_per_100g: 1,
            fat_per_100g: 10,
          },
          portion_grams: 100,
          kcal: 150,
          match_score: 0.92,
          match_tier: "ai",
        },
      ],
      tier: "auto",
      is_estimate: false,
      provenance: "ai",
    });
  });

  const { getByLabelText, getByText } = await render(<MealDetail />);

  await fireEvent.press(getByLabelText("Ask Kora again"));
  await fireEvent.press(getByLabelText("Submit phrase to Kora"));

  await waitFor(() => expect(getByText("Scrambled eggs")).toBeTruthy());
  await fireEvent.press(getByLabelText("Select Scrambled eggs"));

  await waitFor(() => expect(mockEditMutate).toHaveBeenCalled());
  expect(mockEditMutate).toHaveBeenCalledWith(
    expect.objectContaining({ id: "log1", food_item_id: "f9" }),
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

test("follow_up tier shows the question and a manual-search fallback, without logging anything", async () => {
  mockLogData = { ...mockLogData!, source: "ai_text", provenance: "ai", input_phrase: "brekkie eggs" };
  mockResolveTextMutate.mockImplementation((_phrase, opts) => {
    opts.onSuccess({
      candidates: [],
      tier: "follow_up",
      follow_up_question: "Was that fried or scrambled?",
      is_estimate: false,
      provenance: "ai",
    });
  });

  const { getByLabelText, getByText } = await render(<MealDetail />);

  await fireEvent.press(getByLabelText("Ask Kora again"));
  await fireEvent.press(getByLabelText("Submit phrase to Kora"));

  await waitFor(() => expect(getByText("Was that fried or scrambled?")).toBeTruthy());
  expect(getByLabelText("Search manually instead")).toBeTruthy();
  expect(mockEditMutate).not.toHaveBeenCalled();
});

test("zero candidates shows a couldn't-identify message and the manual-search fallback", async () => {
  mockLogData = { ...mockLogData!, source: "ai_text", provenance: "ai", input_phrase: "brekkie eggs" };
  mockResolveTextMutate.mockImplementation((_phrase, opts) => {
    opts.onSuccess({ candidates: [], tier: "confirm", is_estimate: false, provenance: "ai" });
  });

  const { getByLabelText, getByText } = await render(<MealDetail />);

  await fireEvent.press(getByLabelText("Ask Kora again"));
  await fireEvent.press(getByLabelText("Submit phrase to Kora"));

  await waitFor(() => expect(getByText("Kora couldn't identify that.")).toBeTruthy());
  expect(getByLabelText("Search manually instead")).toBeTruthy();
  expect(mockEditMutate).not.toHaveBeenCalled();
});

test("a resolve failure shows an inline error and leaves the log untouched", async () => {
  mockLogData = { ...mockLogData!, source: "ai_text", provenance: "ai", input_phrase: "brekkie eggs" };
  mockResolveTextMutate.mockImplementation((_phrase, opts) => {
    opts.onError(new Error("network down"));
  });

  const { getByLabelText, getByText } = await render(<MealDetail />);

  await fireEvent.press(getByLabelText("Ask Kora again"));
  await fireEvent.press(getByLabelText("Submit phrase to Kora"));

  await waitFor(() => expect(getByText("Couldn't ask Kora right now. Try again.")).toBeTruthy());
  expect(mockEditMutate).not.toHaveBeenCalled();
});
