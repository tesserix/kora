import { render } from "@testing-library/react-native";
import { FoodPicker } from "../FoodPicker";

// useFoodSearch's own `enabled: q.length >= 2` guard is what actually stops
// the fetch, so a query-argument assertion is what proves the fix — not a
// network spy, which the real hook mock never hits anyway.
const mockUseFoodSearch = jest.fn((_q: string) => ({ data: [], isLoading: false, isError: false }));

jest.mock("@/api/hooks", () => ({
  useFoodSearch: (q: string) => mockUseFoodSearch(q),
}));

beforeEach(() => {
  mockUseFoodSearch.mockClear();
});

test("stays closed without ever handing useFoodSearch a fetch-triggering query", async () => {
  // initialQuery is long enough on its own (>= 2 chars) to pass the hook's
  // guard, so this is only safe if FoodPicker withholds it while closed.
  await render(
    <FoodPicker visible={false} initialQuery="Brown rice" onSelect={jest.fn()} onClose={jest.fn()} />,
  );

  expect(mockUseFoodSearch).toHaveBeenCalled();
  for (const [query] of mockUseFoodSearch.mock.calls) {
    expect(query.length).toBeLessThan(2);
  }
});

test("queries with the real text once the picker opens", async () => {
  await render(
    <FoodPicker visible onSelect={jest.fn()} onClose={jest.fn()} initialQuery="Brown rice" />,
  );

  expect(mockUseFoodSearch).toHaveBeenLastCalledWith("Brown rice");
});

// The picker is also used to ADD a food (to a saved meal's ingredients), where
// the original "Change food" overline is simply untrue. Existing callers keep
// the default.
test("the overline defaults to Change food and can be overridden by the caller", async () => {
  const { getByText, queryByText } = await render(
    <FoodPicker visible onSelect={jest.fn()} onClose={jest.fn()} initialQuery="" />,
  );
  expect(getByText("Change food")).toBeTruthy();

  const other = await render(
    <FoodPicker visible title="Add ingredient" onSelect={jest.fn()} onClose={jest.fn()} initialQuery="" />,
  );
  expect(other.getByText("Add ingredient")).toBeTruthy();
  expect(queryByText("Change food")).toBeTruthy(); // first render untouched
});
