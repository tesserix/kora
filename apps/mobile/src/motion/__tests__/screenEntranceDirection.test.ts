import { __resetForTests, resolveScreenDirection } from "@/motion/screenEntranceDirection";

// `lastFocusedIndex` is module-level mutable state shared across every call
// in this process — reset it before each test so these assertions aren't
// order-dependent on whatever ran before them (kora ignition review, Finding
// 3).
beforeEach(() => {
  __resetForTests();
});

test("the first-ever focus defaults to +1", () => {
  expect(resolveScreenDirection(0)).toBe(1);
});

test("moving to a higher index resolves +1, then moving to a lower index resolves -1", () => {
  expect(resolveScreenDirection(2)).toBe(1);
  expect(resolveScreenDirection(1)).toBe(-1);
});

test("re-focusing the same index resolves +1 (a tie)", () => {
  resolveScreenDirection(1);
  expect(resolveScreenDirection(1)).toBe(1);
});
