export type MealSlot = "breakfast" | "lunch" | "dinner" | "snack";

// The hour at which "still up from last night" gives way to "up early".
//
// A judgement call, NOT a figure derived from data — stated plainly so the next
// reader does not assume it was measured. Anything before this is treated as
// continuous with the evening before.
const lateNightUntilHour = 4;

// mealSlotForHour maps a local hour (0-23) to a default meal slot.
//
// The small hours are their own case. `hour < 11` used to swallow 00:00-10:59
// whole, so a 1am capture defaulted to BREAKFAST (kora#194, seen on device).
// The tell was the discontinuity at midnight: 23:59 gave "snack" and 00:01 gave
// "breakfast", though nothing about the person changed across that boundary.
//
// It matters more than a wrong default usually would, because for a QUEUED
// capture the slot is chosen at capture time (app/capture.tsx) and stored with
// it — app/capture-review.tsx merely replays it, long after the moment the user
// could have noticed. Late-night eating is also exactly the pattern a food
// diary exists to surface, and filing it as breakfast hides it.
export function mealSlotForHour(hour: number): MealSlot {
  if (hour < lateNightUntilHour) return "snack";
  if (hour < 11) return "breakfast";
  if (hour < 16) return "lunch";
  if (hour < 21) return "dinner";
  return "snack";
}
