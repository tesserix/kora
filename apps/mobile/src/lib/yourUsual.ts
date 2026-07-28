import type { Memory, MemoryFood, MemoryMeal } from "@/api/types";
import type { MealSlot } from "@/lib/mealSlot";

export type UsualRow =
  | { kind: "meal"; meal: MemoryMeal }
  | { kind: "food"; food: MemoryFood };

const MAX_ROWS = 4;

// yourUsual picks up to 4 one-tap rows for the given meal slot: the user's
// usual MEALS for that slot first, then their frequent single FOODS for that
// slot. If the slot has neither, it falls back to the user's overall top
// frequent foods. Pure function of (memory, slot) — no time, no I/O.
export function yourUsual(memory: Memory | undefined, slot: MealSlot): UsualRow[] {
  if (!memory) return [];
  const meals = memory.usual_meals
    .filter((m) => m.meal_slot === slot)
    .map((meal): UsualRow => ({ kind: "meal", meal }));
  const foods = memory.frequent
    .filter((f) => f.meal_slot === slot)
    .map((food): UsualRow => ({ kind: "food", food }));
  const forSlot = [...meals, ...foods].slice(0, MAX_ROWS);
  if (forSlot.length > 0) return forSlot;
  return memory.frequent.slice(0, MAX_ROWS).map((food): UsualRow => ({ kind: "food", food }));
}
