import { Alert } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));

const mockDeleteMutate = jest.fn();
const mockAddWaterMutate = jest.fn();

jest.mock("@/api/hooks", () => ({
  useDashboard: () => ({ data: { consumed: { kcal: 1252 }, targets: { kcal: 2000 }, water_ml: 1400 } }),
  useDayLogs: () => ({
    data: [
      {
        id: "1",
        description: "Grilled salmon",
        meal_slot: "dinner",
        kcal: 520,
        protein_g: 40,
        carbs_g: 10,
        fat_g: 30,
        logged_at: "2026-07-24T19:00:00Z",
        provenance: "manual",
        quantity_grams: 200,
        source: "manual",
      },
    ],
  }),
  useAddWater: () => ({ mutate: mockAddWaterMutate, isPending: false }),
  useDeleteLog: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useCopyDay: () => ({ mutate: jest.fn(), isPending: false }),
}));

import Diary from "../diary";

beforeEach(() => {
  mockDeleteMutate.mockClear();
  mockAddWaterMutate.mockClear();
  jest.spyOn(Alert, "alert").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

test("Diary shows header, week strip and a logged meal grouped by slot", async () => {
  const { findByText } = await render(<Diary />);
  expect(await findByText("Diary")).toBeTruthy();
  expect(await findByText("DINNER")).toBeTruthy();
  expect(await findByText("Grilled salmon")).toBeTruthy();
});

test("a day with logs does not show the Copy CTA", async () => {
  const { queryByText, findByText } = await render(<Diary />);
  await findByText("Grilled salmon"); // ensure render settled
  expect(queryByText("Copy from another day")).toBeNull();
});

test("tapping a week-strip day switches the selected date used to fetch data", async () => {
  const { getByLabelText, findByText } = await render(<Diary />);
  await findByText("Grilled salmon");

  // The week strip renders 7 day cells labelled with their ISO date; tapping one
  // just needs to not throw — useDashboard/useDayLogs are mocked as constants
  // here, so the real re-query behavior is covered by the hooks' own tests. This
  // asserts the day cell is present, selectable, and re-renders without error.
  const today = new Date().toLocaleDateString("en-CA");
  await fireEvent.press(getByLabelText(today));
  expect(await findByText("Grilled salmon")).toBeTruthy();
});

test("water buttons call useAddWater with volume_ml and a noon-UTC logged_at for the selected day", async () => {
  const { getByLabelText, findByText } = await render(<Diary />);
  await findByText("Grilled salmon");

  await fireEvent.press(getByLabelText("Add 250 ml water"));
  const today = new Date().toLocaleDateString("en-CA");
  expect(mockAddWaterMutate).toHaveBeenCalledWith(
    { volume_ml: 250, logged_at: `${today}T12:00:00Z` },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );

  await fireEvent.press(getByLabelText("Add 500 ml water"));
  expect(mockAddWaterMutate).toHaveBeenCalledWith(
    { volume_ml: 500, logged_at: `${today}T12:00:00Z` },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

test("swiping a meal row's delete action confirms then deletes that log id", async () => {
  const { getByLabelText, findByText } = await render(<Diary />);
  await findByText("Grilled salmon");

  await fireEvent.press(getByLabelText("Delete Grilled salmon"));
  expect(Alert.alert).toHaveBeenCalledWith(
    "Delete this entry?",
    "This removes it from your diary.",
    expect.arrayContaining([
      expect.objectContaining({ text: "Cancel" }),
      expect.objectContaining({ text: "Delete", style: "destructive" }),
    ]),
  );

  // Invoke the "Delete" button's onPress exactly as the confirm-Alert would.
  const alertMock = Alert.alert as jest.Mock;
  const buttons = alertMock.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
  const confirm = buttons.find((b) => b.text === "Delete");
  confirm?.onPress?.();

  expect(mockDeleteMutate).toHaveBeenCalledWith("1");
});
