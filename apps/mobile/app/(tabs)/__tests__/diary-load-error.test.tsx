import { render, fireEvent } from "@testing-library/react-native";
import Diary from "../diary";

// #174 item 1: `pending = !data && !isError` is false on error, so a failed
// fetch used to render "0 / 0 kcal", a 0% bar and "0.0 L" as if they were the
// user's real day. Home ((tabs)/index.tsx) already gets this right — an
// explicit error banner with the figures hidden rather than zeroed — and these
// tests pin the same shape here.

const mockDashboardRefetch = jest.fn();
const mockLogsRefetch = jest.fn();
const mockDashboard = jest.fn();
const mockLogs = jest.fn();

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/offline/useQueuedLogs", () => ({
  useQueuedLogs: () => ({ rows: [], retryRow: jest.fn(), discardRow: jest.fn() }),
}));
jest.mock("@/offline/useQueuedCaptures", () => ({
  useQueuedCaptures: () => ({ rows: [] }),
}));
jest.mock("@/api/hooks", () => ({
  useDashboard: () => mockDashboard(),
  useDayLogs: () => mockLogs(),
  useAddWater: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteLog: () => ({ mutate: jest.fn(), isPending: false }),
}));

beforeEach(() => {
  mockDashboardRefetch.mockClear();
  mockLogsRefetch.mockClear();
  mockDashboard.mockReturnValue({ data: undefined, isError: true, refetch: mockDashboardRefetch });
  mockLogs.mockReturnValue({ data: undefined, isError: true, refetch: mockLogsRefetch });
});

test("a failed day fetch says so instead of rendering a zeroed day", async () => {
  const { getByText, queryByText } = await render(<Diary />);

  expect(getByText("Couldn't load your day.")).toBeTruthy();
  // The three fabrications: the day total, its goal, and the water figure.
  expect(queryByText("0")).toBeNull();
  expect(queryByText(" / 0 kcal")).toBeNull();
  expect(queryByText("0.0 L")).toBeNull();
});

// "We couldn't load this" must never look like "you have none": a failed log
// fetch rendering the first-run empty state tells a user with a full diary
// that the day is blank.
test("a failed log fetch does not render the empty-day state", async () => {
  const { queryByText } = await render(<Diary />);
  expect(queryByText("Nothing logged")).toBeNull();
});

test("Retry refetches both the dashboard and the day's logs", async () => {
  const { getByLabelText } = await render(<Diary />);
  await fireEvent.press(getByLabelText("Retry"));
  expect(mockDashboardRefetch).toHaveBeenCalled();
  expect(mockLogsRefetch).toHaveBeenCalled();
});

// The over-correction guard: a resolved day with genuinely nothing eaten still
// has to show real zeros, and the empty state is still the truth there.
test("a resolved day with zero consumption still shows real zeros", async () => {
  mockDashboard.mockReturnValue({
    data: { consumed: { kcal: 0 }, targets: { kcal: 2000 }, water_ml: 0 },
    isError: false,
    refetch: mockDashboardRefetch,
  });
  mockLogs.mockReturnValue({ data: [], isError: false, refetch: mockLogsRefetch });

  const { getByText, queryByText } = await render(<Diary />);
  expect(getByText("0")).toBeTruthy();
  expect(getByText(" / 2,000 kcal")).toBeTruthy();
  expect(getByText("0.0 L")).toBeTruthy();
  expect(getByText("Nothing logged")).toBeTruthy();
  expect(queryByText("Couldn't load your day.")).toBeNull();
});
