export type MealSlot = "breakfast" | "lunch" | "dinner" | "snack";

// mealSlotForHour maps a local hour (0-23) to a default meal slot.
export function mealSlotForHour(hour: number): MealSlot {
  if (hour < 11) return "breakfast";
  if (hour < 16) return "lunch";
  if (hour < 21) return "dinner";
  return "snack";
}
