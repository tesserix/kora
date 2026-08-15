import { formatSlotLabel } from "../slotLabel";

test("combines the slot name and rounded kcal subtotal", () => {
  expect(formatSlotLabel("breakfast", 380)).toBe("breakfast · 380 kcal");
});

test("still reads correctly with a zero subtotal", () => {
  expect(formatSlotLabel("lunch", 0)).toBe("lunch · 0 kcal");
});
