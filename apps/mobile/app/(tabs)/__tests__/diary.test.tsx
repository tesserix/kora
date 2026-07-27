import { Alert } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));

const mockDeleteMutate = jest.fn();
const mockAddWaterMutate = jest.fn();
const mockUseDashboard = jest.fn();
const mockUseDayLogs = jest.fn();

const DASHBOARD_DATA = { consumed: { kcal: 1252 }, targets: { kcal: 2000 }, water_ml: 1400 };
const LOGS_DATA = [
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
];

jest.mock("@/api/hooks", () => ({
  useDashboard: (date: string) => {
    mockUseDashboard(date);
    return { data: DASHBOARD_DATA };
  },
  useDayLogs: (date: string) => {
    mockUseDayLogs(date);
    return { data: LOGS_DATA };
  },
  useAddWater: () => ({ mutate: mockAddWaterMutate, isPending: false }),
  useDeleteLog: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useCopyDay: () => ({ mutate: jest.fn(), isPending: false }),
}));

const mockUseUnits = jest.fn(() => ({ system: "metric", setSystem: jest.fn() }));
jest.mock("@/units", () => ({
  ...jest.requireActual("@/units"),
  useUnits: () => mockUseUnits(),
}));

import Diary from "../diary";

beforeEach(() => {
  mockDeleteMutate.mockClear();
  mockAddWaterMutate.mockClear();
  mockUseDashboard.mockClear();
  mockUseDayLogs.mockClear();
  mockUseUnits.mockReturnValue({ system: "metric", setSystem: jest.fn() });
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

// Mirrors diary.tsx's own weekDates()/iso() so the target day-cell label and
// expected ISO argument are computed identically to production, regardless of
// which day of the week the suite happens to run on.
const isoOf = (d: Date) => d.toLocaleDateString("en-CA");

function mondayOfThisWeek(): Date {
  const now = new Date();
  const day = (now.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() - day);
  return monday;
}

test("tapping a different week-strip day switches the selected date used to fetch data", async () => {
  const { getByLabelText, findByText } = await render(<Diary />);
  await findByText("Grilled salmon");

  const todayIso = isoOf(new Date());
  mockUseDashboard.mockClear();
  mockUseDayLogs.mockClear();

  // Pick a day in the current (Monday-start) week strip that is NOT today —
  // Monday itself, unless today already is Monday, in which case Tuesday.
  const monday = mondayOfThisWeek();
  const target = isoOf(monday) === todayIso ? new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 1) : monday;
  const targetIso = isoOf(target);
  expect(targetIso).not.toBe(todayIso);

  await fireEvent.press(getByLabelText(targetIso));

  expect(mockUseDashboard).toHaveBeenCalledWith(targetIso);
  expect(mockUseDayLogs).toHaveBeenCalledWith(targetIso);
  expect(mockUseDashboard).not.toHaveBeenCalledWith(todayIso);
  expect(mockUseDayLogs).not.toHaveBeenCalledWith(todayIso);
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

test("imperial water quick-adds show fl oz and still add metric ml (8 fl oz -> 237 ml)", async () => {
  mockUseUnits.mockReturnValue({ system: "imperial", setSystem: jest.fn() });
  const { getByLabelText, findByText } = await render(<Diary />);
  await findByText("Grilled salmon");

  await fireEvent.press(getByLabelText("Add 8 fl oz water"));
  const today = new Date().toLocaleDateString("en-CA");
  expect(mockAddWaterMutate).toHaveBeenCalledWith(
    { volume_ml: 237, logged_at: `${today}T12:00:00Z` },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );

  await fireEvent.press(getByLabelText("Add 16 fl oz water"));
  expect(mockAddWaterMutate).toHaveBeenCalledWith(
    { volume_ml: 473, logged_at: `${today}T12:00:00Z` },
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
