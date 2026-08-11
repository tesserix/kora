import { render } from "@testing-library/react-native";
import { BrandLockup } from "../BrandLockup";

test("renders the Kora wordmark beside the dial-K mark", async () => {
  const { getByText, getByTestId } = await render(<BrandLockup />);
  expect(getByText("Kora")).toBeTruthy();
  expect(getByTestId("brand-mark")).toBeTruthy();
});

// The old lockup rendered a Lucide sparkles glyph in a primary-filled tile.
// Asserting the wordmark still renders first means this is a disappearance,
// not a component that failed to mount at all.
test("no longer renders the sparkles glyph or its tile", async () => {
  const { getByText, queryByTestId } = await render(<BrandLockup />);
  expect(getByText("Kora")).toBeTruthy();
  expect(queryByTestId("sf-sparkles")).toBeNull();
  expect(queryByTestId("brand-mark-tile")).toBeNull();
});
