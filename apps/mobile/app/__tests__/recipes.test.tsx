import { fireEvent, render } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";
import type { Recipe } from "@/api/types";

import Recipes from "../recipes";
import RecipeDetail from "../recipe/[id]";

jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
  useLocalSearchParams: jest.fn(() => ({})),
}));

// Recipes now renders RecipeParseSheet, which reaches "@/lib/api" for
// ApiError — that module imports firebase/auth (real ESM), which Jest can't
// parse unmocked. See capture.test.tsx for the same mock, same reason.
jest.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    requestId?: string;
    constructor(status: number, code: string, message: string, requestId?: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.requestId = requestId;
      this.name = "ApiError";
    }
  },
}));

const mockUpdateMutate = jest.fn();
const mockDeleteMutate = jest.fn();
const mockCreateMutate = jest.fn();
const mockLogMutate = jest.fn();
const mockParseMutate = jest.fn();
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
  useParseRecipe: () => ({ mutate: mockParseMutate, isPending: false }),
  useFoodSearch: () => ({ data: mockFoodSearchResults(), isLoading: false, isError: false, isOfflineCache: false }),
}));

jest.mock("@/components/Toast", () => ({
  useToast: () => ({ show: mockToastShow }),
}));

// A food with NO serving size of its own — foodCache.foodFromServingSummary
// synthesises exactly this shape, so it is the common case, not an edge one.
const mysterySpice = {
  id: "f2",
  name: "Mystery spice",
  brand: "",
  provenance: "seed",
  serving_desc: "",
  serving_grams: 0,
  kcal_per_100g: 300,
  protein_per_100g: 10,
  carbs_per_100g: 50,
  fat_per_100g: 5,
};

let mockFoodItems = [chickenBreast];
function mockFoodSearchResults() {
  return mockFoodItems.map((item) => ({ item, match_score: 1, match_tier: "fulltext" }));
}

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
  mockParseMutate.mockClear();
  mockToastShow.mockClear();
  (router.push as jest.Mock).mockClear();
  (router.replace as jest.Mock).mockClear();
  (router.back as jest.Mock).mockClear();
  mockRecipesData = [];
  mockRecipeData = undefined;
  mockFoodItems = [chickenBreast];
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

// The "Paste"/"Photo" header actions were deliberate no-op stubs before this
// task wired them to the shared RecipeParseSheet — this pins that the tap
// actually opens something, closing the dead-affordance gap.
test("the Paste header action opens the parse-review sheet", async () => {
  mockRecipesData = [baseRecipe()];
  const { findByLabelText, findByText } = await render(<Recipes />);
  fireEvent.press(await findByLabelText("Paste"));
  expect(await findByText("Parse recipe")).toBeTruthy();
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
        // ZERO, not an arbitrary positive number: the server stores an
        // unresolved ingredient with no portion at all (it has no food to
        // measure against), and a fixture that invents grams here is what let
        // the unsaveable "Find a match" bug through.
        grams: 0,
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

// The regression test for the bug that made any recipe with one unmatchable
// ingredient permanently unsaveable: the match handler sent food_item_id with
// the stored grams of 0, and the server rejected every save with
// "grams must be positive". A portion has to travel with the match.
test("finding a match for an unresolved ingredient sends a positive portion, flagged as a guess", async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ id: "r1" });
  mockRecipeData = baseRecipe({
    unresolved_count: 1,
    ingredients: [
      {
        food_item_id: null,
        name: "",
        raw_text: "some mystery paste",
        resolved: false,
        grams: 0,
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
  const { findByLabelText } = await render(<RecipeDetail />);

  fireEvent.press(await findByLabelText("Find a match for some mystery paste"));
  fireEvent.press(await findByLabelText("Select Grilled chicken breast"));

  expect(mockUpdateMutate).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "r1",
      body: expect.objectContaining({
        ingredients: [
          expect.objectContaining({
            food_item_id: "f1",
            raw_text: "some mystery paste",
            // the matched food's own serving size, never a zero the API rejects
            grams: 140,
            portion_assumed: true,
          }),
        ],
      }),
    }),
    expect.anything(),
  );
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

// #138, the other direction: a figure the user typed by hand is a
// MEASUREMENT. Leaving portion_assumed set kept "PORTION IS A GUESS" over it
// forever, with no way to clear it.
test("editing an ingredient's amount clears the assumed-portion flag", async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ id: "r1" });
  const base = baseRecipe();
  mockRecipeData = baseRecipe({
    ingredients: [{ ...base.ingredients[0], portion_assumed: true }],
  });
  const { findByLabelText, findByText } = await render(<RecipeDetail />);

  fireEvent.press(await findByLabelText("Edit amount for Grilled chicken breast"));
  fireEvent.changeText(await findByLabelText("Amount"), "350");
  fireEvent.press(await findByText("Save"));

  expect(mockUpdateMutate).toHaveBeenCalledWith(
    expect.objectContaining({
      body: expect.objectContaining({
        ingredients: [expect.objectContaining({ grams: 350, portion_assumed: false })],
      }),
    }),
    expect.anything(),
  );
});

// #138 on the manual editor: serving_grams is 0 for any food without a real
// serving size, and the 100 g substituted for it is a system guess. Persisting
// it with portion_assumed false renders that guess as a measurement.
test("the manual editor flags a defaulted portion as a guess", async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ id: "new" });
  mockFoodItems = [mysterySpice];
  const { findByLabelText, findByText } = await render(<RecipeDetail />);

  fireEvent.changeText(await findByLabelText("Recipe name"), "Spice mix");
  fireEvent.press(await findByLabelText("Add ingredient"));
  // FoodPicker opens with an empty query in the manual editor and only
  // searches at 2+ characters.
  fireEvent.changeText(await findByLabelText("Search foods"), "spice");
  fireEvent.press(await findByLabelText("Select Mystery spice"));
  fireEvent.press(await findByText("Save recipe"));

  expect(mockCreateMutate).toHaveBeenCalledWith(
    expect.objectContaining({
      ingredients: [expect.objectContaining({ food_item_id: "f2", grams: 100, portion_assumed: true })],
    }),
    expect.anything(),
  );
});

// A food that carries a real serving size is a measurement, not a guess — the
// flag must not be set indiscriminately either.
test("the manual editor does not flag a food's own serving size as a guess", async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ id: "new" });
  const { findByLabelText, findByText } = await render(<RecipeDetail />);

  fireEvent.changeText(await findByLabelText("Recipe name"), "Chicken");
  fireEvent.press(await findByLabelText("Add ingredient"));
  fireEvent.changeText(await findByLabelText("Search foods"), "chicken");
  fireEvent.press(await findByLabelText("Select Grilled chicken breast"));
  fireEvent.press(await findByText("Save recipe"));

  expect(mockCreateMutate).toHaveBeenCalledWith(
    expect.objectContaining({
      ingredients: [expect.objectContaining({ grams: 140, portion_assumed: false })],
    }),
    expect.anything(),
  );
});

// Energy is not a mass. The per-serving card read "Kcal / 165 g".
test("per-serving calories are rendered in kcal, not grams", async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ id: "r1" });
  mockRecipeData = baseRecipe();
  const { findAllByText, queryAllByText } = await render(<RecipeDetail />);

  expect(await findAllByText("kcal")).toHaveLength(1);
  expect(queryAllByText("g")).toHaveLength(3); // protein, carbs, fat — and nothing else
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
