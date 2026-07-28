import { yourUsual, type UsualRow } from "../yourUsual";
import type { Memory, MemoryFood, MemoryMeal } from "@/api/types";

function food(id: string, name: string, slot: string): MemoryFood {
  return { food_item_id: id, name, meal_slot: slot, grams: 100, kcal: 100, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, count: 3, last_logged_at: "" };
}
function meal(id: string, name: string, slot: string): MemoryMeal {
  return { id, name, meal_slot: slot, items: [food("x", "X", slot)], kcal: 200, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, count: 3, last_logged_at: "" };
}
function mem(over: Partial<Memory>): Memory {
  return { recents: [], frequent: [], usual_meals: [], ...over };
}

test("undefined memory returns empty", () => {
  expect(yourUsual(undefined, "breakfast")).toEqual([]);
});

test("meals for the slot come before frequent foods for the slot", () => {
  const m = mem({ usual_meals: [meal("m1", "Oats & Egg", "breakfast")], frequent: [food("f1", "Eggs", "breakfast")] });
  const rows = yourUsual(m, "breakfast");
  expect(rows.map((r) => r.kind)).toEqual(["meal", "food"]);
  expect((rows[0] as Extract<UsualRow, { kind: "meal" }>).meal.id).toBe("m1");
});

test("wrong-slot entries are excluded", () => {
  const m = mem({ usual_meals: [meal("m1", "M", "lunch")], frequent: [food("f1", "F", "lunch")] });
  // no breakfast entries, and no fallback frequent for breakfast -> fallback is overall frequent (the lunch food)
  const rows = yourUsual(m, "breakfast");
  expect(rows).toHaveLength(1); // fallback to overall frequent
  expect(rows[0].kind).toBe("food");
});

test("caps at 4 rows for the slot", () => {
  const m = mem({
    usual_meals: [meal("m1", "M", "dinner"), meal("m2", "M2", "dinner")],
    frequent: [food("f1", "A", "dinner"), food("f2", "B", "dinner"), food("f3", "C", "dinner")],
  });
  expect(yourUsual(m, "dinner")).toHaveLength(4); // 2 meals + first 2 foods
});

test("falls back to overall top frequent when slot has nothing", () => {
  const m = mem({ frequent: [food("f1", "Eggs", "lunch"), food("f2", "Oats", "dinner")] });
  const rows = yourUsual(m, "breakfast");
  expect(rows.map((r) => (r as Extract<UsualRow, { kind: "food" }>).food.food_item_id)).toEqual(["f1", "f2"]);
});

test("returns empty when there is no data at all", () => {
  expect(yourUsual(mem({}), "breakfast")).toEqual([]);
});
