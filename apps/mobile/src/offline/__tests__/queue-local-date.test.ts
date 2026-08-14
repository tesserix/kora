import { append, list } from "../queue";
import type { CreateLogInput } from "@/api/hooks";

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

const INPUT: CreateLogInput = {
  food_item_id: "f1",
  meal_slot: "dinner",
  source: "manual",
  quantity_grams: 200,
  logged_at: "2026-03-01T02:00:00.000Z",
  local_date: "2026-02-28", // captured in London
};

// THE regression this design exists to prevent.
//
// A meal captured in London and drained after landing in Sydney must keep
// London's date. The queue must therefore store the payload VERBATIM: if it
// re-stamped the date at drain time — or if the server computed it on receipt —
// the meal would silently move to the wrong day, which is the bug kora#84 is
// about, reintroduced through the back door.
test("a queued log keeps the date it was captured with, not the date it drains", async () => {
  await append(INPUT, "log-1", "user-1");

  const queued = await list();
  const mine = queued.filter((q) => q.id === "log-1");
  expect(mine).toHaveLength(1);
  expect(mine[0].payload.local_date).toBe("2026-02-28");
});

// The whole payload must survive, not just the date — a queue that rebuilt the
// body would drop fields silently.
test("a queued log preserves the rest of the capture payload", async () => {
  await append(INPUT, "log-2", "user-1");

  const queued = await list();
  const mine = queued.find((q) => q.id === "log-2");
  expect(mine?.payload).toMatchObject({
    food_item_id: "f1",
    meal_slot: "dinner",
    quantity_grams: 200,
    logged_at: "2026-03-01T02:00:00.000Z",
    local_date: "2026-02-28",
  });
});
