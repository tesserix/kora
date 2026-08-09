import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import MealDetail from "../meal";

const mockEditMutate = jest.fn();
const mockEditMutateAsync = jest.fn();
const mockDeleteMutate = jest.fn();
const mockRepeatMutate = jest.fn();
const mockToastShow = jest.fn();
const mockBack = jest.fn();
let mockRepeatPending = false;

type MockLog = {
  id: string;
  food_item_id?: string;
  logged_at: string;
  meal_slot: string;
  source: string;
  description: string;
  quantity_grams: number;
  entered_amount?: number | null;
  entered_unit?: string | null;
  base_unit?: string;
  serving_units?: { name: string; amount: number; base_amount: number }[];
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  provenance: string;
  input_phrase?: string;
};

let mockLogData: MockLog | undefined;

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
  useEditLog: () => ({ mutate: mockEditMutate, mutateAsync: mockEditMutateAsync, isPending: false }),
  useDeleteLog: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useRepeatLog: () => ({ mutate: mockRepeatMutate, isPending: mockRepeatPending }),
  // meal.tsx's delete-undo path re-creates via useCreateLog — not exercised
  // by these tests (that's meal-undo.test.tsx's job), but the hook must
  // exist on this mock or rendering throws.
  useCreateLog: () => ({ mutate: jest.fn(), mutateAsync: jest.fn().mockResolvedValue(undefined), isPending: false }),
}));

jest.mock("@/components/Toast", () => ({
  useToast: () => ({ show: mockToastShow }),
}));

beforeEach(() => {
  mockEditMutate.mockClear();
  mockEditMutateAsync.mockReset();
  mockEditMutateAsync.mockResolvedValue({ log: undefined, aliasRecorded: false });
  mockDeleteMutate.mockClear();
  mockRepeatMutate.mockClear();
  mockToastShow.mockClear();
  mockBack.mockClear();
  mockRepeatPending = false;
  // Existing tests in this file render before the log fetch resolves — keep
  // that behavior as the default so they're unaffected by this mock gaining
  // the ability to carry data.
  mockLogData = undefined;
});

// Seeds a fetched log (overriding the route-param-only defaults) and renders
// MealDetail. `item` carries the food's own base_unit/serving_units — the
// log-fetch endpoint doesn't actually return these today, but the mock
// carries them the same way a future response could, and meal.tsx falls
// back to synthesizing a single serving from entered_amount/entered_unit
// when they're absent (see servingUnitsFor in app/meal.tsx).
async function renderMeal(overrides: {
  quantity_grams?: number;
  entered_amount?: number;
  entered_unit?: string;
  item?: { base_unit?: string; serving_units?: { name: string; amount: number; base_amount: number }[] };
} = {}) {
  const { item, ...rest } = overrides;
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
    base_unit: item?.base_unit,
    serving_units: item?.serving_units,
    ...rest,
  };
  return render(<MealDetail />);
}

test("editing a sachet log sends the entered unit, not grams", async () => {
  const { getByLabelText, getByText } = await renderMeal({
    quantity_grams: 16.5,
    entered_amount: 1,
    entered_unit: "sachet",
    item: { base_unit: "g", serving_units: [{ name: "sachet", amount: 1, base_amount: 16.5 }] },
  });

  await fireEvent.press(getByLabelText("Increase amount"));
  await fireEvent.press(getByText("Save changes"));

  // The client sends what the user entered; the SERVER derives the grams.
  expect(mockEditMutate).toHaveBeenCalledWith(
    expect.objectContaining({ entered_amount: 2, entered_unit: "sachet" }),
    expect.anything(),
  );
  expect(mockEditMutate).not.toHaveBeenCalledWith(
    expect.objectContaining({ quantity_grams: 33 }),
    expect.anything(),
  );
});

test("Save is disabled until something changes, then PATCHes only changed fields", async () => {
  const { getByText, getByLabelText } = await render(<MealDetail />);
  // clean form: Save disabled -> pressing it does not mutate
  await fireEvent.press(getByText("Save changes"));
  expect(mockEditMutate).not.toHaveBeenCalled();
  // bump grams 200 -> 210 (legacy log: PortionField renders the exact-mode
  // amount field, no named serving to step through) and move to lunch
  await fireEvent.changeText(getByLabelText("Amount"), "210");
  await fireEvent.press(getByText("Lunch"));
  await fireEvent.press(getByText("Save changes"));
  expect(mockEditMutate).toHaveBeenCalledWith(
    { id: "log1", quantity_grams: 210, meal_slot: "lunch" },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

test("Saving a portion/slot change offers Undo that PATCHes back the prior grams and slot, never retract_correction", async () => {
  mockEditMutate.mockImplementationOnce((_patch, opts) => opts.onSuccess());

  const { getByText, getByLabelText } = await render(<MealDetail />);
  await fireEvent.changeText(getByLabelText("Amount"), "210");
  await fireEvent.press(getByText("Lunch"));
  await fireEvent.press(getByText("Save changes"));

  await waitFor(() => expect(mockToastShow).toHaveBeenCalledTimes(1));
  const [toastArgs] = mockToastShow.mock.calls[0];
  expect(toastArgs.actionLabel).toBe("Undo");

  toastArgs.onAction();

  expect(mockEditMutateAsync).toHaveBeenCalledTimes(1);
  const [undoPatch] = mockEditMutateAsync.mock.calls[0];
  // The prior grams (200) and slot ("breakfast") captured before the save,
  // not the just-saved 210/lunch — and this plain portion/slot path must
  // NEVER carry retract_correction: onSave never sets food_item_id, so the
  // server's foodChanged is always false and nothing was ever taught.
  // Sending the flag here would delete an alias a DIFFERENT log may have
  // taught for the same phrase.
  expect(undoPatch).toEqual({ id: "log1", quantity_grams: 200, meal_slot: "breakfast" });
  expect(undoPatch).not.toHaveProperty("retract_correction");
});

test("Delete confirms then calls useDeleteLog", async () => {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => {
    // press the destructive "Delete" button
    const del = (buttons ?? []).find((b) => b.style === "destructive");
    del?.onPress?.();
  });
  const { getByLabelText } = await render(<MealDetail />);
  await fireEvent.press(getByLabelText("Delete entry"));
  expect(mockDeleteMutate).toHaveBeenCalledWith("log1", expect.objectContaining({ onSuccess: expect.any(Function) }));
  alertSpy.mockRestore();
});

test("Repeat calls useRepeatLog, navigates back and confirms", async () => {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  mockRepeatMutate.mockImplementation((_id, opts) => opts.onSuccess?.());
  const { getByLabelText } = await render(<MealDetail />);
  await fireEvent.press(getByLabelText("Repeat entry"));
  expect(mockRepeatMutate).toHaveBeenCalledWith(
    "log1",
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
  expect(mockBack).toHaveBeenCalled();
  expect(alertSpy).toHaveBeenCalled();
  alertSpy.mockRestore();
});

test("Repeat is disabled while a repeat is pending", async () => {
  mockRepeatPending = true;
  const { getByLabelText } = await render(<MealDetail />);
  await fireEvent.press(getByLabelText("Repeat entry"));
  expect(mockRepeatMutate).not.toHaveBeenCalled();
});

test("FIX 2: a fractional server quantity_grams does not falsely arm Save changes", async () => {
  // The diary passes a ROUNDED grams route param (String(Math.round(...))),
  // but the fetched log's real portion is fractional. Before the fix, grams
  // stayed seeded from the rounded route param (143) while baseGrams
  // switched to the server's exact 142.5 the moment the log landed — a
  // rounding artifact alone, not a user edit, made `dirty` true.
  mockLogData = {
    id: "log1",
    food_item_id: "f1",
    logged_at: "2026-07-31T08:00:00Z",
    meal_slot: "breakfast",
    source: "manual",
    description: "Brown rice",
    quantity_grams: 142.5,
    kcal: 300,
    protein_g: 6,
    carbs_g: 64,
    fat_g: 2,
    provenance: "manual",
  };

  const { getByText, getByDisplayValue } = await render(<MealDetail />);

  // grams resynced to the server's exact (fractional) value ...
  await waitFor(() => expect(getByDisplayValue("142.5")).toBeTruthy());

  // ... so nothing is dirty and Save changes does not arm itself.
  await fireEvent.press(getByText("Save changes"));
  expect(mockEditMutate).not.toHaveBeenCalled();
});
