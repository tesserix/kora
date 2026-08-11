import { render, fireEvent } from "@testing-library/react-native";
import * as RN from "react-native";

jest.mock("@/lib/firebase", () => ({ auth: null, isFirebaseConfigured: true }));
jest.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {}, signOut: jest.fn() }));

const mockPush = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a), replace: jest.fn() } }));

const mockUseDashboard = jest.fn();
const mockUseDayLogs = jest.fn();

jest.mock("@/api/hooks", () => ({
  useProfile: () => ({ data: { display_name: "Alex Stone", onboarded_at: "2026-07-01" } }),
  useDashboard: (...args: unknown[]) => mockUseDashboard(...args),
  useDayLogs: (...args: unknown[]) => mockUseDayLogs(...args),
  useUnreadCount: () => ({ data: { count: 0 } }),
  useMemory: () => ({ data: { recents: [], frequent: [], usual_meals: [] }, isLoading: false, isError: false }),
  usePins: () => ({ data: [] }),
  useCreatePin: () => ({ mutate: jest.fn() }),
  useDeletePin: () => ({ mutate: jest.fn() }),
  useSavedMeals: () => ({ data: [] }),
}));

jest.mock("@/api/useInstantLog", () => ({
  useInstantLog: () => ({ logFood: jest.fn(), logMeal: jest.fn() }),
}));

jest.mock("@/components/meals/SavedMealSheetProvider", () => ({
  useSavedMealEditor: () => ({ openCreate: jest.fn(), openEdit: jest.fn() }),
}));

import Home from "../index";

beforeEach(() => {
  mockUseDashboard.mockReset();
  mockUseDayLogs.mockReset();
  mockPush.mockClear();
});

test("Home renders the Today large title, the gauge dial reserve numeral, protein macro, and meal rows", async () => {
  mockUseDashboard.mockReturnValue({
    data: { consumed: { kcal: 1252, protein_g: 96, carbs_g: 140, fat_g: 40 }, targets: { kcal: 2000, protein_g: 140, carbs_g: 220, fat_g: 70 }, water_ml: 1400, streak_days: 12 },
    isError: false,
  });
  mockUseDayLogs.mockReturnValue({
    data: [{ id: "1", description: "Greek yogurt bowl", meal_slot: "breakfast", kcal: 320, protein_g: 24, carbs_g: 30, fat_g: 10, logged_at: "2026-07-24T08:00:00Z", provenance: "manual", quantity_grams: 200, source: "manual" }],
    isError: false,
  });

  const { findByText, findByTestId } = await render(<Home />);
  expect(await findByText("Today")).toBeTruthy();
  expect(await findByTestId("gauge-dial")).toBeTruthy();
  expect(await findByText("748")).toBeTruthy(); // 2000 - 1252 kcal in reserve
  expect(await findByText("96/140g")).toBeTruthy(); // protein value/goal
  expect(await findByText("44g to go")).toBeTruthy(); // 140 - 96
  expect(await findByText("Logged today")).toBeTruthy();
  expect(await findByText("Greek yogurt bowl")).toBeTruthy();
  expect(await findByText("320 kcal")).toBeTruthy();
  // meal-row slot is sentence case, not an engraved uppercase label (spec's ~4-label budget)
  expect(await findByText("Breakfast")).toBeTruthy();
});

test("shows a placeholder, not a fabricated zero, while the dashboard fetch is pending", async () => {
  mockUseDashboard.mockReturnValue({ data: undefined, isError: false });
  mockUseDayLogs.mockReturnValue({ data: [], isError: false });

  const { findByTestId, queryByTestId, queryByText, getAllByText } = await render(<Home />);
  expect(await findByTestId("gauge-dial-placeholder")).toBeTruthy();
  expect(queryByTestId("gauge-dial")).toBeNull();
  expect(queryByTestId("macro-wide")).toBeNull();
  expect(getAllByText("—").length).toBeGreaterThan(0);
  // No fabricated "0" reserve/macro figures anywhere while pending.
  expect(queryByText("0")).toBeNull();
});

test("tapping Add a meal routes to /capture", async () => {
  mockUseDashboard.mockReturnValue({ data: undefined, isError: false });
  mockUseDayLogs.mockReturnValue({ data: [], isError: false });

  const { findByLabelText } = await render(<Home />);
  const addMeal = await findByLabelText("Add a meal");
  fireEvent.press(addMeal);
  expect(mockPush).toHaveBeenCalledWith("/capture");
});

test("Home shows an error message when the dashboard fails to load, and hides the gauge dial", async () => {
  mockUseDashboard.mockReturnValue({ data: undefined, isError: true });
  mockUseDayLogs.mockReturnValue({ data: [], isError: false });

  const { findByText, queryByTestId } = await render(<Home />);
  expect(await findByText(/Couldn't load your day/i)).toBeTruthy();
  expect(queryByTestId("gauge-dial")).toBeNull();
});

test("shows a first-run empty state when no meals are logged, keeping the gauge dial and macro targets visible", async () => {
  mockUseDashboard.mockReturnValue({
    data: { consumed: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, targets: { kcal: 2000, protein_g: 140, carbs_g: 220, fat_g: 70 }, water_ml: 0, streak_days: 0 },
    isError: false,
  });
  mockUseDayLogs.mockReturnValue({ data: [], isError: false });

  const { findByText, findByTestId } = await render(<Home />);
  expect(await findByText("No meals logged yet")).toBeTruthy();
  expect(await findByTestId("gauge-dial")).toBeTruthy();
  expect(await findByText("0/140g")).toBeTruthy(); // protein target
  expect(await findByText("140g to go")).toBeTruthy();
  expect(await findByText("0/220g")).toBeTruthy(); // carbs target
  expect(await findByText("0/70g")).toBeTruthy(); // fat target
});

test("shows a Connect Apple Health affordance for Steps and Sleep (never a number yet)", async () => {
  mockUseDashboard.mockReturnValue({
    data: { consumed: { kcal: 1252, protein_g: 96, carbs_g: 140, fat_g: 40 }, targets: { kcal: 2000, protein_g: 140, carbs_g: 220, fat_g: 70 }, water_ml: 1400, streak_days: 12 },
    isError: false,
  });
  mockUseDayLogs.mockReturnValue({ data: [], isError: false });

  const { getAllByLabelText } = await render(<Home />);
  expect(getAllByLabelText("Connect Apple Health").length).toBeGreaterThanOrEqual(2);
});

// app.json now ships userInterfaceStyle: "automatic" (task 13), so Home must render
// correctly under an explicit light scheme, not just whatever the test environment
// defaults to. Pins useColorScheme to "light" via spyOn rather than relying on the
// jest default so this keeps testing what it says even if that default ever changes.
test("renders the light theme: app-background is the light instrument ground and the gauge still renders", async () => {
  const schemeSpy = jest.spyOn(RN, "useColorScheme").mockReturnValue("light");
  mockUseDashboard.mockReturnValue({
    data: { consumed: { kcal: 1252, protein_g: 96, carbs_g: 140, fat_g: 40 }, targets: { kcal: 2000, protein_g: 140, carbs_g: 220, fat_g: 70 }, water_ml: 1400, streak_days: 12 },
    isError: false,
  });
  mockUseDayLogs.mockReturnValue({ data: [], isError: false });

  const { findByTestId } = await render(<Home />);
  const bg = await findByTestId("app-background");
  const flat = Array.isArray(bg.props.style)
    ? Object.assign({}, ...bg.props.style.flat().filter(Boolean))
    : bg.props.style;
  expect(flat.backgroundColor).toBe("#ECEDEF");
  expect(await findByTestId("gauge-dial")).toBeTruthy();

  schemeSpy.mockRestore();
});
