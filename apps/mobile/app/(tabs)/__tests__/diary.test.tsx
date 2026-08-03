import { Alert } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import type { QueuedRow } from "@/offline/useQueuedLogs";

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

// Mutable holders so a test can supply an empty day or a different dashboard;
// both reset in beforeEach.
let mockDayLogs: typeof LOGS_DATA = LOGS_DATA;
let mockDashboardData: typeof DASHBOARD_DATA = DASHBOARD_DATA;

// The queued-row hook is exercised directly in
// src/offline/__tests__/useQueuedLogs.test.tsx; here it is a fixture so these
// tests are about what the diary renders from it.
let mockQueuedRows: QueuedRow[] = [];
const mockRetryRow = jest.fn(async () => {});
const mockDiscardRow = jest.fn(async () => {});
// Records the date exactly as the useDayLogs mock above does — the queued rows
// are day-scoped too, and a hook asked for the wrong day would otherwise show
// today's offline meals on every date the user browses.
const mockUseQueuedLogs = jest.fn();
jest.mock("@/offline/useQueuedLogs", () => ({
  useQueuedLogs: (date: string) => {
    mockUseQueuedLogs(date);
    return { rows: mockQueuedRows, retryRow: mockRetryRow, discardRow: mockDiscardRow };
  },
}));

jest.mock("@/api/hooks", () => ({
  useDashboard: (date: string) => {
    mockUseDashboard(date);
    return { data: mockDashboardData };
  },
  useDayLogs: (date: string) => {
    mockUseDayLogs(date);
    return { data: mockDayLogs };
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
  mockDayLogs = LOGS_DATA;
  mockDashboardData = DASHBOARD_DATA;
  mockQueuedRows = [];
  mockRetryRow.mockClear();
  mockDiscardRow.mockClear();
  mockDeleteMutate.mockClear();
  mockAddWaterMutate.mockClear();
  mockUseDashboard.mockClear();
  mockUseDayLogs.mockClear();
  mockUseQueuedLogs.mockClear();
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

test("a day with zero food logs shows the empty-day EmptyState", async () => {
  mockDayLogs = [];
  const { findByText } = await render(<Diary />);
  expect(await findByText("Nothing logged")).toBeTruthy();
  expect(await findByText("Meals you log on this day appear here.")).toBeTruthy();
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
  mockUseQueuedLogs.mockClear();

  // Pick a day in the current (Monday-start) week strip that is NOT today —
  // Monday itself, unless today already is Monday, in which case Tuesday.
  const monday = mondayOfThisWeek();
  const target = isoOf(monday) === todayIso ? new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 1) : monday;
  const targetIso = isoOf(target);
  expect(targetIso).not.toBe(todayIso);

  await fireEvent.press(getByLabelText(targetIso));

  expect(mockUseDashboard).toHaveBeenCalledWith(targetIso);
  expect(mockUseDayLogs).toHaveBeenCalledWith(targetIso);
  expect(mockUseQueuedLogs).toHaveBeenCalledWith(targetIso);
  expect(mockUseDashboard).not.toHaveBeenCalledWith(todayIso);
  expect(mockUseDayLogs).not.toHaveBeenCalledWith(todayIso);
  expect(mockUseQueuedLogs).not.toHaveBeenCalledWith(todayIso);
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

// --- Queued (offline) rows -------------------------------------------------

const queuedRow = (over: Partial<QueuedRow> = {}): QueuedRow => ({
  id: "q1",
  description: "Greek yogurt",
  kcal: 93,
  mealSlot: "lunch",
  status: "pending",
  ...over,
});

// The only server log in this fixture is dinner, so LUNCH exists purely
// because of the queued row: a diary that derived its slots from server logs
// alone would render nothing at all here.
test("a pending queued row appears in its own slot with a Pending badge", async () => {
  mockQueuedRows = [queuedRow()];
  const { findByText, getByText } = await render(<Diary />);

  expect(await findByText("LUNCH")).toBeTruthy();
  getByText("Greek yogurt");
  getByText("Pending");
  getByText("Waiting to sync");
});

test("a failed queued row is labelled as failed and offers retry and discard", async () => {
  mockQueuedRows = [queuedRow({ status: "failed", description: "Cold brew" })];
  const { findByText, getByText, getByLabelText, queryByText } = await render(<Diary />);

  expect(await findByText("Failed")).toBeTruthy();
  getByText("Couldn't sync");
  expect(queryByText("Retry")).toBeNull();

  await fireEvent.press(getByLabelText("Cold brew, failed to sync"));
  await fireEvent.press(getByText("Retry"));
  expect(mockRetryRow).toHaveBeenCalledWith("q1");
  expect(mockDiscardRow).not.toHaveBeenCalled();
});

test("discarding a failed queued row calls discardRow", async () => {
  mockQueuedRows = [queuedRow({ status: "failed", description: "Cold brew" })];
  const { getByText, getByLabelText, findByText } = await render(<Diary />);
  await findByText("Failed");

  await fireEvent.press(getByLabelText("Cold brew, failed to sync"));
  await fireEvent.press(getByText("Discard"));
  expect(mockDiscardRow).toHaveBeenCalledWith("q1");
  expect(mockRetryRow).not.toHaveBeenCalled();
});

// A pending item is a real food with known nutrition whose upload is merely
// outstanding, so leaving it out makes remaining-calories wrong exactly when
// the user is relying on it. A failed item is never landing, so counting it
// would overstate the day indefinitely.
test("pending kcal counts toward the day total and failed kcal does not", async () => {
  mockDashboardData = { consumed: { kcal: 500 }, targets: { kcal: 2000 }, water_ml: 0 };
  mockQueuedRows = [
    queuedRow({ id: "pending-1", kcal: 93 }),
    queuedRow({ id: "failed-1", kcal: 400, status: "failed", description: "Cold brew" }),
  ];
  const { findByText, queryByText } = await render(<Diary />);

  // 500 eaten + 93 pending.
  expect(await findByText("593")).toBeTruthy();
  // Counting the failed row too would read 993.
  expect(queryByText("993")).toBeNull();
  // Counting neither would read 500 — the server figure, unchanged.
  expect(queryByText("500")).toBeNull();
});

// The client mints ONE id and uses it as both the queue item id and the server
// row id (useCreateLog mints it, queue.ts stores it as item.id, drainLogs
// replays it), so a meal the server has already applied appears under the same
// id in both lists. Two ordinary paths leave the queue holding such an item:
// a POST that died after the server wrote the row, and a drain whose response
// was lost. Until the next drain replays the id idempotently and clears the
// queue, the meal is in both lists — and showing it twice is the one thing
// this whole feature must never do.
const drainedMeal = {
  ...LOGS_DATA[0],
  id: "dup",
  description: "Greek yogurt",
  meal_slot: "lunch",
  kcal: 93,
};

test("a queued row the server already has is rendered once, not twice", async () => {
  mockDayLogs = [drainedMeal];
  mockQueuedRows = [queuedRow({ id: "dup", description: "Greek yogurt", kcal: 93 })];

  const { findByText, getAllByText, queryByText } = await render(<Diary />);
  await findByText("LUNCH");

  expect(getAllByText("Greek yogurt")).toHaveLength(1);
  // And the survivor is the SERVER row, not the queued copy.
  expect(queryByText("Pending")).toBeNull();
  expect(queryByText("Waiting to sync")).toBeNull();
});

test("a queued row the server already has is counted once in the day total", async () => {
  // The dashboard figure is the server's, so it already contains the 93.
  mockDashboardData = { consumed: { kcal: 500 }, targets: { kcal: 2000 }, water_ml: 0 };
  mockDayLogs = [drainedMeal];
  mockQueuedRows = [
    queuedRow({ id: "dup", description: "Greek yogurt", kcal: 93 }),
    queuedRow({ id: "not-yet", description: "Cold brew", kcal: 40 }),
  ];

  const { findByText, queryByText } = await render(<Diary />);

  // 500 already includes the drained meal; only the genuinely unsent 40 is added.
  expect(await findByText("540")).toBeTruthy();
  // Counting the drained meal a second time would read 633.
  expect(queryByText("633")).toBeNull();
  // Dropping every queued row would read 500 — the row that has NOT landed
  // still has to count.
  expect(queryByText("500")).toBeNull();
});

// A queued row whose food was evicted from the offline cache has no honest
// calorie figure, so it must not contribute a made-up one to the day.
test("a queued row with an unknown kcal shows a dash and leaves the total alone", async () => {
  mockDashboardData = { consumed: { kcal: 500 }, targets: { kcal: 2000 }, water_ml: 0 };
  mockQueuedRows = [queuedRow({ kcal: null, description: "Queued item" })];
  const { findByText, getByText } = await render(<Diary />);

  expect(await findByText("— kcal")).toBeTruthy();
  getByText("500");
});
