import { render, fireEvent } from "@testing-library/react-native";
import Progress from "../progress";

// Same isolation as progress.test.tsx — see its comments for why each of these
// is mocked. Split into its own file because kora#45's additions want a
// composition-bearing weight series, which every test in the original file
// would otherwise have to opt out of.
jest.mock("expo-router", () => ({ useFocusEffect: () => {} }));

const mockSeries = jest.fn();
const mockProfile = jest.fn();
jest.mock("@/api/hooks", () => ({
  useDashboard: () => ({ data: { streak_days: 3 } }),
  useProfile: () => mockProfile(),
  useWeightSeries: (range: string) => mockSeries(range),
  useAddWeight: () => ({ mutate: jest.fn(), isPending: false }),
  useAvgIntake7d: () => ({ avg: null, series: [], isLoading: false }),
}));

jest.mock("@/health", () => ({
  useHealth: () => ({ status: "unavailable", steps: null, sleep: null, connect: jest.fn() }),
}));

const mockUseUnits = jest.fn();
jest.mock("@/units", () => ({
  ...jest.requireActual("@/units"),
  useUnits: () => mockUseUnits(),
}));

beforeEach(() => {
  mockProfile.mockReturnValue({ data: { weight_kg: 80, height_cm: 165, goal: "fat_loss" } });
  mockUseUnits.mockReturnValue({ system: "metric", setSystem: jest.fn() });
});

const weighIn = (over: Record<string, unknown>) => ({
  id: String(Math.random()),
  weight_kg: 70,
  logged_at: "2026-07-20T08:00:00Z",
  source: "manual",
  ...over,
});

test("a weight-only history shows no metric picker at all", async () => {
  mockSeries.mockReturnValue({
    data: [weighIn({ weight_kg: 74 }), weighIn({ weight_kg: 71.9 })],
  });
  const { queryByTestId } = await render(<Progress />);
  expect(queryByTestId("metric-chips")).toBeNull();
});

test("offers a chip per metric the history holds, and charts the chosen one", async () => {
  mockSeries.mockReturnValue({
    data: [
      weighIn({ weight_kg: 74, body_fat_pct: 26.4, logged_at: "2026-07-20T08:00:00Z" }),
      weighIn({ weight_kg: 71.9, body_fat_pct: 24.2, logged_at: "2026-07-23T08:00:00Z" }),
    ],
  });
  const { getByTestId, getAllByText, getByText, queryByTestId } = await render(<Progress />);
  expect(getByTestId("metric-chips")).toBeTruthy();
  expect(queryByTestId("metric-chip-protein_pct")).toBeNull(); // never logged

  // Weight is the default hero.
  expect(getByText("71.9")).toBeTruthy();
  expect(getByText("▾ 2.1 kg")).toBeTruthy();

  await fireEvent.press(getByTestId("metric-chip-body_fat_pct"));
  // The hero label follows the chart, so the figure and the line below it are
  // the same quantity. Twice on screen: the chip, and the panel's own heading.
  expect(getAllByText("Body fat")).toHaveLength(2);
  expect(getByText("▾ 2.2 %")).toBeTruthy();
  // The hero FIGURE is an AnimatedNumber, and jest.setup.js NOOPs reanimated's
  // useAnimatedReaction — the number it displays after a switch is not
  // observable here. Its delta, above, is ordinary text and is.
});

test("the visceral rating is charted without a percent sign anywhere near it", async () => {
  mockSeries.mockReturnValue({
    data: [weighIn({ visceral_fat_rating: 8 }), weighIn({ visceral_fat_rating: 7 })],
  });
  const { getByTestId, getAllByText, getByText, queryByText } = await render(<Progress />);
  await fireEvent.press(getByTestId("metric-chip-visceral_fat_rating"));
  expect(getAllByText("Visceral fat")).toHaveLength(2);
  // The delta carries no unit, and there is no "%" anywhere for the hero
  // figure to sit beside either — a rating rendered as a percentage is a false
  // claim about the number, not a cosmetic slip.
  expect(getByText("▾ 1.0")).toBeTruthy();
  expect(queryByText("▾ 1.0 %")).toBeNull();
  expect(queryByText("%")).toBeNull();
});

test("says so, in words, when a trend spans two instruments", async () => {
  mockSeries.mockReturnValue({
    data: [
      weighIn({ body_fat_pct: 26.4, source: "manual" }),
      weighIn({ body_fat_pct: 25.9, source: "manual" }),
      weighIn({ body_fat_pct: 19.4, source: "dexa" }),
      weighIn({ body_fat_pct: 19.1, source: "dexa" }),
    ],
  });
  const { getByTestId } = await render(<Progress />);
  await fireEvent.press(getByTestId("metric-chip-body_fat_pct"));
  const note = getByTestId("instrument-change-note").props.children as string;
  expect(note).toContain("Scale");
  expect(note).toContain("DEXA");
  expect(note).toContain("separate lines");
  // And the chart itself is split, not merely annotated.
  expect(getByTestId("weight-chart-line-1")).toBeTruthy();
});

test("a single-instrument trend carries no such note", async () => {
  mockSeries.mockReturnValue({
    data: [weighIn({ body_fat_pct: 26.4 }), weighIn({ body_fat_pct: 24.2 })],
  });
  const { getByTestId, queryByTestId } = await render(<Progress />);
  await fireEvent.press(getByTestId("metric-chip-body_fat_pct"));
  expect(queryByTestId("instrument-change-note")).toBeNull();
});

test("the change is measured since the instrument changed, not across the switch", async () => {
  mockSeries.mockReturnValue({
    data: [
      weighIn({ body_fat_pct: 26.4, source: "manual" }),
      weighIn({ body_fat_pct: 25.9, source: "manual" }),
      weighIn({ body_fat_pct: 19.4, source: "dexa" }),
      weighIn({ body_fat_pct: 19.1, source: "dexa" }),
    ],
  });
  const { getByTestId, getByText, queryByText } = await render(<Progress />);
  await fireEvent.press(getByTestId("metric-chip-body_fat_pct"));
  // 19.4 -> 19.1 within DEXA. Across the whole series it would read 7.3 points
  // of fat lost, 6.5 of which is two instruments disagreeing.
  expect(getByText("▾ 0.3 %")).toBeTruthy();
  expect(queryByText("▾ 7.3 %")).toBeNull();
});

test("reaches the body-composition form from the Trends panel", async () => {
  mockSeries.mockReturnValue({ data: [weighIn({ weight_kg: 71.9 })] });
  const { getByText, findByText, queryByTestId } = await render(<Progress />);
  expect(queryByTestId("body-composition-form")).toBeNull();
  await fireEvent.press(getByText("Add body composition"));
  expect(await findByText("Body composition")).toBeTruthy();
});

test("the daily weigh-in stays a separate, one-field sheet", async () => {
  mockSeries.mockReturnValue({ data: [weighIn({ weight_kg: 71.9 })] });
  const { getByLabelText, findByText, queryByTestId } = await render(<Progress />);
  await fireEvent.press(getByLabelText("Log weight"));
  expect(await findByText("Log weight")).toBeTruthy();
  // kora#45 explicitly does NOT put the composition fields in front of the
  // daily weigh-in: most days are weight and nothing else.
  expect(queryByTestId("body-composition-form")).toBeNull();
});
