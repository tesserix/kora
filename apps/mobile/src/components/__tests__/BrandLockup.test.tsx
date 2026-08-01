import { render } from "@testing-library/react-native";
import { BrandLockup } from "../BrandLockup";

test("renders the Kora wordmark beside a sparkles mark", async () => {
  const { getByText, getByTestId } = await render(<BrandLockup />);
  expect(getByText("Kora")).toBeTruthy();
  expect(getByTestId("sf-sparkles")).toBeTruthy();
});

test("the mark is a filled tile, not a bare icon", async () => {
  const { getByTestId } = await render(<BrandLockup />);
  const tile = getByTestId("brand-mark-tile");
  const style = Array.isArray(tile.props.style)
    ? Object.assign({}, ...tile.props.style.filter(Boolean))
    : tile.props.style;
  expect(style.width).toBe(40);
  expect(style.height).toBe(40);
  // Themed fill, not a transparent wrapper around the glyph.
  expect(style.backgroundColor).toBeTruthy();
  expect(style.borderRadius).toBeGreaterThan(0);
});
