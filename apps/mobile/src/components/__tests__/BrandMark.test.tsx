import { render } from "@testing-library/react-native";
import { processColor } from "react-native";
import { BrandMark, BRAND_LUME, BRAND_NEEDLE } from "../BrandMark";

// react-native-svg processes color props into native color objects before they
// reach the host component, so compare payloads against processColor(), not
// hex strings.
function expectColor(prop: unknown, hex: string) {
  const payload = (prop as { payload?: unknown })?.payload ?? prop;
  expect(payload).toBe(processColor(hex));
}

// The dial K: an open 230° arc of 41 ticks (lit to 65%, dimmed past it) with
// the orange needle as the K's upper arm. Geometry and brand rules live in
// BrandMark.tsx; these tests pin the parts a regression would silently break.

test("renders all 41 ticks of the open gauge arc", async () => {
  const { getByTestId } = await render(<BrandMark />);
  for (let i = 0; i <= 40; i++) {
    expect(getByTestId(`brand-tick-${i}`)).toBeTruthy();
  }
});

// A full ring would read as a clock. The arc is the mark's identity: ticks up
// to 65% are lit, the rest are dimmed — a fill level, which no clock has.
test("ticks are lit up to the needle at 65% and dimmed past it", async () => {
  const { getByTestId } = await render(<BrandMark />);
  const litMinor = getByTestId("brand-tick-1").props.strokeOpacity;
  const dimMinor = getByTestId("brand-tick-39").props.strokeOpacity;
  expect(litMinor).toBeGreaterThan(dimMinor);
  // boundary: tick 26 (26/40 = 0.65) is the last lit tick
  expect(getByTestId("brand-tick-26").props.strokeOpacity).toBeGreaterThan(
    getByTestId("brand-tick-27").props.strokeOpacity,
  );
});

test("the needle and hub are the only orange elements", async () => {
  const { getByTestId } = await render(<BrandMark />);
  expectColor(getByTestId("brand-needle").props.stroke, BRAND_NEEDLE);
  expectColor(getByTestId("brand-hub").props.fill, BRAND_NEEDLE);
  expectColor(getByTestId("brand-stem").props.fill, BRAND_LUME);
  expectColor(getByTestId("brand-arm").props.stroke, BRAND_LUME);
  for (const i of [0, 13, 26, 40]) {
    expectColor(getByTestId(`brand-tick-${i}`).props.stroke, BRAND_LUME);
  }
});

// The needle always points "10 past" — up and to the right. If someone
// flips the geometry the K stops reading and the mark depicts decline.
test("the needle points up-right from its counterweight tail", async () => {
  const { getByTestId } = await render(<BrandMark />);
  const needle = getByTestId("brand-needle").props;
  expect(needle.x2).toBeGreaterThan(needle.x1);
  expect(needle.y2).toBeLessThan(needle.y1);
});

test("scales via the size prop while keeping geometry in the 240 viewBox space", async () => {
  const { getByTestId } = await render(<BrandMark size={64} />);
  const svg = getByTestId("brand-mark").props;
  expect(svg.width).toBe(64);
  expect(svg.height).toBe(64);
  // geometry stays in viewBox units — a tick reaches past the rendered size,
  // which only works if the 240-unit viewBox is doing the scaling
  expect(getByTestId("brand-tick-40").props.x2).toBeGreaterThan(64);
});
