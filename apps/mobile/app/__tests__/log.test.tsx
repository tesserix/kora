import { fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";
import type { Memory } from "@/api/types";

jest.mock("expo-router", () => ({ router: { replace: jest.fn(), back: jest.fn() } }));

const mockLogMutate = jest.fn();
const mockBatchMutate = jest.fn();
const mockDeleteMutate = jest.fn();
let mockMemoryData: Memory = { recents: [], frequent: [], usual_meals: [] };
let mockMemoryIsLoading = false;
let mockMemoryIsError = false;

jest.mock("@/api/hooks", () => ({
  useFoodSearch: () => ({
    data: [
      {
        id: "f1",
        name: "Grilled chicken breast",
        brand: "",
        provenance: "seed",
        serving_desc: "1 breast",
        serving_grams: 140,
        kcal_per_100g: 165,
        protein_per_100g: 31,
        carbs_per_100g: 0,
        fat_per_100g: 3.6,
      },
    ],
    isLoading: false,
  }),
  useCreateLog: () => ({ mutate: mockLogMutate, isPending: false }),
  useCreateLogBatch: () => ({ mutate: mockBatchMutate, isPending: false }),
  useDeleteLog: () => ({ mutate: mockDeleteMutate }),
  useMemory: () => ({ data: mockMemoryData, isLoading: mockMemoryIsLoading, isError: mockMemoryIsError }),
}));

jest.mock("@/components/Toast", () => ({
  useToast: () => ({ show: (o: { onAction?: () => void }) => o.onAction?.() }),
}));

import LogScreen from "../log";

beforeEach(() => {
  mockLogMutate.mockClear();
  mockBatchMutate.mockClear();
  mockDeleteMutate.mockClear();
  mockMemoryData = { recents: [], frequent: [], usual_meals: [] };
  mockMemoryIsLoading = false;
  mockMemoryIsError = false;
});

test("Log screen shows the editorial header and a food tile result", async () => {
  const { findByText } = await render(<LogScreen />);
  expect(await findByText("Log food")).toBeTruthy();
  expect(await findByText("Grilled chicken breast")).toBeTruthy();
});

test("Log screen's search field renders the magnifyingglass glyph", async () => {
  const { findByTestId } = await render(<LogScreen />);
  expect(await findByTestId("sf-magnifyingglass")).toBeTruthy();
});

test("Log screen's back button exits the screen via router.back", async () => {
  const { findByLabelText } = await render(<LogScreen />);
  const backButton = await findByLabelText("Go back");
  fireEvent.press(backButton);
  expect(router.back).toHaveBeenCalledTimes(1);
});

test("tapping a recent food logs it instantly", async () => {
  mockMemoryData = {
    recents: [
      {
        food_item_id: "eggs-id",
        name: "Eggs",
        meal_slot: "breakfast",
        grams: 100,
        kcal: 155,
        protein_g: 13,
        carbs_g: 1,
        fat_g: 11,
        fiber_g: 0,
        count: 3,
        last_logged_at: "2026-07-20T08:00:00Z",
      },
    ],
    frequent: [],
    usual_meals: [],
  };
  const { findByText } = await render(<LogScreen />);
  fireEvent.press(await findByText("Eggs"));
  expect(mockLogMutate).toHaveBeenCalledWith(
    expect.objectContaining({ food_item_id: "eggs-id", quantity_grams: 100, meal_slot: "breakfast" }),
    expect.anything(),
  );
});

test("tapping a usual meal batch-logs its items", async () => {
  mockMemoryData = {
    recents: [],
    frequent: [],
    usual_meals: [
      {
        id: "m1",
        name: "Eggs & Oats",
        meal_slot: "breakfast",
        items: [
          {
            food_item_id: "eggs-id",
            name: "Eggs",
            meal_slot: "breakfast",
            grams: 100,
            kcal: 155,
            protein_g: 13,
            carbs_g: 1,
            fat_g: 11,
            fiber_g: 0,
            count: 3,
            last_logged_at: "2026-07-20T08:00:00Z",
          },
          {
            food_item_id: "oats-id",
            name: "Oats",
            meal_slot: "breakfast",
            grams: 60,
            kcal: 230,
            protein_g: 8,
            carbs_g: 40,
            fat_g: 4,
            fiber_g: 5,
            count: 3,
            last_logged_at: "2026-07-20T08:00:00Z",
          },
        ],
        kcal: 385,
        protein_g: 21,
        carbs_g: 41,
        fat_g: 15,
        fiber_g: 5,
        count: 3,
        last_logged_at: "2026-07-20T08:00:00Z",
      },
    ],
  };
  const { findByText, findByLabelText } = await render(<LogScreen />);
  fireEvent.press(await findByLabelText("Usual meals"));
  fireEvent.press(await findByText(/Eggs & Oats/));
  expect(mockBatchMutate).toHaveBeenCalledWith(
    expect.objectContaining({
      meal_slot: "breakfast",
      items: [
        { food_item_id: "eggs-id", quantity_grams: 100 },
        { food_item_id: "oats-id", quantity_grams: 60 },
      ],
    }),
    expect.anything(),
  );
});
