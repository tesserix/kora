import { darkColors, lightColors, radius, spacing } from "../tokens";

test("light background is pure white per Iris spec", () => {
  expect(lightColors.background).toBe("#ffffff");
});

test("every light color key has a dark counterpart", () => {
  expect(Object.keys(darkColors).sort()).toEqual(Object.keys(lightColors).sort());
});

test("all colors are hex strings parseable by RN", () => {
  for (const v of [...Object.values(lightColors), ...Object.values(darkColors)]) {
    expect(v).toMatch(/^#[0-9a-f]{6}$/);
  }
});

test("spacing and radius match the design system scale", () => {
  expect(spacing.md).toBe(16);
  expect(radius.lg).toBe(10);
});
