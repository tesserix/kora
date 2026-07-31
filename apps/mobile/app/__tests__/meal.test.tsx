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

jest.mock("expo-router", () => ({
  router: { back: () => mockBack() },
  useLocalSearchParams: () => ({
    id: "log1", name: "Brown rice", mealSlot: "breakfast", time: "8:00 AM",
    kcal: "300", protein: "6", carbs: "64", fat: "2", grams: "200",
  }),
}));

jest.mock("@/api/hooks", () => ({
  useLog: () => ({ data: undefined, isLoading: false }),
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
});

test("Save is disabled until something changes, then PATCHes only changed fields", async () => {
  const { getByText, getByLabelText } = await render(<MealDetail />);
  // clean form: Save disabled -> pressing it does not mutate
  await fireEvent.press(getByText("Save changes"));
  expect(mockEditMutate).not.toHaveBeenCalled();
  // bump grams 200 -> 210 and move to lunch
  await fireEvent.press(getByLabelText("Increase"));
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
  await fireEvent.press(getByLabelText("Increase"));
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
