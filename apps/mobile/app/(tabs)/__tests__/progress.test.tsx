import { render, fireEvent } from "@testing-library/react-native";
import Progress from "../progress";

const mockSeries = jest.fn();
jest.mock("@/api/hooks", () => ({
  useDashboard: () => ({ data: { streak_days: 3 } }),
  useProfile: () => ({ data: { weight_kg: 80 } }),
  useWeightSeries: (range: string) => mockSeries(range),
  useAddWeight: () => ({ mutate: jest.fn(), isPending: false }),
}));

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
