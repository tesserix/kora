// The ~40 lines diary.tsx grew for queued CAPTURE rows had no coverage at all:
// all three existing diary suites stub useQueuedCaptures to `{ rows: [] }`, so
// the slot filter, the row's press handler, and the empty-state condition were
// never executed. This suite supplies real rows and exercises exactly those
// three.
import { Alert } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";
import type { QueuedCaptureRow } from "@/offline/useQueuedCaptures";

import Diary from "../diary";

// useFocusEffect: ScreenEntrance (Task 9) wraps Diary's root content and
// calls the real expo-router hook, which needs a navigation container this
// isolated render doesn't mount.
jest.mock("expo-router", () => ({ router: { push: jest.fn() }, useFocusEffect: () => {} }));

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

let mockDayLogs: typeof LOGS_DATA = LOGS_DATA;
let mockCaptureRows: QueuedCaptureRow[] = [];
// The pending-capture copy branches on connectivity, so every test declares
// which side of that branch it is exercising. Stubbed like the hooks above
// rather than driven through the real onlineManager, so the state cannot leak
// between suites.
let mockOnline = false;

jest.mock("@/offline/useQueuedLogs", () => ({
  useQueuedLogs: () => ({ rows: [], retryRow: jest.fn(), discardRow: jest.fn() }),
}));

// The hook itself is covered by src/offline/__tests__/useQueuedCaptures.test.tsx;
// here it is a fixture, so these tests are about what the diary RENDERS from it.
// Stubbed (rather than run for real) for the same reason the sibling suites do
// it: the real hook reaches @/lib/api's firebase/auth ESM.
jest.mock("@/offline/useQueuedCaptures", () => ({
  useQueuedCaptures: () => ({ rows: mockCaptureRows }),
}));

jest.mock("@/offline/connectivity", () => ({
  useIsOnline: () => mockOnline,
}));

jest.mock("@/api/hooks", () => ({
  useDashboard: () => ({ data: { consumed: { kcal: 1252 }, targets: { kcal: 2000 }, water_ml: 1400 } }),
  useDayLogs: () => ({ data: mockDayLogs }),
  useAddWater: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteLog: () => ({ mutate: jest.fn(), isPending: false }),
  useCopyDay: () => ({ mutate: jest.fn(), isPending: false }),
}));

// A UTC instant that lands at midday on the given LOCAL calendar day, so the
// fixture means the same day in every timezone the suite might run in.
const atLocalNoon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();

function captureRow(over: Partial<QueuedCaptureRow> = {}): QueuedCaptureRow {
  return {
    id: "cap_1754476800000_a1b2c3",
    kind: "photo",
    thumbnailUri: "file:///document/captures/c1.jpg",
    phrase: null,
    code: null,
    capturedAt: atLocalNoon(2026, 8, 6),
    mealSlot: "lunch",
    status: "pending",
    kcal: null,
    ...over,
  };
}

beforeEach(() => {
  mockDayLogs = LOGS_DATA;
  mockCaptureRows = [];
  mockOnline = false;
  (router.push as jest.Mock).mockClear();
  jest.spyOn(Alert, "alert").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// diary.tsx:311 — `captures.rows.filter((r) => r.mealSlot.toLowerCase() === slot)`.
// Deleting that filter renders the SAME capture inside every slot section on
// screen, so the meal appears two or three times. Seeding a log in a DIFFERENT
// slot is what makes a second section exist for it to leak into; asserting
// "exactly one" is what catches the leak.
test("a queued capture renders only in its own meal slot", async () => {
  mockCaptureRows = [captureRow({ mealSlot: "lunch" })];
  const { findByText, getAllByLabelText } = await render(<Diary />);

  // Both sections exist: LUNCH because of the capture alone (captures never
  // contribute to the subtotal, so it reads 0), DINNER from the log.
  expect(await findByText("LUNCH")).toBeTruthy();
  expect(await findByText("· 0 KCAL")).toBeTruthy();
  expect(await findByText("DINNER")).toBeTruthy();
  expect(await findByText("· 520 KCAL")).toBeTruthy();
  expect(getAllByLabelText("Photo, Identifying when you're back online")).toHaveLength(1);
});

// A slot can be present because of a queued capture ALONE — the day's only
// lunch, taken offline, must still produce a LUNCH section.
test("a capture in a slot with no logs still creates that slot's section", async () => {
  mockDayLogs = [];
  mockCaptureRows = [captureRow({ mealSlot: "breakfast", kind: "voice", thumbnailUri: null })];
  const { findByText } = await render(<Diary />);

  expect(await findByText("BREAKFAST")).toBeTruthy();
  expect(await findByText("· 0 KCAL")).toBeTruthy();
  expect(await findByText("Voice note")).toBeTruthy();
});

// diary.tsx:405 — the `review` branch of the press handler. This is the only
// route to the confirmation screen for a capture the AI resolved in the
// background, so a row that does not navigate strands the meal.
test("pressing a review capture opens the capture-review screen for that id", async () => {
  mockCaptureRows = [captureRow({ status: "review" })];
  const { findByLabelText } = await render(<Diary />);

  fireEvent.press(await findByLabelText("Photo, Tap to confirm"));

  expect(router.push).toHaveBeenCalledWith({
    pathname: "/capture-review",
    params: { id: "cap_1754476800000_a1b2c3" },
  });
});

// Failed rows go to the same screen (task 8 rerouted them there from the
// retry/discard sheet), so the media is never discarded without the user
// seeing it.
test("pressing a failed capture also opens the capture-review screen", async () => {
  mockCaptureRows = [captureRow({ status: "failed" })];
  const { findByLabelText } = await render(<Diary />);

  fireEvent.press(await findByLabelText("Photo, Couldn't identify"));

  expect(router.push).toHaveBeenCalledWith({
    pathname: "/capture-review",
    params: { id: "cap_1754476800000_a1b2c3" },
  });
});

// A PENDING capture has nothing to confirm yet, so it deliberately has no
// press handler. Asserting the negative here is what stops the handler being
// widened to every status.
test("pressing a pending capture navigates nowhere", async () => {
  mockCaptureRows = [captureRow({ status: "pending" })];
  const { findByLabelText } = await render(<Diary />);

  fireEvent.press(await findByLabelText("Photo, Identifying when you're back online"));

  expect(router.push).not.toHaveBeenCalled();
});

// Online, a pending capture is not waiting for anything: the resolve is
// running right now, so promising a future action ("when you're back online")
// is a lie the user can see through while the spinner turns.
test("a pending capture reads as actively identifying when the device is online", async () => {
  mockOnline = true;
  mockCaptureRows = [captureRow({ status: "pending" })];
  const { findByLabelText, queryByLabelText } = await render(<Diary />);

  expect(await findByLabelText("Photo, Identifying…")).toBeTruthy();
  expect(queryByLabelText("Photo, Identifying when you're back online")).toBeNull();
});

// The online copy must not swallow the press-handler rule: pending is still
// pending, whatever the connection says.
test("pressing a pending capture navigates nowhere while online either", async () => {
  mockOnline = true;
  mockCaptureRows = [captureRow({ status: "pending" })];
  const { findByLabelText } = await render(<Diary />);

  fireEvent.press(await findByLabelText("Photo, Identifying…"));

  expect(router.push).not.toHaveBeenCalled();
});

// Only PENDING rows branch on connectivity — a review row says the same thing
// online as off, so the branch cannot be widened to the other statuses.
test("a review capture keeps its own copy while online", async () => {
  mockOnline = true;
  mockCaptureRows = [captureRow({ status: "review" })];
  const { findByLabelText } = await render(<Diary />);

  expect(await findByLabelText("Photo, Tap to confirm")).toBeTruthy();
});

// diary.tsx:465 — the `&& captures.rows.length === 0` term of the empty-state
// condition. Without it the day shows "Nothing logged" and a "copy from
// another day" CTA while a queued capture is sitting right above it.
test("a day whose only entry is a queued capture is not shown as empty", async () => {
  mockDayLogs = [];
  mockCaptureRows = [captureRow()];
  const { findByLabelText, queryByText } = await render(<Diary />);

  await findByLabelText("Photo, Identifying when you're back online");
  expect(queryByText("Nothing logged")).toBeNull();
  expect(queryByText("Copy from another day")).toBeNull();
});

// The other side of the same condition, so the test above cannot pass against
// an empty state that never renders at all.
test("a day with no logs and no captures still shows the empty state", async () => {
  mockDayLogs = [];
  mockCaptureRows = [];
  const { findByText } = await render(<Diary />);

  expect(await findByText("Nothing logged")).toBeTruthy();
});

// kora#241. The label and icon used to be two independent ternary chains whose
// final arm was "Voice note"/"mic", so a barcode row rendered as a voice note —
// a wrong row that no assertion could distinguish from a right one, because
// both strings are valid. This is the test that fails against that shape.
test("a queued barcode renders as a scanned item, not a voice note", async () => {
  mockCaptureRows = [
    captureRow({ kind: "barcode", code: "5000112637922", thumbnailUri: null, mealSlot: "lunch" }),
  ];
  const { findByLabelText, queryByText, queryByTestId } = await render(<Diary />);

  expect(
    await findByLabelText("Scanned item ending 7922, Identifying when you're back online"),
  ).toBeTruthy();
  expect(queryByText("Voice note")).toBeNull();
  // The Icon renders SF Symbols under Jest as `sf-<symbol>` (jest.setup.js), so
  // the glyph is assertable even though nothing is laid out (kora#257).
  expect(queryByTestId("sf-barcode")).toBeTruthy();
  expect(queryByTestId("sf-mic.fill")).toBeNull();
});

// Two unknown codes queued in the same slot must not be two identical rows:
// the user cannot tell which is which, nor a duplicate from a second product.
test("two queued barcodes render as distinguishable rows", async () => {
  mockCaptureRows = [
    captureRow({ id: "cap_a", kind: "barcode", code: "5000112637922", thumbnailUri: null }),
    captureRow({ id: "cap_b", kind: "barcode", code: "8901030865278", thumbnailUri: null }),
  ];
  const { findByText, getByText } = await render(<Diary />);

  expect(await findByText("Scanned item ending 7922")).toBeTruthy();
  expect(getByText("Scanned item ending 5278")).toBeTruthy();
});
