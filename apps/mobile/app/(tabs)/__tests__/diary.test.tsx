import { render } from "@testing-library/react-native";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/api/hooks", () => ({
  useDashboard: () => ({ data: { consumed: { kcal: 1252 }, targets: { kcal: 2000 }, water_ml: 1400 } }),
  useDayLogs: () => ({ data: [{ id: "1", description: "Grilled salmon", meal_slot: "dinner", kcal: 520, protein_g: 40, carbs_g: 10, fat_g: 30, logged_at: "2026-07-24T19:00:00Z", provenance: "manual", quantity_grams: 200, source: "manual" }] }),
  useAddWater: () => ({ mutate: jest.fn(), isPending: false }),
}));

import Diary from "../diary";

test("Diary shows header, timeline and a logged meal", async () => {
  const { findByText } = await render(<Diary />);
  expect(await findByText("Diary")).toBeTruthy();
  expect(await findByText("Timeline")).toBeTruthy();
  expect(await findByText("Grilled salmon")).toBeTruthy();
});

test("a day with logs does not show the Copy CTA", async () => {
  const { queryByText, findByText } = await render(<Diary />);
  await findByText("Grilled salmon"); // ensure render settled
  expect(queryByText("Copy from another day")).toBeNull();
});
