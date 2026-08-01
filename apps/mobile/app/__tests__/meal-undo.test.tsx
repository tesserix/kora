import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import MealDetail from "../meal";

const mockEditMutate = jest.fn();
const mockEditMutateAsync = jest.fn();
const mockDeleteMutate = jest.fn();
const mockRepeatMutate = jest.fn();
const mockCreateLogMutate = jest.fn();
const mockCreateLogMutateAsync = jest.fn();
const mockToastShow = jest.fn();
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

// Candidates keyed by a lowercase substring of the search query, so a test
// can drive a SECOND correction (e.g. Quinoa -> Kale) to a distinct result
// without every search returning the same single item.
const mockFoodCandidates: Record<string, { id: string; name: string; kcal: number }> = {
  quinoa: { id: "f2", name: "Quinoa", kcal: 120 },
  kale: { id: "f3", name: "Kale", kcal: 35 },
};

jest.mock("@/api/hooks", () => ({
  useLog: () => ({ data: mockLogData, isLoading: false }),
  useFoodSearch: (query: string) => {
    const key = Object.keys(mockFoodCandidates).find((k) => query.toLowerCase().includes(k));
    const match = key ? mockFoodCandidates[key] : undefined;
    return {
      data: match
        ? [
            {
              item: {
                id: match.id,
                name: match.name,
                brand: "",
                provenance: "seed",
                serving_desc: "1 cup",
                serving_grams: 185,
                kcal_per_100g: match.kcal,
                protein_per_100g: 4.4,
                carbs_per_100g: 21.3,
                fat_per_100g: 1.9,
              },
              match_score: 1,
              match_tier: "fulltext",
            },
          ]
        : [],
      isLoading: false,
      isError: false,
    };
  },
  useEditLog: () => ({ mutate: mockEditMutate, mutateAsync: mockEditMutateAsync, isPending: false }),
  useDeleteLog: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useRepeatLog: () => ({ mutate: mockRepeatMutate, isPending: false }),
  useCreateLog: () => ({ mutate: mockCreateLogMutate, mutateAsync: mockCreateLogMutateAsync, isPending: false }),
  // mockLogData defaults to input_phrase: "brekkie eggs", so MealDetail mounts
  // AskAgainSheet too — it isn't exercised here, but the hook it calls must
  // exist on this mock or rendering throws.
  useResolveText: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("@/components/Toast", () => ({
  useToast: () => ({ show: mockToastShow }),
}));

beforeEach(() => {
  mockEditMutate.mockClear();
  mockEditMutateAsync.mockReset();
  mockDeleteMutate.mockClear();
  mockRepeatMutate.mockClear();
  mockCreateLogMutate.mockClear();
  mockCreateLogMutateAsync.mockReset();
  mockToastShow.mockClear();
  mockBack.mockClear();
  // Safe defaults so a bare `.then()`/`.catch()` on the undo path never
  // throws on an unresolved mock — tests that care override with
  // mockResolvedValueOnce/mockRejectedValueOnce.
  mockEditMutateAsync.mockResolvedValue({ log: mockLogData, aliasRecorded: false });
  mockCreateLogMutateAsync.mockResolvedValue(undefined);
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
});

test("a correction that taught the index offers an in-sheet Undo and retracts on tap", async () => {
  // The forward correction (Change food -> Quinoa) resolves with
  // aliasRecorded: true — the server actually wrote the alias.
  mockEditMutate.mockImplementationOnce((patch, opts) => {
    opts.onSuccess({
      log: {
        ...mockLogData,
        food_item_id: patch.food_item_id,
        description: "Quinoa",
        quantity_grams: patch.quantity_grams,
        meal_slot: patch.meal_slot,
      },
      aliasRecorded: true,
    });
  });

  const { getByLabelText, getByText, queryByText } = await render(<MealDetail />);

  await fireEvent.press(getByLabelText("Change food"));
  await fireEvent.changeText(getByLabelText("Search foods"), "quinoa");
  await fireEvent.press(getByText("Quinoa"));

  // FIX 1: this confirmation + Undo must live INSIDE the sheet, not in a
  // toast — a toast renders beneath this still-open native Modal and is
  // invisible/untappable. Asserting via the toast mock would pass even if
  // the invisible-toast bug were still present, so this test deliberately
  // never looks at mockToastShow for the food-correction path.
  await waitFor(() => expect(getByLabelText("Undo food change")).toBeTruthy());
  expect(getByText(/Now Quinoa/)).toBeTruthy();
  expect(queryByText(/remember/i)).toBeTruthy();
  expect(getByText(/brekkie eggs/)).toBeTruthy();
  expect(mockToastShow).not.toHaveBeenCalled();

  await fireEvent.press(getByLabelText("Undo food change"));

  // The undo PATCHes back to the ORIGINAL food (f1), not the corrected one
  // (f2) — this is the single most important assertion in this suite. The
  // undo goes through mutateAsync, not mutate, so a failed restore surfaces
  // even after this sheet has been dismissed (see the failure test below).
  await waitFor(() => expect(mockEditMutateAsync).toHaveBeenCalledTimes(1));
  const [undoPatch] = mockEditMutateAsync.mock.calls[0];
  expect(undoPatch).toEqual({
    id: "log1",
    food_item_id: "f1",
    quantity_grams: 200,
    meal_slot: "breakfast",
    retract_correction: true,
  });

  // Tapping Undo clears the row.
  await waitFor(() => expect(queryByText(/Now Quinoa/)).toBeNull());
});

test("a correction that taught nothing undoes without retract_correction", async () => {
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

  const { getByLabelText, getByText, queryByText } = await render(<MealDetail />);

  await fireEvent.press(getByLabelText("Change food"));
  await fireEvent.changeText(getByLabelText("Search foods"), "quinoa");
  await fireEvent.press(getByText("Quinoa"));

  await waitFor(() => expect(getByLabelText("Undo food change")).toBeTruthy());
  expect(queryByText(/remember/i)).toBeNull();

  await fireEvent.press(getByLabelText("Undo food change"));

  await waitFor(() => expect(mockEditMutateAsync).toHaveBeenCalledTimes(1));
  const [undoPatch] = mockEditMutateAsync.mock.calls[0];
  expect(undoPatch).not.toHaveProperty("retract_correction");
  expect(undoPatch).toEqual({
    id: "log1",
    food_item_id: "f1",
    quantity_grams: 200,
    meal_slot: "breakfast",
  });
});

test("a second correction's Undo reverts to the SECOND correction's prior food, not the first's", async () => {
  // First correction: Brown rice (f1) -> Quinoa (f2).
  mockEditMutate.mockImplementationOnce((patch, opts) => {
    opts.onSuccess({
      log: {
        ...mockLogData,
        food_item_id: patch.food_item_id,
        description: "Quinoa",
        quantity_grams: patch.quantity_grams,
        meal_slot: patch.meal_slot,
      },
      aliasRecorded: true,
    });
  });

  const { getByLabelText, getByText, queryByText } = await render(<MealDetail />);

  await fireEvent.press(getByLabelText("Change food"));
  await fireEvent.changeText(getByLabelText("Search foods"), "quinoa");
  await fireEvent.press(getByText("Quinoa"));

  await waitFor(() => expect(getByText(/Now Quinoa/)).toBeTruthy());

  // Second correction: Quinoa (f2) -> Kale (f3). The row must now describe
  // THIS correction, and its Undo must restore f2 (Quinoa) — not f1.
  mockEditMutate.mockImplementationOnce((patch, opts) => {
    opts.onSuccess({
      log: {
        ...mockLogData,
        food_item_id: patch.food_item_id,
        description: "Kale",
        quantity_grams: patch.quantity_grams,
        meal_slot: patch.meal_slot,
      },
      aliasRecorded: false,
    });
  });

  await fireEvent.press(getByLabelText("Change food"));
  await fireEvent.changeText(getByLabelText("Search foods"), "kale");
  await fireEvent.press(getByText("Kale"));

  await waitFor(() => expect(getByText(/Now Kale/)).toBeTruthy());
  expect(queryByText(/Now Quinoa/)).toBeNull();

  await fireEvent.press(getByLabelText("Undo food change"));

  await waitFor(() => expect(mockEditMutateAsync).toHaveBeenCalledTimes(1));
  const [undoPatch] = mockEditMutateAsync.mock.calls[0];
  expect(undoPatch).toEqual({
    id: "log1",
    // The SECOND correction's prior food was f2 (Quinoa), not f1.
    food_item_id: "f2",
    quantity_grams: 200,
    meal_slot: "breakfast",
  });
});

test("a food correction undo that fails surfaces a visible inline error instead of a toast", async () => {
  mockEditMutate.mockImplementationOnce((patch, opts) => {
    opts.onSuccess({
      log: {
        ...mockLogData,
        food_item_id: patch.food_item_id,
        description: "Quinoa",
        quantity_grams: patch.quantity_grams,
        meal_slot: patch.meal_slot,
      },
      aliasRecorded: true,
    });
  });
  mockEditMutateAsync.mockRejectedValueOnce(new Error("network down"));

  const { getByLabelText, getByText } = await render(<MealDetail />);

  await fireEvent.press(getByLabelText("Change food"));
  await fireEvent.changeText(getByLabelText("Search foods"), "quinoa");
  await fireEvent.press(getByText("Quinoa"));

  await waitFor(() => expect(getByLabelText("Undo food change")).toBeTruthy());

  await fireEvent.press(getByLabelText("Undo food change"));

  await waitFor(() => expect(getByText("Couldn't undo. Try again.")).toBeTruthy());
  // The old (invisible-under-the-modal) toast path must not be used for this
  // failure either.
  expect(mockToastShow).not.toHaveBeenCalled();
});

test("deleting offers Undo which re-creates the log", async () => {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => {
    const del = (buttons ?? []).find((b) => b.style === "destructive");
    del?.onPress?.();
  });
  mockDeleteMutate.mockImplementation((_id, opts) => opts.onSuccess());

  const { getByLabelText } = await render(<MealDetail />);
  await fireEvent.press(getByLabelText("Delete entry"));

  expect(mockBack).toHaveBeenCalled();
  await waitFor(() => expect(mockToastShow).toHaveBeenCalledTimes(1));
  const [toastArgs] = mockToastShow.mock.calls[0];
  expect(toastArgs.message).toBe("Removed");
  expect(toastArgs.actionLabel).toBe("Undo");

  toastArgs.onAction();

  expect(mockCreateLogMutateAsync).toHaveBeenCalledTimes(1);
  const [recreateInput] = mockCreateLogMutateAsync.mock.calls[0];
  expect(recreateInput).toMatchObject({
    food_item_id: "f1",
    quantity_grams: 200,
    meal_slot: "breakfast",
    logged_at: "2026-07-31T08:00:00Z",
    // source is what makes the server keep input_phrase at all (only
    // ai_text/ai_voice sources retain a phrase) — a regression dropping it
    // would otherwise pass unnoticed.
    source: "ai_text",
    // A later correction on the restored log can still teach the index only
    // if the phrase survives the re-create.
    input_phrase: "brekkie eggs",
  });

  alertSpy.mockRestore();
});

test("a failed delete-undo surfaces a visible error instead of failing silently", async () => {
  // This is the case FIX 1 targets: onDelete's onSuccess calls router.back()
  // BEFORE the toast's Undo can ever run, so MealDetail is always unmounted
  // by the time the re-create fires. mutate()'s onError is a no-op once the
  // subscribing component is gone; mutateAsync's rejection is not, so the
  // toast still surfaces.
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => {
    const del = (buttons ?? []).find((b) => b.style === "destructive");
    del?.onPress?.();
  });
  mockDeleteMutate.mockImplementation((_id, opts) => opts.onSuccess());
  mockCreateLogMutateAsync.mockRejectedValueOnce(new Error("network down"));

  const { getByLabelText } = await render(<MealDetail />);
  await fireEvent.press(getByLabelText("Delete entry"));

  await waitFor(() => expect(mockToastShow).toHaveBeenCalledTimes(1));
  const [toastArgs] = mockToastShow.mock.calls[0];

  toastArgs.onAction();

  await waitFor(() => expect(mockToastShow).toHaveBeenCalledTimes(2));
  const [, secondToastCall] = mockToastShow.mock.calls;
  expect(secondToastCall[0]).toEqual({ message: "Couldn't restore. Try again." });

  alertSpy.mockRestore();
});

test("a correction with no prior food_item_id shows the confirmation without an actionable Undo", async () => {
  // Defence-in-depth: unreachable today (the server rejects a nil
  // food_item_id at log creation), but if it ever happened, PATCHing back
  // `food_item_id: undefined` would drop the key from the JSON body, the
  // server would see foodChanged === false, and Undo would silently do
  // nothing while still claiming to work.
  mockLogData = { ...mockLogData!, food_item_id: undefined };
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

  const { getByLabelText, getByText, queryByLabelText } = await render(<MealDetail />);

  await fireEvent.press(getByLabelText("Change food"));
  await fireEvent.changeText(getByLabelText("Search foods"), "quinoa");
  await fireEvent.press(getByText("Quinoa"));

  await waitFor(() => expect(getByText(/Now Quinoa/)).toBeTruthy());
  expect(queryByLabelText("Undo food change")).toBeNull();
  expect(mockToastShow).not.toHaveBeenCalled();
});
