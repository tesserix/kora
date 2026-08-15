import { Alert } from "react-native";
import { fireEvent, render, within } from "@testing-library/react-native";
import { router } from "expo-router";
import type { QueuedRow } from "@/offline/useQueuedLogs";
import { instrumentLight } from "@/theme/palette";

import Diary from "../diary";

// useFocusEffect: ScreenEntrance (Task 9) now wraps Diary's root content and
// calls the real expo-router hook, which needs a navigation container this
// isolated render doesn't mount — same reasoning as index.test.tsx's mock.
jest.mock("expo-router", () => ({ router: { push: jest.fn() }, useFocusEffect: () => {} }));

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
let mockDayLogs: (typeof LOGS_DATA[number] & { portion_assumed?: boolean })[] = LOGS_DATA;
let mockDashboardData: typeof DASHBOARD_DATA | undefined = DASHBOARD_DATA;

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

// Not under test here (see useQueuedCaptures.test.tsx); stubbed with no rows
// so importing diary.tsx does not pull in @/lib/api's firebase/auth ESM.
jest.mock("@/offline/useQueuedCaptures", () => ({
  useQueuedCaptures: () => ({ rows: [] }),
}));

jest.mock("@/api/hooks", () => ({
  useDashboard: (date: string) => {
    mockUseDashboard(date);
    return { data: mockDashboardData, isError: false };
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

const mockOpenCompose = jest.fn();
jest.mock("@/components/meals/SavedMealSheetProvider", () => ({
  useSavedMealEditor: () => ({ openCreate: jest.fn(), openEdit: jest.fn(), openBlank: jest.fn(), openCompose: mockOpenCompose }),
}));

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
  mockOpenCompose.mockClear();
  // Created inside the jest.mock factory above, so neither jest.clearAllMocks
  // in a config nor restoreAllMocks below resets it — a "does not navigate"
  // assertion would otherwise be satisfied by an earlier test's push.
  (router.push as jest.Mock).mockClear();
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
  expect(await findByText("· 520 KCAL")).toBeTruthy();
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
  const buttons = alertMock.mock.calls[0][2] as { text: string; onPress?: () => void }[];
  const confirm = buttons.find((b) => b.text === "Delete");
  confirm?.onPress?.();

  // The second argument is the per-call onError that surfaces a failed delete
  // (see diary.tsx). Asserted as present rather than ignored: without it the
  // row silently stays in the diary.
  expect(mockDeleteMutate).toHaveBeenCalledWith(
    "1",
    expect.objectContaining({ onError: expect.any(Function) }),
  );
});

// A logged, server-confirmed row whose portion the system guessed (#138)
// must show the marker both visually and in its accessible name, and a
// plain row must show neither.
test("a logged row with an assumed portion shows the guess marker in both the visual and accessible name", async () => {
  mockDayLogs = [{ ...LOGS_DATA[0], portion_assumed: true }];
  const { findByText, findByLabelText, queryByLabelText } = await render(<Diary />);

  expect(await findByText("portion is a guess")).toBeTruthy();
  expect(await findByLabelText("Grilled salmon, portion is a guess")).toBeTruthy();
  expect(queryByLabelText("Grilled salmon")).toBeNull();
});

test("a logged row with no assumed portion shows no guess marker", async () => {
  mockDayLogs = [{ ...LOGS_DATA[0], portion_assumed: false }];
  const { findByText, queryByText, findByLabelText } = await render(<Diary />);

  await findByText("Grilled salmon");
  expect(queryByText("portion is a guess")).toBeNull();
  expect(await findByLabelText("Grilled salmon")).toBeTruthy();
});

// --- Queued (offline) rows -------------------------------------------------

const queuedRow = (over: Partial<QueuedRow> = {}): QueuedRow => ({
  id: "q1",
  description: "Greek yogurt",
  kcal: 93,
  mealSlot: "lunch",
  status: "pending",
  portionAssumed: false,
  ...over,
});

// The only server log in this fixture is dinner, so LUNCH exists purely
// because of the queued row: a diary that derived its slots from server logs
// alone would render nothing at all here.
test("a pending queued row appears in its own slot with a Pending badge", async () => {
  mockQueuedRows = [queuedRow()];
  const { findByText, getByText } = await render(<Diary />);

  expect(await findByText("LUNCH")).toBeTruthy();
  expect(await findByText("· 93 KCAL")).toBeTruthy();
  getByText("Greek yogurt");
  getByText("Pending");
  getByText("Waiting to sync");
});

// Queued rows are real, durable logs merely pending sync, and their kcal
// already counts into the day total — so a guessed portion must read as a
// guess here too, not just once a real server row lands (#138).
test("a queued row with an assumed portion shows the guess marker in both the visual and accessible name", async () => {
  mockQueuedRows = [queuedRow({ portionAssumed: true })];
  const { findByText, findByLabelText, queryByLabelText } = await render(<Diary />);

  expect(await findByText("portion is a guess")).toBeTruthy();
  expect(await findByLabelText("Greek yogurt, portion is a guess, waiting to sync")).toBeTruthy();
  expect(queryByLabelText("Greek yogurt, waiting to sync")).toBeNull();
});

test("a queued row with no assumed portion shows no guess marker", async () => {
  mockQueuedRows = [queuedRow({ portionAssumed: false })];
  const { findByText, queryByText } = await render(<Diary />);

  await findByText("Greek yogurt");
  expect(queryByText("portion is a guess")).toBeNull();
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
  await findByText("· 93 KCAL");

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

// --- Multi-select compose ---------------------------------------------------

// Two rows in the same slot so a selection can span more than one entry.
// f1 carries an entered pair ("1 portion"); f2 has none, so formatPortion
// falls back to its base unit — the composed items must carry each row's
// own entered_amount/entered_unit verbatim, not a converted or derived one.
const SELECTABLE_LOGS = [
  {
    id: "1",
    food_item_id: "f1",
    description: "NESCAFÉ Mocha",
    meal_slot: "breakfast",
    kcal: 120,
    protein_g: 2,
    carbs_g: 20,
    fat_g: 3,
    logged_at: "2026-07-24T08:00:00Z",
    provenance: "manual",
    quantity_grams: 30,
    entered_amount: 1,
    entered_unit: "portion",
    base_unit: null,
    source: "manual",
  },
  {
    id: "2",
    food_item_id: "f2",
    description: "Milk",
    meal_slot: "breakfast",
    kcal: 60,
    protein_g: 3,
    carbs_g: 5,
    fat_g: 2,
    logged_at: "2026-07-24T08:05:00Z",
    provenance: "manual",
    quantity_grams: 200,
    entered_amount: null,
    entered_unit: null,
    base_unit: "ml",
    source: "manual",
  },
];

test("long-pressing a diary row enters selection mode", async () => {
  mockDayLogs = SELECTABLE_LOGS;
  const { getByLabelText, getByText } = await render(<Diary />);

  await fireEvent(getByLabelText("NESCAFÉ Mocha"), "longPress");

  expect(getByText("1 selected")).toBeTruthy();
});

// Without this the only feedback in selection mode is the "N selected"
// counter: a mis-tap and the tap undoing it both look identical on the row.
test("a selected row is announced as selected and an unselected one is not", async () => {
  mockDayLogs = SELECTABLE_LOGS;
  const { getByLabelText } = await render(<Diary />);

  await fireEvent(getByLabelText("NESCAFÉ Mocha"), "longPress");

  expect(getByLabelText("NESCAFÉ Mocha").props.accessibilityState.selected).toBe(true);
  expect(getByLabelText("Milk").props.accessibilityState.selected).toBe(false);
});

test("a plain tap toggles selection while selecting, and composes only the chosen rows", async () => {
  mockDayLogs = SELECTABLE_LOGS;
  const { getByLabelText, getByText } = await render(<Diary />);

  await fireEvent(getByLabelText("NESCAFÉ Mocha"), "longPress");
  await fireEvent.press(getByLabelText("Milk"));
  await fireEvent.press(getByText("Save as meal"));

  // Entered units travel with the rows so the sheet opens on "1 portion".
  expect(mockOpenCompose).toHaveBeenCalledWith([
    expect.objectContaining({ food_item_id: "f1", entered_unit: "portion", entered_amount: 1 }),
    expect.objectContaining({ food_item_id: "f2", entered_unit: null }),
  ]);
});

test("saving a selection clears it and does not navigate or delete the original rows", async () => {
  mockDayLogs = SELECTABLE_LOGS;
  const { getByLabelText, getByText, queryByText } = await render(<Diary />);

  await fireEvent(getByLabelText("NESCAFÉ Mocha"), "longPress");
  await fireEvent.press(getByText("Save as meal"));

  expect(queryByText("1 selected")).toBeNull();
  expect((router.push as jest.Mock)).not.toHaveBeenCalled();
  expect(mockDeleteMutate).not.toHaveBeenCalled();
});

// Selection is scoped to the day it was made on, and only that day's rows are
// loaded — a selection that survived the switch would claim "1 selected" with
// nothing selected on screen, and compose zero rows into a blank sheet.
test("switching to another day clears the selection", async () => {
  mockDayLogs = SELECTABLE_LOGS;
  const { getByLabelText, getByText, queryByText } = await render(<Diary />);

  await fireEvent(getByLabelText("NESCAFÉ Mocha"), "longPress");
  expect(getByText("1 selected")).toBeTruthy();

  const todayIso = isoOf(new Date());
  const monday = mondayOfThisWeek();
  const target = isoOf(monday) === todayIso ? new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 1) : monday;
  await fireEvent.press(getByLabelText(isoOf(target)));

  expect(queryByText("1 selected")).toBeNull();
});

test("cancelling selection leaves the diary untouched", async () => {
  mockDayLogs = SELECTABLE_LOGS;
  const { getByLabelText, getByText, queryByText } = await render(<Diary />);

  await fireEvent(getByLabelText("NESCAFÉ Mocha"), "longPress");
  await fireEvent.press(getByText("Cancel"));

  expect(queryByText("1 selected")).toBeNull();
  expect(mockDeleteMutate).not.toHaveBeenCalled();
  expect(mockOpenCompose).not.toHaveBeenCalled();
});

test("a plain tap when not selecting still navigates to the meal screen as before", async () => {
  mockDayLogs = SELECTABLE_LOGS;
  const { getByLabelText, findByText } = await render(<Diary />);
  await findByText("NESCAFÉ Mocha");

  await fireEvent.press(getByLabelText("NESCAFÉ Mocha"));

  expect(router.push).toHaveBeenCalledWith(
    expect.objectContaining({ pathname: "/meal", params: expect.objectContaining({ id: "1" }) }),
  );
});

// --- Instrument Glass rebuild ------------------------------------------------

const flatten = (style: unknown) =>
  Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : (style ?? {});

// Finding 2 (Dynamic Type cap pass): the day-total cluster's engraved "Day
// total" caption and its "Water" label need an explicit cap — the cap IS the
// overflow protection at accessibility text sizes for this fixed-size
// instrument cluster.
test("caps the day-total and water captions at 1.4x", async () => {
  const { getByText } = await render(<Diary />);

  expect(getByText("Day total").props.maxFontSizeMultiplier).toBe(1.4);
  expect(getByText("Water").props.maxFontSizeMultiplier).toBe(1.4);
});

test("the selected week-strip day gets the glass-cell look and others do not", async () => {
  const { getByTestId } = await render(<Diary />);

  const todayIso = isoOf(new Date());
  const selectedStyle = flatten(getByTestId(`week-cell-${todayIso}`).props.style);
  expect(selectedStyle.borderWidth).toBeGreaterThan(0);

  const monday = mondayOfThisWeek();
  const other = isoOf(monday) === todayIso ? new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 1) : monday;
  const otherStyle = flatten(getByTestId(`week-cell-${isoOf(other)}`).props.style);
  expect(otherStyle.borderWidth ?? 0).toBe(0);
});

// Goal pips are demoted to lit-ink (spec 2026-08-16 "Diary recomposition" —
// accent budget): the day-total track is Diary's ONE accent, so a met goal
// lights the pip in tickLit, never the accent orange.
test("a week-strip day that hit its kcal goal shows a tickLit (non-accent) pip", async () => {
  mockDashboardData = { consumed: { kcal: 2000 }, targets: { kcal: 2000 }, water_ml: 0 };
  const { getByTestId } = await render(<Diary />);

  const todayIso = isoOf(new Date());
  const pipStyle = flatten(getByTestId(`week-pip-${todayIso}`).props.style);
  expect(pipStyle.backgroundColor).toBe(instrumentLight.tickLit);
  expect(pipStyle.backgroundColor).not.toBe(instrumentLight.accent);
});

test("a week-strip day under its kcal goal shows a dim tick pip", async () => {
  const { getByTestId } = await render(<Diary />);

  const todayIso = isoOf(new Date());
  const pipStyle = flatten(getByTestId(`week-pip-${todayIso}`).props.style);
  expect(pipStyle.backgroundColor).toBe(instrumentLight.tick);
  expect(pipStyle.backgroundColor).not.toBe(instrumentLight.accent);
});

test("the day-total row shows mono eaten / target", async () => {
  const { findByText } = await render(<Diary />);
  expect(await findByText("1252")).toBeTruthy();
  expect(await findByText(" / 2,000 kcal")).toBeTruthy();
});

test("while the dashboard fetch is pending, the day total shows a dash, not a fabricated 0 / 0", async () => {
  mockDashboardData = undefined;
  const { findByTestId, queryByText } = await render(<Diary />);
  const panel = await findByTestId("day-total");
  expect(within(panel).getAllByText("—").length).toBeGreaterThan(0);
  expect(queryByText(" / 0 kcal")).toBeNull();
});

// Only dinner is logged in the base fixture, so breakfast is the first empty
// slot in canonical order — the ghost row should offer to add it, with the
// day's real remaining-kcal figure (2000 target - 1252 eaten = 748).
test("a ghost row offers to add the first empty slot, with the reserve figure, and routes to capture", async () => {
  const { findByText } = await render(<Diary />);

  const ghost = await findByText("Add breakfast · 748 kcal in reserve");
  await fireEvent.press(ghost);

  expect(router.push).toHaveBeenCalledWith("/capture");
});

test("no ghost row appears while the dashboard fetch is pending", async () => {
  mockDashboardData = undefined;
  const { queryByText, findByText } = await render(<Diary />);
  await findByText("Grilled salmon");
  expect(queryByText(/Add .* kcal in reserve/)).toBeNull();
});
