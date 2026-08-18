import { nudgeVisual } from "../nudgeVisual";

test.each([
  ["protein", "drumstick"],
  ["fibre", "leaf"],
  ["weight_down", "trending-down"],
  ["weight_up", "trending-up"],
  ["today", "sparkles"],
])("maps %s coach nudges to their instrument icon", (kind, icon) => {
  expect(nudgeVisual(kind).icon).toBe(icon);
});

test("unknown coach kinds use a forward-compatible neutral visual", () => {
  expect(nudgeVisual("future_kind")).toEqual({ icon: "sparkles", tone: "neutral" });
});
