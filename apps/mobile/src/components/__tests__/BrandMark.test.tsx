import { render } from "@testing-library/react-native";
import { BrandMark } from "../BrandMark";
import { darkColors } from "@/theme/palette";

// Kora is dark-only (app.json: userInterfaceStyle "dark"). @react-native/jest-preset
// hard-mocks `useColorScheme` to always return "light" (jest/mocks/useColorScheme.js),
// so `useTheme()` resolves to the light palette under every test unless overridden.
// Force "dark" here, scoped to this file, so the assertions against darkColors
// reflect the theme the app actually ships. Mocking this single leaf module (not
// react-native itself, and not Platform) keeps everything else intact.
jest.mock("react-native/Libraries/Utilities/useColorScheme", () => ({
  __esModule: true,
  default: () => "dark",
}));

// The three muted positions, as row/col. Everything else is a large primary dot.
const MUTED = [
  [0, 1], // top-centre
  [1, 2], // middle-right
  [2, 1], // bottom-centre
] as const;

function styleOf(node: { props: Record<string, unknown> }) {
  const s = node.props.style;
  return Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean)) : s;
}

test("renders a 3x3 grid of nine dots", async () => {
  const { getByTestId } = await render(<BrandMark />);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      expect(getByTestId(`brand-dot-${r}-${c}`)).toBeTruthy();
    }
  }
});

// A test that only counted nine dots would pass against a uniform grid, which
// is the wrong mark. Position and colour are the whole point.
test("the three muted dots sit at top-centre, middle-right and bottom-centre", async () => {
  const { getByTestId } = await render(<BrandMark />);

  for (const [r, c] of MUTED) {
    const style = styleOf(getByTestId(`brand-dot-${r}-${c}`));
    expect(style.backgroundColor).toBe(darkColors.cardSecondary);
  }

  const mutedKeys = new Set(MUTED.map(([r, c]) => `${r}-${c}`));
  let large = 0;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (mutedKeys.has(`${r}-${c}`)) continue;
      const style = styleOf(getByTestId(`brand-dot-${r}-${c}`));
      expect(style.backgroundColor).toBe(darkColors.primary);
      large++;
    }
  }
  expect(large).toBe(6);
});

test("the muted dots are visibly smaller than the primary ones", async () => {
  const { getByTestId } = await render(<BrandMark />);
  const largeStyle = styleOf(getByTestId("brand-dot-0-0"));
  const mutedStyle = styleOf(getByTestId("brand-dot-0-1"));
  expect(mutedStyle.width).toBeLessThan(largeStyle.width);
  // ~60% of the large diameter, matching icon.png.
  expect(mutedStyle.width / largeStyle.width).toBeCloseTo(0.6, 1);
});

test("dots scale with the size prop and stay circular", async () => {
  const { getByTestId } = await render(<BrandMark size={80} />);
  const style = styleOf(getByTestId("brand-dot-0-0"));
  expect(style.width).toBe(style.height);
  expect(style.borderRadius).toBeCloseTo(style.width / 2, 5);
  expect(style.width).toBeGreaterThan(20);
});
