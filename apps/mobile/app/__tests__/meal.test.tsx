import { render, fireEvent } from "@testing-library/react-native";
import { Alert } from "react-native";
import MealDetail from "../meal";

const mockEditMutate = jest.fn();
const mockDeleteMutate = jest.fn();
const mockRepeatMutate = jest.fn();
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
  useEditLog: () => ({ mutate: mockEditMutate, isPending: false }),
  useDeleteLog: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useRepeatLog: () => ({ mutate: mockRepeatMutate, isPending: mockRepeatPending }),
}));

beforeEach(() => { mockEditMutate.mockClear(); mockDeleteMutate.mockClear(); mockRepeatMutate.mockClear(); mockBack.mockClear(); mockRepeatPending = false; });

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
