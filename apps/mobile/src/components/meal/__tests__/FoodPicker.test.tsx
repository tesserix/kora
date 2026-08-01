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
