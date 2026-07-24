import { mealSlotForHour } from "../mealSlot";

describe("mealSlotForHour", () => {
  test.each([
    [8, "breakfast"],
    [13, "lunch"],
    [19, "dinner"],
    [22, "snack"],
    [0, "breakfast"],
    [23, "snack"],
  ])("hour %i -> %s", (hour, expected) => {
    expect(mealSlotForHour(hour)).toBe(expected);
  });
});
