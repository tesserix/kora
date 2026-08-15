import { formatSlotLabel } from "../slotLabel";

test("splits the slot name and the rounded kcal subtotal into label/detail", () => {
  expect(formatSlotLabel("breakfast", 380)).toEqual({ label: "breakfast", detail: "· 380 kcal" });
});

test("still reads correctly with a zero subtotal", () => {
  expect(formatSlotLabel("lunch", 0)).toEqual({ label: "lunch", detail: "· 0 kcal" });
});
