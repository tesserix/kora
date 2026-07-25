import { mealSlotForHour } from "../mealSlot";

describe("mealSlotForHour", () => {
  test.each([
    [8, "breakfast"],
    [13, "lunch"],
    [19, "dinner"],
    [22, "snack"],
    [0, "breakfast"],
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
});
