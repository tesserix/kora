import { foodVisual } from "@/lib/foodVisual";

test("is deterministic for the same name", () => {
  expect(foodVisual("Grilled chicken breast")).toEqual(foodVisual("Grilled chicken breast"));
});

test("maps keywords to sensible icons", () => {
  expect(foodVisual("Grilled chicken breast").icon).toBe("drumstick");
  expect(foodVisual("Steamed broccoli salad").icon).toBe("leaf");
  expect(foodVisual("Brown rice").icon).toBe("wheat");
});

test("falls back by meal slot then to utensils", () => {
  expect(foodVisual("Mystery plate", "breakfast").icon).toBe("coffee");
  expect(foodVisual("Mystery plate", "dinner").icon).toBe("utensils");
});

test("hue is within 0..360", () => {
  const { hue } = foodVisual("anything");
  expect(hue).toBeGreaterThanOrEqual(0);
  expect(hue).toBeLessThan(360);
});
