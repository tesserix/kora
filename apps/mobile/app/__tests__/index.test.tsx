import { render } from "@testing-library/react-native";

jest.mock("@/lib/firebase", () => ({ auth: null, isFirebaseConfigured: true }));
jest.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {}, signOut: jest.fn() }));
jest.mock("expo-router", () => ({ router: { push: jest.fn(), replace: jest.fn() } }));

const mockUseDashboard = jest.fn();
const mockUseDayLogs = jest.fn();

jest.mock("@/api/hooks", () => ({
  useProfile: () => ({ data: { display_name: "Alex Stone", onboarded_at: "2026-07-01" } }),
  useDashboard: (...args: unknown[]) => mockUseDashboard(...args),
  useDayLogs: (...args: unknown[]) => mockUseDayLogs(...args),
}));

import Home from "../(tabs)/index";

beforeEach(() => {
  mockUseDashboard.mockReset();
  mockUseDayLogs.mockReset();
});

test("Home shows the Otto editorial headline with kcal-left and the capture hero", async () => {
  mockUseDashboard.mockReturnValue({
    data: { consumed: { kcal: 1252, protein_g: 96, carbs_g: 140, fat_g: 40 }, targets: { kcal: 2000, protein_g: 140, carbs_g: 220, fat_g: 70 }, water_ml: 1400, streak_days: 12 },
    isError: false,
  });
  mockUseDayLogs.mockReturnValue({
    data: [{ id: "1", description: "Greek yogurt bowl", meal_slot: "breakfast", kcal: 320, protein_g: 24, carbs_g: 30, fat_g: 10, logged_at: "2026-07-24T08:00:00Z", provenance: "manual", quantity_grams: 200, source: "manual" }],
    isError: false,
  });

  const { findByText } = await render(<Home />);
  expect(await findByText(/strong day/i)).toBeTruthy();
  expect(await findByText(/Snap a meal/i)).toBeTruthy();
  expect(await findByText("Greek yogurt bowl")).toBeTruthy();
});

test("Home shows a graceful placeholder instead of a 0 kcal flash while loading", async () => {
  mockUseDashboard.mockReturnValue({ data: undefined, isError: false });
  mockUseDayLogs.mockReturnValue({ data: [], isError: false });

  const { queryByText, findByText } = await render(<Home />);
  expect(queryByText(/0 kcal from a strong day/i)).toBeNull();
  expect(await findByText(/Getting your day ready/i)).toBeTruthy();
});

test("Home shows an error message when the dashboard fails to load", async () => {
  mockUseDashboard.mockReturnValue({ data: undefined, isError: true });
  mockUseDayLogs.mockReturnValue({ data: [], isError: false });

  const { findByText } = await render(<Home />);
  expect(await findByText(/Couldn't load your day/i)).toBeTruthy();
});
