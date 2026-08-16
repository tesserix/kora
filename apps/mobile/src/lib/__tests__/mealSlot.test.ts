import { mealSlotForHour } from "../mealSlot";

describe("mealSlotForHour", () => {
  test.each([
    [8, "breakfast"],
    [13, "lunch"],
    [19, "dinner"],
    [22, "snack"],
    // The small hours belong to the night before, not to breakfast. `[0,
    // "breakfast"]` used to sit here and pinned the kora#194 defect: a 1am
    // capture arrived preselected as BREAKFAST, and for a QUEUED capture that
    // choice is baked in at capture time and merely replayed on review.
    [0, "snack"],
    [1, "snack"],
    [3, "snack"],
    [4, "breakfast"],
    [23, "snack"],
    [10, "breakfast"],
    [11, "lunch"],
    [15, "lunch"],
    [16, "dinner"],
    [20, "dinner"],
    [21, "snack"],
  ])("hour %i -> %s", (hour, expected) => {
    expect(mealSlotForHour(hour)).toBe(expected);
  });

  // The tell that the old mapping was wrong: nothing about a person changes
  // across midnight, but the default flipped to the opposite end of the day.
  test("midnight does not flip the slot from snack to breakfast", () => {
    expect(mealSlotForHour(23)).toBe(mealSlotForHour(0));
  });
});
