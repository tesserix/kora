import { fireEvent, render } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";
import type { Recipe } from "@/api/types";

jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
  useLocalSearchParams: jest.fn(() => ({})),
}));

const mockUpdateMutate = jest.fn();
const mockDeleteMutate = jest.fn();
const mockCreateMutate = jest.fn();
const mockLogMutate = jest.fn();
const mockToastShow = jest.fn();
let mockRecipesData: Recipe[] = [];
let mockRecipeData: Recipe | undefined;

const chickenBreast = {
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
};

jest.mock("@/api/hooks", () => ({
  useRecipes: () => ({ data: mockRecipesData, isLoading: false, isError: false }),
  useRecipe: () => ({ data: mockRecipeData, isLoading: false, isError: false }),
  useCreateRecipe: () => ({ mutate: mockCreateMutate, isPending: false }),
  useUpdateRecipe: () => ({ mutate: mockUpdateMutate, isPending: false }),
  useDeleteRecipe: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useLogRecipe: () => ({ mutate: mockLogMutate, isPending: false }),
  useFoodSearch: () => ({ data: [{ item: chickenBreast, match_score: 1, match_tier: "fulltext" }], isLoading: false, isError: false, isOfflineCache: false }),
}));

jest.mock("@/components/Toast", () => ({
  useToast: () => ({ show: mockToastShow }),
}));

import Recipes from "../recipes";
import RecipeDetail from "../recipe/[id]";

function baseRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: "r1",
    name: "Chicken Stir Fry",
    servings: 4,
    source: "manual",
    ingredients: [
      {
        food_item_id: "f1",
        name: "Grilled chicken breast",
        raw_text: "chicken breast",
        resolved: true,
        grams: 400,
        entered_amount: null,
        entered_unit: null,
        portion_assumed: false,
        match_score: 1,
        match_tier: "fulltext",
        kcal: 660,
        protein_g: 124,
        carbs_g: 0,
        fat_g: 14.4,
        fiber_g: 0,
      },
    ],
    unresolved_count: 0,
    total_kcal: 660,
    total_protein_g: 124,
    total_carbs_g: 0,
    total_fat_g: 14.4,
    total_fiber_g: 0,
    per_serving_kcal: 165,
    per_serving_protein_g: 31,
    per_serving_carbs_g: 0,
    per_serving_fat_g: 3.6,
    per_serving_fiber_g: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockUpdateMutate.mockClear();
  mockDeleteMutate.mockClear();
  mockCreateMutate.mockClear();
  mockLogMutate.mockClear();
  mockToastShow.mockClear();
  (router.push as jest.Mock).mockClear();
  (router.replace as jest.Mock).mockClear();
  (router.back as jest.Mock).mockClear();
  mockRecipesData = [];
  mockRecipeData = undefined;
  (useLocalSearchParams as jest.Mock).mockReturnValue({});
});

test("the list renders a recipe with its per-serving kcal", async () => {
  mockRecipesData = [baseRecipe()];
  const { findByText } = await render(<Recipes />);
  expect(await findByText("Chicken Stir Fry")).toBeTruthy();
  expect(await findByText("165 kcal")).toBeTruthy();
  expect(await findByText("makes 4")).toBeTruthy();
});

test('the list shows the "need attention" note when unresolved_count > 0', async () => {
  mockRecipesData = [baseRecipe({ unresolved_count: 2 })];
  const { findByText } = await render(<Recipes />);
  expect(await findByText(/2 need attention/)).toBeTruthy();
});

test("the empty state renders when there are no recipes", async () => {
  mockRecipesData = [];
  const { findByText } = await render(<Recipes />);
  expect(await findByText("No recipes yet")).toBeTruthy();
  expect(await findByText("Paste or photograph a recipe to reuse it.")).toBeTruthy();
});

test("the detail screen renders an unresolved ingredient as needing a match", async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ id: "r1" });
  mockRecipeData = baseRecipe({
    unresolved_count: 1,
    ingredients: [
      {
        food_item_id: null,
        name: "",
        raw_text: "some mystery paste",
        resolved: false,
        grams: 20,
        entered_amount: null,
        entered_unit: null,
        portion_assumed: false,
        match_score: null,
        match_tier: null,
        kcal: 0,
        protein_g: 0,
        carbs_g: 0,
        fat_g: 0,
        fiber_g: 0,
      },
    ],
  });
  const { findByText, findByLabelText } = await render(<RecipeDetail />);
  expect(await findByText("some mystery paste")).toBeTruthy();
  expect(await findByLabelText("Find a match for some mystery paste")).toBeTruthy();
});

test("the detail screen marks a portion_assumed ingredient as estimated", async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ id: "r1" });
  mockRecipeData = baseRecipe({
    ingredients: [
      {
        food_item_id: "f1",
        name: "Grilled chicken breast",
        raw_text: "chicken breast",
        resolved: true,
        grams: 400,
        entered_amount: null,
        entered_unit: null,
        portion_assumed: true,
        match_score: 1,
        match_tier: "fulltext",
        kcal: 660,
        protein_g: 124,
        carbs_g: 0,
        fat_g: 14.4,
        fiber_g: 0,
      },
    ],
  });
  const { findByText } = await render(<RecipeDetail />);
  expect(await findByText("portion is a guess")).toBeTruthy();
});

test("logging shows a toast naming skipped ingredients", async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ id: "r1" });
  mockRecipeData = baseRecipe();
  mockLogMutate.mockImplementation((_input, opts) => {
    opts.onSuccess({ logged: 1, skipped: ["some mystery paste"] });
  });
  const { findByLabelText, findByText } = await render(<RecipeDetail />);
  fireEvent.press(await findByLabelText("Log this recipe"));
  fireEvent.press(await findByText("Log it"));

  expect(mockLogMutate).toHaveBeenCalledWith(
    expect.objectContaining({ id: "r1", body: expect.objectContaining({ servings: 4, meal_slot: "lunch" }) }),
    expect.anything(),
  );
  expect(mockToastShow).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("some mystery paste") }),
  );
});

test("editing an ingredient's amount sends the full list with only that ingredient's grams changed", async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ id: "r1" });
  mockRecipeData = baseRecipe();
  const { findByLabelText, findByText } = await render(<RecipeDetail />);

  fireEvent.press(await findByLabelText("Edit amount for Grilled chicken breast"));
  fireEvent.changeText(await findByLabelText("Amount"), "350");
  fireEvent.press(await findByText("Save"));

  expect(mockUpdateMutate).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "r1",
      body: expect.objectContaining({
        servings: 4,
        ingredients: [
          expect.objectContaining({ food_item_id: "f1", raw_text: "chicken breast", grams: 350 }),
        ],
      }),
    }),
    expect.anything(),
  );
});

test("a failed mutation shows an error toast", async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ id: "r1" });
  mockRecipeData = baseRecipe();
  mockUpdateMutate.mockImplementation((_input, opts) => {
    opts.onError(new Error("network down"));
  });
  const { findByLabelText } = await render(<RecipeDetail />);
  fireEvent.press(await findByLabelText("Increase servings"));

  expect(mockToastShow).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.any(String) }),
  );
});
