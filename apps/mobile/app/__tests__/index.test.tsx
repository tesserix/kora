import { render } from "@testing-library/react-native";

jest.mock("@/lib/firebase", () => ({ auth: null, isFirebaseConfigured: true }));
jest.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {}, signOut: jest.fn() }));
jest.mock("expo-router", () => ({ router: { push: jest.fn(), replace: jest.fn() } }));
jest.mock("@/api/hooks", () => ({
  useProfile: () => ({ data: { display_name: "Alex Stone", onboarded_at: "2026-07-01" } }),
  useDashboard: () => ({ data: { consumed: { kcal: 1252, protein_g: 96, carbs_g: 140, fat_g: 40 }, targets: { kcal: 2000, protein_g: 140, carbs_g: 220, fat_g: 70 }, water_ml: 1400, streak_days: 12 } }),
  useDayLogs: () => ({ data: [{ id: "1", description: "Greek yogurt bowl", meal_slot: "breakfast", kcal: 320, protein_g: 24, carbs_g: 30, fat_g: 10, logged_at: "2026-07-24T08:00:00Z", provenance: "manual", quantity_grams: 200, source: "manual" }] }),
}));

import Home from "../(tabs)/index";

test("Home shows the Otto editorial headline with kcal-left and the capture hero", async () => {
  const { findByText } = await render(<Home />);
  expect(await findByText(/strong day/i)).toBeTruthy();
  expect(await findByText(/Snap a meal/i)).toBeTruthy();
  expect(await findByText("Greek yogurt bowl")).toBeTruthy();
});
