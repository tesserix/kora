import { accessibleMealLabel } from "../portionAssumedLabel";

test("appends the hedge when the portion was assumed", () => {
  expect(accessibleMealLabel("Mystery stew", true)).toBe("Mystery stew, portion is a guess");
});

test("leaves the label unchanged when the portion was not assumed", () => {
  expect(accessibleMealLabel("Grilled chicken breast", false)).toBe("Grilled chicken breast");
});
