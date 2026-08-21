import { render } from "@testing-library/react-native";
import * as RN from "react-native";
import { processColor } from "react-native";
import { BrandMark, BRAND_LUME, BRAND_LUME_LIGHT, BRAND_NEEDLE } from "../BrandMark";

// The scheme has to be stated, never inherited (kora#318). Jest's
// useColorScheme() resolves to LIGHT, while the app forces dark at runtime — so
// an unmocked render here exercises the branch the device almost never shows,
// which is how the light-mode mark stayed invisible while these tests passed.
function renderIn(scheme: "light" | "dark") {
  jest.spyOn(RN, "useColorScheme").mockReturnValue(scheme);
  return render(<BrandMark />);
}

afterEach(() => {
  jest.restoreAllMocks();
});

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
  const { getByTestId } = await renderIn("dark");
  for (let i = 0; i <= 40; i++) {
    expect(getByTestId(`brand-tick-${i}`)).toBeTruthy();
  }
});

// A full ring would read as a clock. The arc is the mark's identity: ticks up
// to 65% are lit, the rest are dimmed — a fill level, which no clock has.
test("ticks are lit up to the needle at 65% and dimmed past it", async () => {
  const { getByTestId } = await renderIn("dark");
  const litMinor = getByTestId("brand-tick-1").props.strokeOpacity;
  const dimMinor = getByTestId("brand-tick-39").props.strokeOpacity;
  expect(litMinor).toBeGreaterThan(dimMinor);
  // boundary: tick 26 (26/40 = 0.65) is the last lit tick
  expect(getByTestId("brand-tick-26").props.strokeOpacity).toBeGreaterThan(
    getByTestId("brand-tick-27").props.strokeOpacity,
  );
});

test("the needle and hub are the only orange elements", async () => {
  const { getByTestId } = await renderIn("dark");
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
// kora#318. `#EDE6D4` on the light ground `#ECEDEF` is 1.06:1 — invisible — so
// on light every lume element disappeared and only the orange needle, being a
// different hue, survived. The mapping is not invented: assets/brand ships
// kora-mark-light.svg with exactly this ink swap.
test("the lume goes to ink on light, so the mark does not vanish", async () => {
  const { getByTestId } = await renderIn("light");
  expectColor(getByTestId("brand-stem").props.fill, BRAND_LUME_LIGHT);
  expectColor(getByTestId("brand-arm").props.stroke, BRAND_LUME_LIGHT);
  for (const i of [0, 13, 26, 40]) {
    expectColor(getByTestId(`brand-tick-${i}`).props.stroke, BRAND_LUME_LIGHT);
  }
});

// The needle IS brand-fixed, unlike the lume — kora-mark-light.svg keeps
// #FF4A00. It is the one element that must not follow the scheme.
test("the needle stays brand orange in both schemes", async () => {
  for (const scheme of ["light", "dark"] as const) {
    const { getByTestId } = await renderIn(scheme);
    expectColor(getByTestId("brand-needle").props.stroke, BRAND_NEEDLE);
    expectColor(getByTestId("brand-hub").props.fill, BRAND_NEEDLE);
    jest.restoreAllMocks();
  }
});

// Opacity carries the lit/dimmed reading of the arc; only the COLOUR is
// scheme-dependent. If a fix ever reached for opacity instead, the mark would
// lose its fill-level identity on one scheme.
test("tick opacities are identical in both schemes", async () => {
  const dark = await renderIn("dark");
  const darkOps = [0, 13, 26, 40].map((i) => dark.getByTestId(`brand-tick-${i}`).props.strokeOpacity);
  jest.restoreAllMocks();
  const light = await renderIn("light");
  const lightOps = [0, 13, 26, 40].map((i) => light.getByTestId(`brand-tick-${i}`).props.strokeOpacity);
  expect(lightOps).toEqual(darkOps);
});

test("the needle points up-right from its counterweight tail", async () => {
  const { getByTestId } = await renderIn("dark");
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
