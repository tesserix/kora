import { render, fireEvent } from "@testing-library/react-native";
import Progress from "../progress";

// Same isolation as progress.test.tsx — see its comments for why each of these
// is mocked. Split into its own file because kora#45's additions want a
// composition-bearing weight series, which every test in the original file
// would otherwise have to opt out of.
jest.mock("expo-router", () => ({ useFocusEffect: () => {} }));

const mockSeries = jest.fn();
const mockProfile = jest.fn();
const mockUseWeightTrend = jest.fn();
jest.mock("@/api/hooks", () => ({
  useDashboard: () => ({ data: { streak_days: 3 } }),
  useProfile: () => mockProfile(),
  useWeightSeries: (range: string) => mockSeries(range),
  useWeightTrend: (metric: string, range: string) => mockUseWeightTrend(metric, range),
  useAddWeight: () => ({ mutate: jest.fn(), isPending: false }),
  useAvgIntake7d: () => ({ avg: null, series: [], days: [], isLoading: false, isError: false, refetch: jest.fn() }),
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

const mockUseUnits = jest.fn();
jest.mock("@/units", () => ({
  ...jest.requireActual("@/units"),
  useUnits: () => mockUseUnits(),
}));

beforeEach(() => {
  mockProfile.mockReturnValue({ data: { weight_kg: 80, height_cm: 165, goal: "fat_loss" } });
  mockUseUnits.mockReturnValue({ system: "metric", setSystem: jest.fn() });
  mockUseWeightTrend.mockReturnValue({ data: undefined, isSuccess: false });
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

// The hero figure's "tap to log weight" affordance only means what it says
// while the charted metric IS weight — a tap under a body-fat figure doing
// the same thing would be logging weight while a body-fat number sits above
// it, which is not what the tap does.
test("the hero figure stops being pressable once a composition metric is charted", async () => {
  mockSeries.mockReturnValue({
    data: [
      weighIn({ weight_kg: 74, body_fat_pct: 26.4, logged_at: "2026-07-20T08:00:00Z" }),
      weighIn({ weight_kg: 71.9, body_fat_pct: 24.2, logged_at: "2026-07-23T08:00:00Z" }),
    ],
  });
  // Targeted by testID, not by label: the explicit "Log weight" button below
  // the chart shares this affordance's accessible name, so a label lookup
  // would match either one and prove nothing about the figure.
  const { getByTestId, queryByTestId } = await render(<Progress />);
  expect(getByTestId("hero-log-weight")).toBeTruthy(); // pressable while weight is charted

  await fireEvent.press(getByTestId("metric-chip-body_fat_pct"));
  expect(queryByTestId("hero-log-weight")).toBeNull();
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

// kora#314 PR C: "Add body composition" and "Import from screenshot" no
// longer exist as separate buttons — both entry points now live inside the
// one "Log weight" sheet, as Manual mode's expanding section and Screenshot
// mode respectively. See LogWeightSheet.test.tsx for full mode coverage;
// these two tests just prove Trends' one remaining tap still reaches both.
test("reaches the composition fields from the Trends panel, behind the expanding section", async () => {
  mockSeries.mockReturnValue({ data: [weighIn({ weight_kg: 71.9 })] });
  const { getByText, getByTestId, queryByTestId } = await render(<Progress />);
  expect(queryByTestId("composition-derived")).toBeNull();
  await fireEvent.press(getByText("Log weight"));
  await fireEvent.press(getByTestId("composition-expand-toggle"));
  expect(getByTestId("composition-derived")).toBeTruthy();
});

test("the daily weigh-in stays two taps: open the sheet, Save", async () => {
  mockSeries.mockReturnValue({ data: [weighIn({ weight_kg: 71.9 })] });
  const { getByText, findByText, queryByTestId } = await render(<Progress />);
  await fireEvent.press(getByText("Log weight"));
  expect(await findByText("Save")).toBeTruthy();
  // kora#45's rule survives consolidation (kora#314 PR C): the nine
  // composition fields and the derived readout stay collapsed until "More
  // fields" is tapped — most days are weight and nothing else.
  expect(queryByTestId("composition-derived")).toBeNull();
  expect(queryByTestId("composition-date")).toBeNull();
});

// kora#45 (task 7): the fitted weekly rate reads beneath the chart, framed
// as an estimate rather than a prediction — see src/lib/trendCopy.ts.
// A chart needs 2+ points to mount at all (hasChart), so these give the
// weight series two weigh-ins even though the assertions are all about the
// trend sentence, not the chart itself.
test("shows the estimate-framed rate under the chart", async () => {
  mockSeries.mockReturnValue({ data: [weighIn({ weight_kg: 74 }), weighIn({ weight_kg: 71.9 })] });
  mockUseWeightTrend.mockReturnValue({
    data: { status: "ok", rate_per_week: -0.4, basis: { readings: 9, days: 42 }, spans_instruments: false, show_support: false },
    isSuccess: true,
  });
  const { findByText } = await render(<Progress />);
  expect(await findByText(/About 0.4 kg per week down/)).toBeTruthy();
});

test("shows nothing at all when the rate is suppressed", async () => {
  mockSeries.mockReturnValue({ data: [weighIn({ weight_kg: 74 }), weighIn({ weight_kg: 71.9 })] });
  mockUseWeightTrend.mockReturnValue({
    data: { status: "suppressed", spans_instruments: false, show_support: true },
    isSuccess: true,
  });
  const { queryByText } = await render(<Progress />);
  expect(queryByText(/per week/)).toBeNull();
});
