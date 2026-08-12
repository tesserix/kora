import { fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { ApiError } from "@/lib/api";
import type { RecipeDraft } from "@/api/types";

jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

// The real "@/lib/api" pulls in firebase/auth (real ESM), which Jest cannot
// parse unmocked — every other test that reaches @/lib/api (directly or via
// a component under test) mocks it for exactly this reason. Only ApiError is
// needed here: it's the type RecipeParseSheet's error handling narrows on to
// route a parse_failed 502 into the fallback draft instead of a toast.
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

// A food with NO serving size of its own, which is what
// foodCache.foodFromServingSummary synthesises — the case where a portion has
// to be guessed rather than measured.
const mysterySpiceFood = {
  id: "spice-id",
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
let mockFoodResults: { item: typeof mysterySpiceFood; match_score: number; match_tier: string }[] = [];

const mockParseMutate = jest.fn();
const mockCreateMutate = jest.fn();
const mockToastShow = jest.fn();

jest.mock("@/api/hooks", () => ({
  useParseRecipe: () => ({ mutate: mockParseMutate, isPending: false }),
  useCreateRecipe: () => ({ mutate: mockCreateMutate, isPending: false }),
  useFoodSearch: () => ({ data: mockFoodResults, isLoading: false, isError: false, isOfflineCache: false }),
}));

jest.mock("@/components/Toast", () => ({
  useToast: () => ({ show: mockToastShow }),
}));

import { RecipeParseSheet } from "../RecipeParseSheet";

// One resolved ingredient, one unresolved, one portion_assumed — covers all
// three row states the review stage renders in a single successful parse.
// The resolved ingredients' `name` is deliberately DIFFERENT from their
// `raw_text` (mirroring what the server actually sends: `name` is the
// matched food's own canonical name, `raw_text` is the phrase that was
// searched for) so a test asserting on `name` actually proves the row reads
// the server-populated field rather than just echoing raw_text back.
const draft: RecipeDraft = {
  name: "Omelette",
  servings: 2,
  source: "paste",
  ingredients: [
    {
      food_item_id: "egg-id",
      raw_text: "eggs",
      name: "Free Range Eggs",
      grams: 100,
      entered_amount: null,
      entered_unit: null,
      portion_assumed: false,
      match_score: 1,
      match_tier: "fulltext",
    },
    {
      food_item_id: null,
      raw_text: "mystery spice",
      grams: 5,
      entered_amount: null,
      entered_unit: null,
      portion_assumed: false,
      match_score: null,
      match_tier: null,
    },
    {
      food_item_id: "butter-id",
      raw_text: "butter",
      name: "Salted Butter",
      grams: 10,
      entered_amount: null,
      entered_unit: null,
      portion_assumed: true,
      match_score: 1,
      match_tier: "fulltext",
    },
  ],
};

beforeEach(() => {
  mockFoodResults = [];
  mockParseMutate.mockClear();
  mockCreateMutate.mockClear();
  mockToastShow.mockClear();
  (router.push as jest.Mock).mockClear();
});

test("pasting text and submitting calls the parse endpoint", async () => {
  const { findByLabelText, findByText } = await render(<RecipeParseSheet visible onClose={() => {}} />);
  fireEvent.changeText(await findByLabelText("Paste recipe text"), "2 eggs, butter");
  fireEvent.press(await findByText("Parse recipe"));

  expect(mockParseMutate).toHaveBeenCalledWith({ text: "2 eggs, butter" }, expect.anything());
});

test("a successful parse renders each extracted ingredient", async () => {
  mockParseMutate.mockImplementation((_input, { onSuccess }) => onSuccess(draft));
  const { findByLabelText, findByText } = await render(<RecipeParseSheet visible onClose={() => {}} />);
  fireEvent.changeText(await findByLabelText("Paste recipe text"), "2 eggs, butter");
  fireEvent.press(await findByText("Parse recipe"));

  expect(await findByText("mystery spice")).toBeTruthy();
  // Resolved rows label with a matched food's name, not the search phrase.
  expect(await findByText("Free Range Eggs")).toBeTruthy();
  expect(await findByText("Salted Butter")).toBeTruthy();
});

// The whole point of a confirmation row is showing both what was read AND
// what it matched to — a resolved row that only ever showed one of the two
// (either the search phrase, forever, or the matched name with no way to
// see what it was matched FROM) would make the confirmation meaningless.
test("a resolved ingredient shows the matched name AND what it was matched from", async () => {
  mockParseMutate.mockImplementation((_input, { onSuccess }) => onSuccess(draft));
  const { findByLabelText, findByText } = await render(<RecipeParseSheet visible onClose={() => {}} />);
  fireEvent.changeText(await findByLabelText("Paste recipe text"), "2 eggs, butter");
  fireEvent.press(await findByText("Parse recipe"));

  expect(await findByText("Free Range Eggs")).toBeTruthy();
  expect(await findByText('Matched from "eggs"')).toBeTruthy();
});

test("an unresolved ingredient is marked as needing a match", async () => {
  mockParseMutate.mockImplementation((_input, { onSuccess }) => onSuccess(draft));
  const { findByLabelText, findByText } = await render(<RecipeParseSheet visible onClose={() => {}} />);
  fireEvent.changeText(await findByLabelText("Paste recipe text"), "2 eggs, butter");
  fireEvent.press(await findByText("Parse recipe"));

  expect(await findByText("needs a match")).toBeTruthy();
  expect(await findByLabelText("Find a match for mystery spice")).toBeTruthy();
});

test("a portion_assumed ingredient is marked estimated", async () => {
  mockParseMutate.mockImplementation((_input, { onSuccess }) => onSuccess(draft));
  const { findByLabelText, findByText } = await render(<RecipeParseSheet visible onClose={() => {}} />);
  fireEvent.changeText(await findByLabelText("Paste recipe text"), "2 eggs, butter");
  fireEvent.press(await findByText("Parse recipe"));

  expect(await findByText("portion is a guess")).toBeTruthy();
});

// Deliberately does NOT set code to "parse_failed" here — a real 502 from
// this endpoint doesn't reliably carry it. throwApiError (src/lib/api.ts)
// derives `code` by JSON-parsing the response body and reading its `error`
// field, falling back to the literal string "unknown" the instant that
// parse fails (a proxy/gateway hop mangling the body, a body that never
// fully arrives, ...) — `status` is read off the response line and survives
// all of that. An earlier version of both this test AND RecipeParseSheet
// keyed detection off `code === "parse_failed"`, which is exactly why a real
// on-device 502 fell through to nothing: the mock always handed the
// component a clean "parse_failed" code that production could not
// guarantee. Keying off `status === 502` (what production now does) is what
// this test must prove holds even when `code` is the unhelpful "unknown".
test("a 502 parse failure opens the manual editor rather than an error dead end", async () => {
  mockParseMutate.mockImplementation((_input, { onError }) =>
    onError(new ApiError(502, "unknown", "could not parse")),
  );
  const { findByLabelText, findByText } = await render(<RecipeParseSheet visible onClose={() => {}} />);
  fireEvent.changeText(await findByLabelText("Paste recipe text"), "an unreadable mess of a recipe");
  fireEvent.press(await findByText("Parse recipe"));

  // The pasted text survives as a single unresolved ingredient, plus an
  // explanation — never a bare error with no way forward.
  expect(await findByText("an unreadable mess of a recipe")).toBeTruthy();
  expect(await findByText("needs a match")).toBeTruthy();
  expect(await findByText(/couldn't read that automatically/i)).toBeTruthy();
  // And it really is the editable draft, not a dead end: a name field and a
  // save action are both present.
  expect(await findByText("Save recipe")).toBeTruthy();
});

// A 429 budget_exhausted parse error must land in the SAME manual-editor
// review stage a 502 reaches, but with its OWN notice copy naming the AI
// limit specifically — a 502 is a parse failure (we tried and failed), a 429
// is a budget exhaustion (we never tried this month's AI call at all). The
// server's own message text (api/internal/recipes/handler.go) is what the
// endpoint actually sends; this test uses it for realism, though the
// component's fallback notice is its own copy, not this message.
test("a 429 budget-exhausted parse error opens the manual editor with limit-specific copy", async () => {
  mockParseMutate.mockImplementation((_input, { onError }) =>
    onError(
      new ApiError(
        429,
        "budget_exhausted",
        "You've reached your AI limit this month — enter the recipe manually",
      ),
    ),
  );
  const { findByLabelText, findByText, queryByText } = await render(
    <RecipeParseSheet visible onClose={() => {}} />,
  );
  fireEvent.changeText(await findByLabelText("Paste recipe text"), "an unreadable mess of a recipe");
  fireEvent.press(await findByText("Parse recipe"));

  // The pasted text survives as a single unresolved ingredient, plus an
  // explanation naming the AI limit — never a bare error with no way forward.
  expect(await findByText("an unreadable mess of a recipe")).toBeTruthy();
  expect(await findByText("needs a match")).toBeTruthy();
  expect(await findByText(/reached your AI limit this month/i)).toBeTruthy();
  // Distinct from the 502 notice — an assertion mixup between the two tests
  // must not be able to pass by accident.
  expect(queryByText(/couldn't read that automatically/i)).toBeNull();
  // And it really is the editable draft, not a dead end: a save action is
  // present.
  expect(await findByText("Save recipe")).toBeTruthy();
});

// The no-pasted-text case (a photo parse — there is no user text to fall
// back on) must NOT reuse the 502 placeholder ("Couldn't read this recipe")
// for a 429: that copy asserts a read failure, which is exactly backwards
// when the real reason is budget exhaustion, not a bad read. See
// fallbackIngredient's own comment in RecipeParseSheet.tsx.
test("a 429 budget-exhausted photo parse seeds a budget-specific placeholder row, not a read-failure one", async () => {
  (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri: "file://recipe.jpg", fileName: "recipe.jpg", mimeType: "image/jpeg" }],
  });
  mockParseMutate.mockImplementation((_input, { onError }) =>
    onError(
      new ApiError(
        429,
        "budget_exhausted",
        "You've reached your AI limit this month — enter the recipe manually",
      ),
    ),
  );
  const { findByText, queryByText } = await render(
    <RecipeParseSheet visible onClose={() => {}} initialMode="photo" />,
  );
  fireEvent.press(await findByText("Choose photo"));

  expect(await findByText("AI limit reached — add this ingredient manually")).toBeTruthy();
  expect(queryByText("Couldn't read this recipe")).toBeNull();
});

// A status other than 502 or 429 must NOT be routed into the manual-editor
// fallback, even if it happens to carry the "parse_failed" code (it never
// legitimately would, but this pins that detection is keyed off `status`,
// not `code`).
test("a non-502 ApiError toasts instead of opening the manual editor", async () => {
  mockParseMutate.mockImplementation((_input, { onError }) =>
    onError(new ApiError(500, "parse_failed", "internal error")),
  );
  const { findByLabelText, findByText } = await render(<RecipeParseSheet visible onClose={() => {}} />);
  fireEvent.changeText(await findByLabelText("Paste recipe text"), "2 eggs, butter");
  fireEvent.press(await findByText("Parse recipe"));

  expect(mockToastShow).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
});

test("saving posts the edited draft to /v1/recipes", async () => {
  mockParseMutate.mockImplementation((_input, { onSuccess }) => onSuccess(draft));
  mockCreateMutate.mockImplementation((body, { onSuccess }) =>
    onSuccess({ id: "r1", ...body, unresolved_count: 0 }),
  );
  const { findByLabelText, findByText } = await render(<RecipeParseSheet visible onClose={() => {}} />);
  fireEvent.changeText(await findByLabelText("Paste recipe text"), "2 eggs, butter");
  fireEvent.press(await findByText("Parse recipe"));
  await findByText("Free Range Eggs");

  fireEvent.press(await findByText("Save recipe"));

  expect(mockCreateMutate).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Omelette",
      servings: 2,
      source: "paste",
      ingredients: draft.ingredients,
    }),
    expect.anything(),
  );
  expect(router.push).toHaveBeenCalledWith("/recipe/r1");
});

test("a genuine parse error (not parse_failed) toasts instead of opening a dead end", async () => {
  mockParseMutate.mockImplementation((_input, { onError }) => onError(new Error("network down")));
  const { findByLabelText, findByText } = await render(<RecipeParseSheet visible onClose={() => {}} />);
  fireEvent.changeText(await findByLabelText("Paste recipe text"), "2 eggs, butter");
  fireEvent.press(await findByText("Parse recipe"));

  expect(mockToastShow).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
});

// The 502 fallback and every unresolved parse row carry grams 0 — the server
// has no food to measure them against. Matching a food therefore has to supply
// a portion too, or the save the fallback exists to enable is rejected by the
// API with "grams must be positive" and the "never a dead end" guarantee
// becomes a dead end in the other direction.
test("matching a food for the 502 fallback row makes the draft saveable", async () => {
  mockFoodResults = [{ item: mysterySpiceFood, match_score: 1, match_tier: "fulltext" }];
  mockParseMutate.mockImplementation((_input, { onError }) =>
    onError(new ApiError(502, "unknown", "could not parse")),
  );
  mockCreateMutate.mockImplementation((body, { onSuccess }) => onSuccess({ id: "r9", ...body }));

  const { findByLabelText, findByText } = await render(<RecipeParseSheet visible onClose={() => {}} />);
  fireEvent.changeText(await findByLabelText("Paste recipe text"), "an unreadable mess");
  fireEvent.press(await findByText("Parse recipe"));

  fireEvent.press(await findByLabelText("Find a match for an unreadable mess"));
  fireEvent.press(await findByLabelText("Select Mystery spice"));
  fireEvent.press(await findByText("Save recipe"));

  expect(mockCreateMutate).toHaveBeenCalledWith(
    expect.objectContaining({
      ingredients: [
        expect.objectContaining({
          food_item_id: "spice-id",
          grams: 100, // the flat estimate; a zero here is a 400 from the API
          portion_assumed: true,
        }),
      ],
    }),
    expect.anything(),
  );
});
