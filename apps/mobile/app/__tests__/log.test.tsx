import { fireEvent, render } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";
import type { Memory, Recipe, SavedMeal } from "@/api/types";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
}));

// The Log screen now renders RecipeParseSheet, which reaches "@/lib/api" for
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

const mockLogMutate = jest.fn();
const mockBatchMutate = jest.fn();
const mockDeleteMutate = jest.fn();
const mockToggle = jest.fn();
const mockOpenCreate = jest.fn();
const mockOpenEdit = jest.fn();
const mockOpenBlank = jest.fn();
const mockParseMutate = jest.fn();
const mockCreateRecipeMutate = jest.fn();
const mockLogRecipeMutate = jest.fn();
let mockMemoryData: Memory = { recents: [], frequent: [], usual_meals: [] };
let mockMemoryIsLoading = false;
let mockMemoryIsError = false;
let mockPinsData: unknown[] = [];
let mockSavedMealsData: SavedMeal[] = [];
let mockRecipesData: Recipe[] = [];

const chickenCandidate = {
  item: {
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
  match_score: 1,
  match_tier: "fulltext",
};
let mockSearch: { data: unknown[]; isLoading: boolean; isOfflineCache: boolean } = {
  data: [chickenCandidate],
  isLoading: false,
  isOfflineCache: false,
};

jest.mock("@/api/hooks", () => ({
  useFoodSearch: () => mockSearch,
  useCreateLog: () => ({ mutate: mockLogMutate, isPending: false }),
  useCreateLogBatch: () => ({ mutate: mockBatchMutate, isPending: false }),
  useDeleteLog: () => ({ mutate: mockDeleteMutate }),
  useMemory: () => ({ data: mockMemoryData, isLoading: mockMemoryIsLoading, isError: mockMemoryIsError }),
  usePins: () => ({ data: mockPinsData }),
  useSavedMeals: () => ({ data: mockSavedMealsData }),
  useRecipes: () => ({ data: mockRecipesData }),
  useParseRecipe: () => ({ mutate: mockParseMutate, isPending: false }),
  useCreateRecipe: () => ({ mutate: mockCreateRecipeMutate, isPending: false }),
  useLogRecipe: () => ({ mutate: mockLogRecipeMutate, isPending: false }),
}));

jest.mock("@/api/usePinToggle", () => ({
  usePinToggle: () => ({ pinnedIds: new Set(), toggle: mockToggle }),
}));

jest.mock("@/components/meals/SavedMealSheetProvider", () => ({
  useSavedMealEditor: () => ({ openCreate: mockOpenCreate, openEdit: mockOpenEdit, openBlank: mockOpenBlank }),
}));

jest.mock("@/components/Toast", () => ({
  useToast: () => ({ show: (o: { onAction?: () => void }) => o.onAction?.() }),
}));

import LogScreen from "../log";

beforeEach(() => {
  mockLogMutate.mockClear();
  mockBatchMutate.mockClear();
  mockDeleteMutate.mockClear();
  mockToggle.mockClear();
  mockOpenCreate.mockClear();
  mockOpenEdit.mockClear();
  mockOpenBlank.mockClear();
  mockParseMutate.mockClear();
  mockCreateRecipeMutate.mockClear();
  mockLogRecipeMutate.mockClear();
  mockSearch = { data: [chickenCandidate], isLoading: false, isOfflineCache: false };
  mockMemoryData = { recents: [], frequent: [], usual_meals: [] };
  mockMemoryIsLoading = false;
  mockMemoryIsError = false;
  mockPinsData = [];
  mockSavedMealsData = [];
  mockRecipesData = [];
  (useLocalSearchParams as jest.Mock).mockReturnValue({});
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

// A failed capture's "Log it manually" seeds this screen with the capture's
// OWN time via a `loggedAt` route param (app/capture-review.tsx) — never
// the moment the user gets around to finishing the manual log. This is the
// same #84-adjacent invariant the automatic confirm path enforces.
test("logging from a seeded route stamps the SEEDED time, not now", async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ loggedAt: "2026-08-06T06:30:00.000Z" });
  const { findByText } = await render(<LogScreen />);
  fireEvent.press(await findByText("Grilled chicken breast"));
  fireEvent.press(await findByText("Log it"));

  expect(mockLogMutate).toHaveBeenCalledWith(
    expect.objectContaining({ logged_at: "2026-08-06T06:30:00.000Z" }),
    expect.anything(),
  );
});

// The food-memory tabs carry two independent axes — food vs meal, and chosen
// vs inferred — and a single five-segment row labelled neither. That made every
// adjacent pair read as a synonym ("Pinned" vs "Saved", "Frequent" vs "Usual")
// when they in fact differ on the unlabelled axis. Splitting the axes puts the
// food/meal distinction in the tier above, where it is stated rather than
// implied.
test("splits the memory tabs into a Foods tier and a Meals tier", async () => {
  const { findByLabelText, queryByLabelText } = await render(<LogScreen />);
  expect(await findByLabelText("Foods")).toBeTruthy();
  expect(await findByLabelText("Meals")).toBeTruthy();

  // Foods is the default tier: its three tabs are reachable, the meal tabs are not.
  expect(await findByLabelText("Recents")).toBeTruthy();
  expect(await findByLabelText("Frequent")).toBeTruthy();
  expect(await findByLabelText("Pinned")).toBeTruthy();
  expect(queryByLabelText("Saved")).toBeNull();
  expect(queryByLabelText("Combos")).toBeNull();
});

test("switching to the Meals tier swaps in the meal tabs and hides the food tabs", async () => {
  const { findByLabelText, queryByLabelText } = await render(<LogScreen />);
  fireEvent.press(await findByLabelText("Meals"));

  expect(await findByLabelText("Saved")).toBeTruthy();
  expect(await findByLabelText("Combos")).toBeTruthy();
  expect(queryByLabelText("Recents")).toBeNull();
  expect(queryByLabelText("Frequent")).toBeNull();
  expect(queryByLabelText("Pinned")).toBeNull();
});

// Switching tiers must land on a tab that belongs to the tier. Leaving memTab
// pointing at the old tier's selection would render a meal list under Foods.
test("switching tiers selects that tier's first tab", async () => {
  mockSavedMealsData = [];
  const { findByLabelText, findByText } = await render(<LogScreen />);

  // Assert on content unique to each tier's first tab: "+ New meal" belongs to
  // Saved, and the recents empty state to Recents. The tab labels themselves
  // are ambiguous — "Saved" is also the section's Overline heading.
  fireEvent.press(await findByLabelText("Meals"));
  expect(await findByText("+ New meal")).toBeTruthy();

  fireEvent.press(await findByLabelText("Foods"));
  expect(await findByText("Log a few meals and they'll show up here.")).toBeTruthy();
});

test("shows a loading state while memory is fetching", async () => {
  mockMemoryIsLoading = true;
  const { findByText } = await render(<LogScreen />);
  expect(await findByText("Loading…")).toBeTruthy();
});

test("shows an error state when memory fails to load", async () => {
  mockMemoryIsLoading = false;
  mockMemoryIsError = true;
  const { findByText } = await render(<LogScreen />);
  expect(await findByText("Couldn't load your foods.")).toBeTruthy();
});

test("shows an empty state on the Recents tab when memory has no data", async () => {
  mockMemoryData = { recents: [], frequent: [], usual_meals: [] };
  mockMemoryIsLoading = false;
  mockMemoryIsError = false;
  const { findByText } = await render(<LogScreen />);
  expect(await findByText("Log a few meals and they'll show up here.")).toBeTruthy();
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
  fireEvent.press(await findByLabelText("Meals"));
  fireEvent.press(await findByLabelText("Combos"));
  fireEvent.press(await findByText(/Eggs & Oats/));
  expect(mockBatchMutate).toHaveBeenCalledWith(
    expect.objectContaining({
      meal_slot: "breakfast",
      items: [
        { food_item_id: "eggs-id", quantity_grams: 100, entered_amount: null, entered_unit: null },
        { food_item_id: "oats-id", quantity_grams: 60, entered_amount: null, entered_unit: null },
      ],
    }),
    expect.anything(),
  );
});

test("Pinned tab shows a pinned food", async () => {
  mockPinsData = [
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
    },
  ];
  const { findByText, findByLabelText } = await render(<LogScreen />);
  fireEvent.press(await findByLabelText("Pinned"));
  expect(await findByText("Eggs")).toBeTruthy();
});

test("Saved tab shows a saved meal", async () => {
  mockSavedMealsData = [
    {
      id: "sm1",
      name: "Protein Bowl",
      meal_slot: "lunch",
      items: [
        {
          food_item_id: "chicken-id",
          name: "Chicken",
          grams: 150,
          kcal: 250,
          protein_g: 40,
          carbs_g: 0,
          fat_g: 8,
          fiber_g: 0,
        },
      ],
      kcal: 250,
      protein_g: 40,
      carbs_g: 0,
      fat_g: 8,
      fiber_g: 0,
    },
  ];
  const { findByText, findByLabelText } = await render(<LogScreen />);
  fireEvent.press(await findByLabelText("Meals"));
  fireEvent.press(await findByLabelText("Saved"));
  expect(await findByText("Protein Bowl")).toBeTruthy();
});

// Closes the reachability gap this task exists for: before it, nothing in
// the app linked to a recipe at all. The Recipes tab is the in-app entry
// point — both browsing a recipe to log it, and starting a new one.
test("Recipes tab shows a recipe and logs it via LogRecipeSheet", async () => {
  mockRecipesData = [
    {
      id: "r1",
      name: "Chicken Stir Fry",
      servings: 4,
      source: "manual",
      ingredients: [],
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
    },
  ];
  const { findByText, findByLabelText } = await render(<LogScreen />);
  fireEvent.press(await findByLabelText("Meals"));
  fireEvent.press(await findByLabelText("Recipes"));
  fireEvent.press(await findByText("Chicken Stir Fry"));

  fireEvent.press(await findByText("Log it"));
  expect(mockLogRecipeMutate).toHaveBeenCalledWith(
    expect.objectContaining({ id: "r1", body: expect.objectContaining({ servings: 4 }) }),
    expect.anything(),
  );
});

test("the Recipes tab's + New recipe opens the parse-review sheet", async () => {
  const { findByLabelText, findByText } = await render(<LogScreen />);
  fireEvent.press(await findByLabelText("Meals"));
  fireEvent.press(await findByLabelText("Recipes"));
  fireEvent.press(await findByText("+ New recipe"));

  expect(await findByText("Parse recipe")).toBeTruthy();
});

test("the log screen can start a new meal from scratch", async () => {
  const { findByLabelText } = await render(<LogScreen />);

  fireEvent.press(await findByLabelText("Meals"));
  fireEvent.press(await findByLabelText("Saved"));
  const newMealButton = await findByLabelText("New meal");
  fireEvent.press(newMealButton);

  expect(mockOpenBlank).toHaveBeenCalled();
});


// --- Offline manual search -------------------------------------------------
//
// Search falls back to the offline food cache (useFoodSearch), so results can
// arrive with no network. Those results are a genuinely narrower thing than a
// server search — only foods this device has already seen — and the screen has
// to say so, or the user reads a short list as "the index barely has anything".

async function typeSearch(ui: Awaited<ReturnType<typeof render>>, term: string) {
  await fireEvent.changeText(ui.getByLabelText("Search foods"), term);
}

test("offline results say they are limited to foods already logged", async () => {
  mockSearch = { data: [chickenCandidate], isLoading: false, isOfflineCache: true };
  const ui = await render(<LogScreen />);
  await typeSearch(ui, "chicken");

  expect(ui.getByText(/offline/i)).toBeTruthy();
  expect(ui.getByText(/logged before/i)).toBeTruthy();
  // The result itself still renders and stays selectable.
  expect(ui.getByText("Grilled chicken breast")).toBeTruthy();
});

test("an offline search with no cached match explains why, instead of 'No matches.'", async () => {
  mockSearch = { data: [], isLoading: false, isOfflineCache: true };
  const ui = await render(<LogScreen />);
  await typeSearch(ui, "sushi");

  // "No matches." asserts the food does not exist. Offline we simply cannot
  // see the index — a different claim, and the only honest one.
  expect(ui.queryByText("No matches.")).toBeNull();
  expect(ui.getByText(/offline/i)).toBeTruthy();
});

test("an ONLINE search with no results still says plainly that nothing matched", async () => {
  mockSearch = { data: [], isLoading: false, isOfflineCache: false };
  const ui = await render(<LogScreen />);
  await typeSearch(ui, "sushi");

  expect(ui.getByText("No matches.")).toBeTruthy();
  expect(ui.queryByText(/offline/i)).toBeNull();
});

const mochaCandidate = {
  item: {
    id: "f2",
    name: "NESCAFÉ Mocha",
    brand: "Nestlé",
    provenance: "off",
    serving_desc: "1 portion (16.5 g)",
    serving_grams: 16.5,
    base_unit: "g",
    serving_units: [{ name: "portion", amount: 1, base_amount: 16.5 }],
    kcal_per_100g: 545,
    protein_per_100g: 9,
    carbs_per_100g: 70,
    fat_per_100g: 25,
  },
  match_score: 1,
  match_tier: "fulltext",
};

const milkCandidate = {
  item: {
    id: "f3",
    name: "High protein low fat milk",
    brand: "",
    provenance: "off",
    serving_desc: "",
    serving_grams: 250,
    base_unit: "ml",
    kcal_per_100g: 52,
    protein_per_100g: 5.6,
    carbs_per_100g: 5,
    fat_per_100g: 0.4,
  },
  match_score: 1,
  match_tier: "fulltext",
};

// The spec's default state for a food with a named serving is a stepper
// reading "1 portion (16.5 g)". Opening in exact mode instead put the
// serving's GRAM figure in the field, one chip-tap away from being reread as
// a serving count.
test("selecting a food with a named serving opens on that serving, not raw grams", async () => {
  mockSearch = { data: [mochaCandidate], isLoading: false, isOfflineCache: false };
  const { findByText } = await render(<LogScreen />);
  fireEvent.press(await findByText("NESCAFÉ Mocha"));

  expect(await findByText("1 portion (16.5 g)")).toBeTruthy();

  fireEvent.press(await findByText("Log it"));
  expect(mockLogMutate).toHaveBeenCalledWith(
    expect.objectContaining({ food_item_id: "f2", entered_amount: 1, entered_unit: "portion" }),
    expect.anything(),
  );
});

// Weet-Bix's label reads "2 biscuits (30g)", and units.Parse normalises that
// to {biscuit, amount 1, base_amount 15} so the unit describes ONE biscuit.
// Seeding the stepper from the unit's own `amount` opened on "1 biscuit
// (15 g)" — half the label serving — while the macro card kept showing
// serving_grams (30 g). The user read one portion's macros and logged half.
const weetbixCandidate = {
  item: {
    id: "f4",
    name: "Weet-Bix",
    brand: "Sanitarium",
    provenance: "off",
    serving_desc: "2 biscuits (30g)",
    serving_grams: 30,
    base_unit: "g",
    serving_units: [{ name: "biscuit", amount: 1, base_amount: 15 }],
    kcal_per_100g: 349,
    protein_per_100g: 12,
    carbs_per_100g: 67,
    fat_per_100g: 1.3,
  },
  match_score: 1,
  match_tier: "fulltext",
};

test("a multi-count label opens on the whole label serving, not half of it", async () => {
  mockSearch = { data: [weetbixCandidate], isLoading: false, isOfflineCache: false };
  const { findByText } = await render(<LogScreen />);
  fireEvent.press(await findByText("Weet-Bix"));

  expect(await findByText("2 biscuits (30 g)")).toBeTruthy();

  fireEvent.press(await findByText("Log it"));
  expect(mockLogMutate).toHaveBeenCalledWith(
    expect.objectContaining({ food_item_id: "f4", entered_amount: 2, entered_unit: "biscuit" }),
    expect.anything(),
  );
});

test("the macro preview describes the same portion the entry will log", async () => {
  mockSearch = { data: [weetbixCandidate], isLoading: false, isOfflineCache: false };
  const { findByText, getByText, getByLabelText } = await render(<LogScreen />);
  fireEvent.press(await findByText("Weet-Bix"));

  // 2 biscuits is 30 g: protein 12 × 0.30 = 3.6 → 4. Half a portion would
  // have shown 2, and half a portion is what used to be logged.
  expect(await findByText("2 biscuits (30 g)")).toBeTruthy();
  expect(getByText("4")).toBeTruthy();

  // Stepping the count must not let the two drift apart either: 3 biscuits is
  // 45 g, protein 12 × 0.45 = 5.4 → 5.
  fireEvent.press(getByLabelText("Increase amount"));
  expect(await findByText("3 biscuits (45 g)")).toBeTruthy();
  expect(getByText("5")).toBeTruthy();
});

test("a serving count that is not a clean integer falls back to one serving", async () => {
  // 40 g of serving against a 15 g biscuit is 2.67 biscuits — not a count a
  // stepper can honestly show, so it opens on one rather than a fraction.
  const odd = {
    ...weetbixCandidate,
    item: { ...weetbixCandidate.item, id: "f5", name: "Odd biscuits", serving_grams: 40 },
  };
  mockSearch = { data: [odd], isLoading: false, isOfflineCache: false };
  const { findByText } = await render(<LogScreen />);
  fireEvent.press(await findByText("Odd biscuits"));

  expect(await findByText("1 biscuit (15 g)")).toBeTruthy();

  fireEvent.press(await findByText("Log it"));
  expect(mockLogMutate).toHaveBeenCalledWith(
    expect.objectContaining({ food_item_id: "f5", entered_amount: 1, entered_unit: "biscuit" }),
    expect.anything(),
  );
});

// A millilitre-based food entered in its own base unit must still report the
// unit. Nulling the entered pair because "the unit equals the base unit"
// stored 300 ml as bare grams, and the diary then read it back as "300 g".
test("an amount entered in millilitres is sent as a unit, not as bare grams", async () => {
  mockSearch = { data: [milkCandidate], isLoading: false, isOfflineCache: false };
  const { findByText, findByLabelText } = await render(<LogScreen />);
  fireEvent.press(await findByText("High protein low fat milk"));

  fireEvent.changeText(await findByLabelText("Amount"), "300");
  fireEvent.press(await findByText("Log it"));

  expect(mockLogMutate).toHaveBeenCalledWith(
    expect.objectContaining({ food_item_id: "f3", entered_amount: 300, entered_unit: "ml", quantity_grams: 0 }),
    expect.anything(),
  );
});
