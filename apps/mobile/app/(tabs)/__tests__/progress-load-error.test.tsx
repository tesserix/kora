import { render, fireEvent } from "@testing-library/react-native";
import Progress from "../progress";

// useFocusEffect: ScreenEntrance (Task 9) wraps Progress's root content and
// calls the real expo-router hook, which needs a navigation container this
// isolated render doesn't mount.
jest.mock("expo-router", () => ({ useFocusEffect: () => {} }));

// #174 item 1. Two separate lies on this screen:
//  - the dashboard's `pending` guard is false on error, so the logging streak
//    rendered "0/7 days" as fact;
//  - `series.isError` was never read at all, so a failed weight fetch fell
//    through to the "No weigh-ins yet" empty state — telling a user with
//    months of weigh-ins that they have none.

const mockSeries = jest.fn();
const mockDashboard = jest.fn();
const mockSeriesRefetch = jest.fn();
const mockDashboardRefetch = jest.fn();

jest.mock("@/api/hooks", () => ({
  useDashboard: () => mockDashboard(),
  useProfile: () => ({ data: { weight_kg: 80 } }),
  useWeightSeries: () => mockSeries(),
  useAddWeight: () => ({ mutate: jest.fn(), isPending: false }),
  useAvgIntake7d: () => ({ avg: null, series: [], isLoading: false }),
  // kora#314 PR C: Progress now mounts LogWeightSheet (Screenshot mode), which
  // calls this. Not exercised by any test in this file — a bare stub keeps
  // Progress's render tree happy.
  useReadBodyComposition: () => ({ mutate: jest.fn(), isPending: false }),
}));

// See progress.test.tsx's own comment: LogWeightSheet's screenshot mode imports
// ApiError from "@/lib/api" directly, which pulls in real firebase/auth ESM
// that Jest cannot parse unmocked.
jest.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.name = "ApiError";
    }
  },
}));

jest.mock("@/health", () => ({
  useHealth: () => ({ status: "unavailable", steps: null, sleep: null, connect: jest.fn() }),
}));

beforeEach(() => {
  mockSeriesRefetch.mockClear();
  mockDashboardRefetch.mockClear();
  mockSeries.mockReturnValue({ data: undefined, isError: true, refetch: mockSeriesRefetch });
  mockDashboard.mockReturnValue({ data: undefined, isError: true, refetch: mockDashboardRefetch });
});

test("a failed weight fetch says so instead of claiming there are no weigh-ins", async () => {
  const { getByText, queryByText } = await render(<Progress />);

  expect(getByText("Couldn't load your weigh-ins.")).toBeTruthy();
  expect(queryByText("No weigh-ins yet")).toBeNull();
  expect(queryByText("Log your weight to see your trend.")).toBeNull();
});

test("a failed dashboard fetch does not render a 0-day logging streak", async () => {
  const { getByText, queryByText } = await render(<Progress />);
  expect(queryByText("0/7 days")).toBeNull();
  expect(getByText("Couldn't load your streak.")).toBeTruthy();
});

test("Retry refetches the weight series", async () => {
  const { getAllByLabelText } = await render(<Progress />);
  await fireEvent.press(getAllByLabelText("Retry")[0]);
  expect(mockSeriesRefetch).toHaveBeenCalled();
});

// Over-correction guard: a resolved-but-genuinely-empty series is still an
// empty state, and a real streak of zero days is still "0/7 days".
test("a resolved empty series still shows the no-weigh-ins state", async () => {
  mockSeries.mockReturnValue({ data: [], isError: false, refetch: mockSeriesRefetch });
  mockDashboard.mockReturnValue({ data: { streak_days: 0 }, isError: false, refetch: mockDashboardRefetch });

  const { getByText, queryByText } = await render(<Progress />);
  expect(getByText("No weigh-ins yet")).toBeTruthy();
  expect(getByText("0/7 days")).toBeTruthy();
  expect(queryByText("Couldn't load your weigh-ins.")).toBeNull();
});
