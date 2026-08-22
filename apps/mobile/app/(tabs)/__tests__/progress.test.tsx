import { StyleSheet } from "react-native";
import { render, fireEvent } from "@testing-library/react-native";
import Progress from "../progress";

// useFocusEffect: ScreenEntrance (Task 9) wraps Progress's root content and
// calls the real expo-router hook, which needs a navigation container this
// isolated render doesn't mount — Progress otherwise has no expo-router
// dependency, so nothing else needs mocking here.
jest.mock("expo-router", () => ({ useFocusEffect: () => {} }));

const mockSeries = jest.fn();
const mockAvgIntake7d = jest.fn();
const mockProfile = jest.fn();
jest.mock("@/api/hooks", () => ({
  useDashboard: () => ({ data: { streak_days: 3 } }),
  useProfile: () => mockProfile(),
  useWeightSeries: (range: string) => mockSeries(range),
  useAddWeight: () => ({ mutate: jest.fn(), isPending: false }),
  useAvgIntake7d: () => mockAvgIntake7d(),
  // kora#314 PR B: Progress now also mounts BodyCompositionScanSheet, which
  // calls this. Not exercised by any test in this file — a bare stub keeps
  // Progress's render tree happy.
  useReadBodyComposition: () => ({ mutate: jest.fn(), isPending: false }),
}));

// BodyCompositionScanSheet (kora#314 PR B, mounted unconditionally by
// Progress) imports ApiError from "@/lib/api" directly, same as
// RecipeParseSheet does — and "@/lib/api" pulls in real firebase/auth ESM,
// which Jest cannot parse unmocked. Only ApiError is needed here.
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

const mockUseUnits = jest.fn();
jest.mock("@/units", () => ({
  ...jest.requireActual("@/units"),
  useUnits: () => mockUseUnits(),
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
  mockProfile.mockReturnValue({ data: { weight_kg: 80 } });
  mockAvgIntake7d.mockReturnValue({ avg: null, series: [], isLoading: false });
  mockUseHealth.mockReturnValue({ status: "unavailable", steps: null, sleep: null, connect: jest.fn() });
  mockUseUnits.mockReturnValue({ system: "metric", setSystem: jest.fn() });
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
  // In-page header retitled to match the tab (was "Progress").
  expect(getByText("Trends")).toBeTruthy();
  expect(getByText("Weight")).toBeTruthy();
  // Weight lost across the range shows the accent down-arrow delta, not the
  // old success/neutral Badge — instrument glass has one accent, not a
  // separate "good" color for this.
  expect(getByText("▾ 2.1 kg")).toBeTruthy();
  // Driven by dashboard.streak_days (a general logging streak, not a per-day
  // protein-goal hit — the dashboard has no such history), so the panel is
  // labeled for what the data actually is.
  expect(getByText("Logging streak")).toBeTruthy();
  expect(getByText("3/7 days")).toBeTruthy(); // mocked streak_days: 3
  expect(getByText("Avg sleep")).toBeTruthy();
});

test("seeds current weight from profile when the range is empty", async () => {
  mockSeries.mockReturnValue({ data: [] });
  const { getByText } = await render(<Progress />);
  expect(getByText("80.0")).toBeTruthy();            // profile.weight_kg seed
  expect(getByText(/Log your weight/i)).toBeTruthy(); // hint, no chart — the >=2 points guard
});

test("shows the no-weigh-ins empty state and opens the weight-log sheet from its CTA", async () => {
  mockSeries.mockReturnValue({ data: [] });
  const { getByText, findByText } = await render(<Progress />);
  expect(getByText("No weigh-ins yet")).toBeTruthy();
  expect(getByText("Log your weight to see your trend.")).toBeTruthy();
  // CTA reuses the existing WeightLogSheet affordance (setSheetOpen).
  fireEvent.press(getByText("Log weight"));
  expect(await findByText("Save")).toBeTruthy();
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

test("offers Connect Apple Health for the Avg sleep panel", async () => {
  mockSeries.mockReturnValue({ data: [] });
  const { getAllByLabelText } = await render(<Progress />);
  // Trends has no Steps widget (spec §Screens.4 lists only Weight, Energy vs
  // budget, and the Protein-goal/Avg-sleep duo) — only the sleep panel offers
  // the connect prompt.
  expect(getAllByLabelText("Connect Apple Health").length).toBeGreaterThanOrEqual(1);
});

test("shows real sleep and renders the energy-vs-budget bars when Health is authorized and avg data exists", async () => {
  mockSeries.mockReturnValue({ data: [] });
  mockUseHealth.mockReturnValue({
    status: "authorized",
    steps: { today: 8240, goal: 10000 },
    sleep: { lastNightHours: 7.1 },
    connect: jest.fn(),
  });
  mockAvgIntake7d.mockReturnValue({ avg: 1921, series: [1900, 1950, 1921], isLoading: false });

  const { getByText, getByTestId, getAllByText, queryByLabelText } = await render(<Progress />);
  expect(getByText("7.1h")).toBeTruthy();
  expect(queryByLabelText("Connect Apple Health")).toBeNull();
  for (let i = 0; i < 7; i++) expect(getByTestId(`ebar-${i}`)).toBeTruthy();
  expect(getByTestId("ebar-target")).toBeTruthy();
  // useAvgIntake7d's series carries no dates (only the trailing days that had
  // logged data, in order), so bars can't be attributed to real weekdays —
  // only the most recent bar is labeled ("today"); the rest are unlabeled
  // rather than misattributed to the wrong day.
  expect(getByText("today")).toBeTruthy();
  expect(getAllByText("—").length).toBe(6);
  // Finding 2 (Dynamic Type cap pass): EnergyBars' day labels and the
  // In-budget/Over/Target legend need an explicit cap — the cap IS the
  // overflow protection for this fixed-width bar chart.
  expect(getByText("today").props.maxFontSizeMultiplier).toBe(1.4);
  expect(getByText("In-budget").props.maxFontSizeMultiplier).toBe(1.4);
  expect(getByText("Over").props.maxFontSizeMultiplier).toBe(1.4);
  expect(getByText("Target").props.maxFontSizeMultiplier).toBe(1.4);
});

test("renders the logging-streak and avg-sleep streak cell duo", async () => {
  mockSeries.mockReturnValue({ data: [] });
  const { getByTestId } = await render(<Progress />);
  for (let i = 0; i < 7; i++) {
    expect(getByTestId(`logging-streak-${i}`)).toBeTruthy();
    expect(getByTestId(`sleep-streak-${i}`)).toBeTruthy();
  }
});

test("shows weight in lb and converts the delta badge when the preference is imperial", async () => {
  mockUseUnits.mockReturnValue({ system: "imperial", setSystem: jest.fn() });
  mockSeries.mockReturnValue({
    data: [
      { id: "1", weight_kg: 80, logged_at: "2026-07-20T08:00:00Z" },
      { id: "2", weight_kg: 78.6, logged_at: "2026-07-23T08:00:00Z" },
    ],
  });
  const { getByText } = await render(<Progress />);
  // 78.6 kg -> 173.3 lb (formatWeight / AnimatedNumber's toFixed(1) format).
  expect(getByText("173.3")).toBeTruthy();
  expect(getByText("lb")).toBeTruthy();
  // delta: 78.6 - 80 = -1.4 kg -> -3.1 lb, accent down-arrow delta (magnitude only).
  expect(getByText("▾ 3.1 lb")).toBeTruthy();
});

// kora#177: the loaded figure renders via AnimatedNumber (a raw RN Text) and
// the placeholder via AppText, both inside one `alignItems: "baseline"` row.
// They must share a line box or the number jumps vertically the moment data
// lands.
test("the weight figure and its placeholder share one line box", async () => {
  mockSeries.mockReturnValue({ data: [] });
  mockProfile.mockReturnValue({ data: { weight_kg: null } });
  const placeholder = await render(<Progress />);
  // The energy bars also render "—" for their unlabeled days; the weight
  // figure is the only 34pt one.
  const placeholderStyle = placeholder
    .getAllByText("—")
    .map((n) => StyleSheet.flatten(n.props.style))
    .find((s) => s?.fontSize === 34);

  mockSeries.mockReturnValue({ data: [
    { id: "1", weight_kg: 71.9, logged_at: "2026-07-23T08:00:00Z" },
  ] });
  const loaded = await render(<Progress />);
  const loadedStyle = StyleSheet.flatten(loaded.getByText("71.9").props.style);

  expect(placeholderStyle?.fontSize).toBe(loadedStyle.fontSize);
  expect(typeof loadedStyle.lineHeight).toBe("number");
  expect(loadedStyle.lineHeight).toBe(placeholderStyle?.lineHeight);
});
