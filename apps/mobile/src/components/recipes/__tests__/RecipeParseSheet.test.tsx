import { fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";
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

const mockParseMutate = jest.fn();
const mockCreateMutate = jest.fn();
const mockToastShow = jest.fn();

jest.mock("@/api/hooks", () => ({
  useParseRecipe: () => ({ mutate: mockParseMutate, isPending: false }),
  useCreateRecipe: () => ({ mutate: mockCreateMutate, isPending: false }),
  useFoodSearch: () => ({ data: [], isLoading: false, isError: false, isOfflineCache: false }),
}));

jest.mock("@/offline/foodCache", () => ({
  getFoodById: jest.fn(async () => null),
}));

jest.mock("@/components/Toast", () => ({
  useToast: () => ({ show: mockToastShow }),
}));

import { RecipeParseSheet } from "../RecipeParseSheet";

// One resolved ingredient, one unresolved, one portion_assumed — covers all
// three row states the review stage renders in a single successful parse.
const draft: RecipeDraft = {
  name: "Omelette",
  servings: 2,
  source: "paste",
  ingredients: [
    {
      food_item_id: "egg-id",
      raw_text: "eggs",
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

  expect(await findByText("eggs")).toBeTruthy();
  expect(await findByText("mystery spice")).toBeTruthy();
  expect(await findByText("butter")).toBeTruthy();
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

test("a 502 parse failure opens the manual editor rather than an error dead end", async () => {
  mockParseMutate.mockImplementation((_input, { onError }) =>
    onError(new ApiError(502, "parse_failed", "could not parse")),
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

test("saving posts the edited draft to /v1/recipes", async () => {
  mockParseMutate.mockImplementation((_input, { onSuccess }) => onSuccess(draft));
  mockCreateMutate.mockImplementation((body, { onSuccess }) =>
    onSuccess({ id: "r1", ...body, unresolved_count: 0 }),
  );
  const { findByLabelText, findByText } = await render(<RecipeParseSheet visible onClose={() => {}} />);
  fireEvent.changeText(await findByLabelText("Paste recipe text"), "2 eggs, butter");
  fireEvent.press(await findByText("Parse recipe"));
  await findByText("eggs");

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
