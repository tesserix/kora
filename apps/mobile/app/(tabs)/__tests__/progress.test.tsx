import { render, fireEvent } from "@testing-library/react-native";
import Progress from "../progress";

const mockSeries = jest.fn();
const mockAvgIntake7d = jest.fn();
jest.mock("@/api/hooks", () => ({
  useDashboard: () => ({ data: { streak_days: 3 } }),
  useProfile: () => ({ data: { weight_kg: 80 } }),
  useWeightSeries: (range: string) => mockSeries(range),
  useAddWeight: () => ({ mutate: jest.fn(), isPending: false }),
  useAvgIntake7d: () => mockAvgIntake7d(),
}));

// @/health defaults to the "unavailable"/connect state, mirroring what the real
// useHealth() resolves to under jest.setup.js's global HealthKit mock — kept
// mockable per-test (mutable return, not doMock re-require) for the authorized
// path test below.
const mockUseHealth = jest.fn();
jest.mock("@/health", () => ({
  useHealth: () => mockUseHealth(),
}));

beforeEach(() => {
  mockAvgIntake7d.mockReturnValue({ avg: null, series: [], isLoading: false });
  mockUseHealth.mockReturnValue({ status: "unavailable", steps: null, sleep: null, connect: jest.fn() });
});

test("shows real current weight when entries exist", async () => {
  mockSeries.mockReturnValue({ data: [
    { id: "1", weight_kg: 74.0, logged_at: "2026-07-20T08:00:00Z" },
    { id: "2", weight_kg: 71.9, logged_at: "2026-07-23T08:00:00Z" },
  ] });
  const { getByText } = await render(<Progress />);
  // 71.9 = latest entry; distinct from the old hardcoded "72.4" placeholder, so
  // this fails on the pre-rewrite screen (real RED) and passes on the new one.
  expect(getByText("71.9")).toBeTruthy();
  expect(getByText("Progress")).toBeTruthy();
  expect(getByText("Weight")).toBeTruthy();
  expect(getByText("Log streak")).toBeTruthy();
});

test("seeds current weight from profile when the range is empty", async () => {
  mockSeries.mockReturnValue({ data: [] });
  const { getByText } = await render(<Progress />);
  expect(getByText("80.0")).toBeTruthy();            // profile.weight_kg seed
  expect(getByText(/Log your weight/i)).toBeTruthy(); // hint, no chart — the >=2 points guard
});

test("range segmented control renders all range labels and re-queries the series on selection", async () => {
  mockSeries.mockReturnValue({ data: [
    { id: "1", weight_kg: 74.0, logged_at: "2026-07-20T08:00:00Z" },
    { id: "2", weight_kg: 71.9, logged_at: "2026-07-23T08:00:00Z" },
  ] });
  const { getByText, getByRole } = await render(<Progress />);
  expect(getByText("1W")).toBeTruthy();
  expect(getByText("1M")).toBeTruthy();
  expect(getByText("3M")).toBeTruthy();
  expect(getByText("1Y")).toBeTruthy();
  expect(mockSeries).toHaveBeenLastCalledWith("1W");

  await fireEvent.press(getByRole("tab", { name: "1M" }));
  expect(mockSeries).toHaveBeenLastCalledWith("1M");
});

test("never renders the old fabricated metrics", async () => {
  mockSeries.mockReturnValue({ data: [] });
  const { queryByText } = await render(<Progress />);
  expect(queryByText("1,921")).toBeNull();
  expect(queryByText("8,240")).toBeNull();
  expect(queryByText("7.1")).toBeNull();
});

test("offers Connect Apple Health for Steps and Sleep", async () => {
  mockSeries.mockReturnValue({ data: [] });
  const { getAllByLabelText } = await render(<Progress />);
  expect(getAllByLabelText("Connect Apple Health").length).toBeGreaterThanOrEqual(2);
});

test("shows real steps, sleep, and 7-day avg intake when Health is authorized and avg data exists", async () => {
  mockSeries.mockReturnValue({ data: [] });
  mockUseHealth.mockReturnValue({
    status: "authorized",
    steps: { today: 8240, goal: 10000 },
    sleep: { lastNightHours: 7.1 },
    connect: jest.fn(),
  });
  mockAvgIntake7d.mockReturnValue({ avg: 1921, series: [1900, 1950, 1921], isLoading: false });

  const { getByText, queryByLabelText } = await render(<Progress />);
  expect(getByText("8,240")).toBeTruthy();
  expect(getByText("7.1")).toBeTruthy();
  expect(getByText("1,921")).toBeTruthy();
  expect(queryByLabelText("Connect Apple Health")).toBeNull();
});
