import { tileBg, tileFg, tileFaint, dot, tileBgDark, tileFgDark, MACRO } from "@/lib/hue";

test("hue helpers return hsl strings, never oklch", () => {
  for (const fn of [tileBg, tileFg, tileFaint, dot, tileBgDark, tileFgDark]) {
    const out = fn(150);
    expect(out.startsWith("hsl(")).toBe(true);
    expect(out).not.toContain("oklch");
  }
});

test("MACRO exposes protein/carbs/fat hues", () => {
  expect(MACRO.protein.hue).toBe(285);
  expect(MACRO.carbs.hue).toBe(45);
  expect(MACRO.fat.hue).toBe(30);
});
