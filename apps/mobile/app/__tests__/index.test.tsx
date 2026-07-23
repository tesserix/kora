import { render, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import Index from "../index";

jest.mock("@/lib/firebase", () => ({ auth: {}, isFirebaseConfigured: true }));
jest.mock("firebase/auth", () => ({
  onAuthStateChanged: jest.fn(() => jest.fn()),
  signOut: jest.fn(),
}));
jest.mock("expo-router", () => ({ router: { replace: jest.fn(), push: jest.fn() } }));

const profile = {
  id: "u1",
  email: "a@b.c",
  display_name: "Ada",
  goal: "maintenance",
  target_kcal: 2200,
  target_protein_g: 160,
  target_carbs_g: 220,
  target_fat_g: 70,
  onboarded_at: "2026-01-01T00:00:00.000Z",
};

const dashboard = {
  date: "2026-07-24",
  consumed: { kcal: 1850, protein_g: 142, carbs_g: 180, fat_g: 55, fiber_g: 12 },
  targets: { kcal: 2200, protein_g: 160, carbs_g: 220, fat_g: 70, fiber_g: 30 },
  water_ml: 500,
  streak_days: 3,
  source_counts: {},
};

const logs = [
  {
    id: "log1",
    logged_at: "2026-07-24T08:00:00.000Z",
    meal_slot: "breakfast",
    source: "manual",
    description: "Oatmeal",
    quantity_grams: 200,
    kcal: 300,
    protein_g: 10,
    carbs_g: 50,
    fat_g: 5,
    provenance: "afcd",
  },
];

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn((path: string) => {
    if (path.startsWith("/v1/me")) return Promise.resolve(profile);
    if (path.startsWith("/v1/dashboard")) return Promise.resolve(dashboard);
    if (path.startsWith("/v1/logs")) return Promise.resolve(logs);
    return Promise.resolve(null);
  }),
  ApiError: class extends Error {},
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("Index", () => {
  it("renders today's dashboard once data loads", async () => {
    const { getByText } = await render(<Index />, { wrapper });
    await waitFor(() => expect(getByText("1850")).toBeTruthy());
    expect(getByText("Protein")).toBeTruthy();
    expect(getByText("Oatmeal")).toBeTruthy();
  });
});
