import { readAnchor, writeAnchor } from "../anchorStore";

// The anchor is DEVICE state, never server state: HKAnchoredObjectQuery
// returns an opaque cursor meaningful only to this device's HealthKit store.
// Sending it to the server would break the moment the user signs in on a
// second phone, which would resume from a cursor that means nothing to it and
// silently skip everything before it.
test("returns null before anything has been synced", async () => {
  expect(await readAnchor("weight")).toBeNull();
});

test("round-trips an anchor", async () => {
  await writeAnchor("weight", "anchor-1");
  expect(await readAnchor("weight")).toBe("anchor-1");
});

test("keeps anchors separate per metric", async () => {
  await writeAnchor("weight", "anchor-weight");
  expect(await readAnchor("steps" as never)).toBeNull();
});
