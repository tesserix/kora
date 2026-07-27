import { darkColors, lightColors, radius, spacing } from "../palette";

test("every light color key has a dark counterpart", () => {
  expect(Object.keys(darkColors).sort()).toEqual(Object.keys(lightColors).sort());
});

test("all colors are valid CSS color strings parseable by RN (hex or rgba)", () => {
  for (const v of [...Object.values(lightColors), ...Object.values(darkColors)]) {
    expect(v).toMatch(/^(#[0-9A-Fa-f]{6}|rgba\(\d+,\d+,\d+,[\d.]+\))$/);
  }
});

test("primary is iOS system green in both schemes", () => {
  expect(lightColors.primary).toBe("#34C759");
  expect(darkColors.primary).toBe("#30D158");
});

test("background matches iOS grouped background in both schemes", () => {
  expect(lightColors.background).toBe("#F2F2F7");
  expect(darkColors.background).toBe("#000000");
});

test("card matches iOS elevated surface in both schemes", () => {
  expect(lightColors.card).toBe("#FFFFFF");
  expect(darkColors.card).toBe("#1C1C1E");
});

test("spacing and radius match the design system scale", () => {
  expect(spacing.md).toBe(16);
  expect(radius.lg).toBe(12);
});

import { gradientStops } from "../palette";

describe("elevated tokens", () => {
  it("adds metric hues + elevated surface to both schemes", () => {
    for (const c of [lightColors, darkColors]) {
      expect(c.stepsMetric).toMatch(/^#/);
      expect(c.sleepMetric).toMatch(/^#/);
      expect(c.elevated).toMatch(/^#/);
    }
  });
  it("exposes 2-stop gradient sets per scheme", () => {
    for (const scheme of [gradientStops.light, gradientStops.dark]) {
      for (const pair of [scheme.green, scheme.amber, scheme.blue, scheme.steps, scheme.sleep]) {
        expect(pair).toHaveLength(2);
        expect(pair[0]).toMatch(/^#/);
        expect(pair[1]).toMatch(/^#/);
      }
    }
  });
});
