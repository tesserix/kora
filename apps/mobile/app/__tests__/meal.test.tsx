import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import MealDetail from "../meal";
import { instrumentDark, instrumentLight } from "@/theme/palette";

const mockEditMutate = jest.fn();
const mockEditMutateAsync = jest.fn();
const mockDeleteMutate = jest.fn();
const mockDeleteMutateAsync = jest.fn();
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
  portion_assumed?: boolean;
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
  useDeleteLog: () => ({ mutate: mockDeleteMutate, mutateAsync: mockDeleteMutateAsync, isPending: false }),
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
  mockDeleteMutateAsync.mockReset();
  mockDeleteMutateAsync.mockResolvedValue(undefined);
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
// MealDetail. `item` carries the food's own base_unit/serving_units. The
// log-fetch endpoint joins base_unit in from the food row; serving_units it
// does not, and meal.tsx falls back to synthesizing a single serving from
// entered_amount/entered_unit when they're absent (see servingUnitsFor in
// app/meal.tsx).
async function renderMeal(overrides: {
  quantity_grams?: number;
  entered_amount?: number;
  entered_unit?: string;
  source?: string;
  provenance?: string;
  portion_assumed?: boolean;
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
  await fireEvent.press(getByText("Looks right — keep it"));

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

// This is the screen where the user CORRECTS a portion (#138) — the marker
// vanishing on the way in would hide the guess exactly where acting on it
// matters most.
test("shows the guess marker on the portion panel when the fetched log's portion was assumed", async () => {
  const { findByText } = await renderMeal({ portion_assumed: true });
  expect(await findByText("portion is a guess")).toBeTruthy();
});

test("shows no guess marker when the fetched log's portion was not assumed", async () => {
  const { queryByText, findByText } = await renderMeal({ portion_assumed: false });
  // Wait for the log-backed render to settle before asserting an absence.
  await findByText("300"); // kcal hero numeral, unique to the fetched-log render
  expect(queryByText("portion is a guess")).toBeNull();
});

test("Save is disabled until something changes, then PATCHes only changed fields", async () => {
  const { getByText, getByLabelText } = await render(<MealDetail />);
  // clean form: Save disabled -> pressing it does not mutate
  await fireEvent.press(getByText("Looks right — keep it"));
  expect(mockEditMutate).not.toHaveBeenCalled();
  // bump grams 200 -> 210 (legacy log: PortionField renders the exact-mode
  // amount field, no named serving to step through) and move to lunch
  await fireEvent.changeText(getByLabelText("Amount"), "210");
  await fireEvent.press(getByText("Lunch"));
  await fireEvent.press(getByText("Looks right — keep it"));
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
  await fireEvent.press(getByText("Looks right — keep it"));

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

// Duplicating is the easiest of this screen's three actions to trigger by
// accident, so it confirms the way its neighbours do — a toast with an Undo,
// never a modal Alert the user has to dismiss.
test("Repeat calls useRepeatLog, navigates back and confirms with a toast", async () => {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  mockRepeatMutate.mockImplementation((_id, opts) => opts.onSuccess?.({ id: "log2" }));
  const { getByLabelText } = await render(<MealDetail />);
  await fireEvent.press(getByLabelText("Repeat entry"));
  expect(mockRepeatMutate).toHaveBeenCalledWith(
    "log1",
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
  expect(mockBack).toHaveBeenCalled();
  expect(mockToastShow).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Logged again to today", actionLabel: "Undo" }),
  );
  expect(alertSpy).not.toHaveBeenCalled();
  alertSpy.mockRestore();
});

// The repeat POST answers with the log it created, so Undo deletes exactly the
// row this tap made — not the original entry the user was looking at.
test("Repeat's Undo deletes the log the duplicate created, not the original", async () => {
  mockRepeatMutate.mockImplementation((_id, opts) => opts.onSuccess?.({ id: "log2" }));
  const { getByLabelText } = await render(<MealDetail />);
  await fireEvent.press(getByLabelText("Repeat entry"));

  mockToastShow.mock.calls[0][0].onAction();
  expect(mockDeleteMutateAsync).toHaveBeenCalledWith("log2");
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
  await fireEvent.press(getByText("Looks right — keep it"));
  expect(mockEditMutate).not.toHaveBeenCalled();
});

// A legacy millilitre log carries no entered pair, so editing its amount is
// the first time a unit is recorded for it. Nulling the pair because "the
// unit equals the base unit" filed 300 ml as bare grams, and every later read
// called it "300 g".
test("editing a millilitre log sends the entered unit, not bare grams", async () => {
  const { getByLabelText, getByText } = await renderMeal({
    quantity_grams: 250,
    item: { base_unit: "ml" },
  });

  await fireEvent.changeText(getByLabelText("Amount"), "300");
  await fireEvent.press(getByText("Looks right — keep it"));

  expect(mockEditMutate).toHaveBeenCalledWith(
    expect.objectContaining({ entered_amount: 300, entered_unit: "ml" }),
    expect.anything(),
  );
});

// Instrument-glass rebuild (task 12): kcal hero numeral, provenance chip,
// and the three macro rows all render from route-param data alone, before
// the log fetch resolves — same "paint instantly" contract the rest of the
// screen already relies on.
test("renders the kcal hero numeral and macro rows from route params", async () => {
  const { getByText } = await render(<MealDetail />);
  expect(getByText("300")).toBeTruthy();
  expect(getByText("kcal · this meal")).toBeTruthy();
  expect(getByText("6g")).toBeTruthy();
  expect(getByText("64g")).toBeTruthy();
  expect(getByText("2g")).toBeTruthy();
});

// The provenance chip combines the log's source ("Photo") with its
// provenance descriptor ("AI estimate" for anything not in the verified
// source set) into the single "◉ Photo · AI estimate" reading the spec
// calls for, and only shows the accent ◉ marker for an AI-resolved source.
test("provenance chip shows the source and AI-estimate descriptor for an AI-resolved log", async () => {
  const { getByText } = await renderMeal({ source: "ai_photo", provenance: "user_estimate" });
  expect(getByText("Photo · AI estimate")).toBeTruthy();
  expect(getByText("◉")).toBeTruthy();
});

// A verified provenance (the food-database sources ProvenanceChip already
// treats as verified) never carries the AI-estimate disclaimer, and a
// manually-logged entry is never marked with the accent AI dot.
test("provenance chip shows Verified (no accent dot) for a manually-logged, verified-source entry", async () => {
  const { getByText, queryByText } = await renderMeal({ source: "manual", provenance: "afcd" });
  expect(getByText("Manual · Verified")).toBeTruthy();
  expect(queryByText("◉")).toBeNull();
});

test("the Delete action renders in the instrument danger color", async () => {
  const { getByText } = await render(<MealDetail />);
  const node = getByText("Delete");
  const flat = [node.props.style].flat(Infinity).filter(Boolean);
  const color = Object.assign({}, ...flat).color;
  expect([instrumentLight.danger, instrumentDark.danger]).toContain(color);
});
