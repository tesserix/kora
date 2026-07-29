import { render, fireEvent } from "@testing-library/react-native";

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

test("Home renders the Today large title with the animated kcal-left number and meal rows", async () => {
  mockUseDashboard.mockReturnValue({
    data: { consumed: { kcal: 1252, protein_g: 96, carbs_g: 140, fat_g: 40 }, targets: { kcal: 2000, protein_g: 140, carbs_g: 220, fat_g: 70 }, water_ml: 1400, streak_days: 12 },
    isError: false,
  });
  mockUseDayLogs.mockReturnValue({
    data: [{ id: "1", description: "Greek yogurt bowl", meal_slot: "breakfast", kcal: 320, protein_g: 24, carbs_g: 30, fat_g: 10, logged_at: "2026-07-24T08:00:00Z", provenance: "manual", quantity_grams: 200, source: "manual" }],
    isError: false,
  });

  const { findByText } = await render(<Home />);
  expect(await findByText("Today")).toBeTruthy();
  expect(await findByText("748")).toBeTruthy(); // 2000 - 1252 kcal left
  expect(await findByText("Greek yogurt bowl")).toBeTruthy();
  expect(await findByText("320 kcal")).toBeTruthy();
});

test("tapping Add a meal routes to /capture", async () => {
  mockUseDashboard.mockReturnValue({ data: undefined, isError: false });
  mockUseDayLogs.mockReturnValue({ data: [], isError: false });

  const { findByLabelText } = await render(<Home />);
  const addMeal = await findByLabelText("Add a meal");
  fireEvent.press(addMeal);
  expect(mockPush).toHaveBeenCalledWith("/capture");
});

test("Home shows an error message when the dashboard fails to load", async () => {
  mockUseDashboard.mockReturnValue({ data: undefined, isError: true });
  mockUseDayLogs.mockReturnValue({ data: [], isError: false });

  const { findByText, queryByText } = await render(<Home />);
  expect(await findByText(/Couldn't load your day/i)).toBeTruthy();
  expect(queryByText(/calories left/i)).toBeNull();
});

test("shows a first-run empty state when no meals are logged, keeping the calorie goal visible", async () => {
  mockUseDashboard.mockReturnValue({
    data: { consumed: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, targets: { kcal: 2000, protein_g: 140, carbs_g: 220, fat_g: 70 }, water_ml: 0, streak_days: 0 },
    isError: false,
  });
  mockUseDayLogs.mockReturnValue({ data: [], isError: false });

  const { findByText } = await render(<Home />);
  expect(await findByText("No meals logged yet")).toBeTruthy();
  expect(await findByText(/log your first meal/i)).toBeTruthy();
  // the onboarding-computed calorie goal/ring stays visible for a first-run user
  expect(await findByText("kcal left")).toBeTruthy();
  expect(await findByText("2,000")).toBeTruthy();
});

test("shows a Connect Apple Health affordance for Steps (never a number yet)", async () => {
  mockUseDashboard.mockReturnValue({
    data: { consumed: { kcal: 1252, protein_g: 96, carbs_g: 140, fat_g: 40 }, targets: { kcal: 2000, protein_g: 140, carbs_g: 220, fat_g: 70 }, water_ml: 1400, streak_days: 12 },
    isError: false,
  });
  mockUseDayLogs.mockReturnValue({ data: [], isError: false });

  const { getAllByLabelText } = await render(<Home />);
  expect(getAllByLabelText("Connect Apple Health").length).toBeGreaterThanOrEqual(2);
});
