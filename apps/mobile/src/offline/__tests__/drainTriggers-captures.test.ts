import AsyncStorage from "@react-native-async-storage/async-storage";
import { onlineManager } from "@tanstack/react-query";
import { append as appendCapture } from "../captureQueue";
import { installDrainTriggers } from "../drainTriggers";

jest.mock("@/lib/api", () => ({
  currentUserId: jest.fn(() => null),
}));
jest.mock("@/lib/firebase", () => ({ auth: { name: "test-auth" }, isFirebaseConfigured: true }));
jest.mock("firebase/auth", () => ({ onAuthStateChanged: jest.fn(() => jest.fn()) }));
jest.mock("../drainCaptures", () => ({ drainCaptures: jest.fn(async () => {}) }));
jest.mock("../drainLogs", () => ({ drainLogs: jest.fn(async () => {}) }));
jest.mock("../captureMedia", () => ({ sweepOrphans: jest.fn(async () => 0) }));

it("drains captures on reconnect, not only logs", () => {
  const { drainCaptures } = jest.requireMock("../drainCaptures");
  // Start OFFLINE, so the transition below is a real reconnect. A test that
  // begins online never exercises the path it names — the exact trap slice 1 hit.
  onlineManager.setOnline(false);
  const teardown = installDrainTriggers({} as never);
  drainCaptures.mockClear();

  onlineManager.setOnline(true);

  expect(drainCaptures).toHaveBeenCalled();
  teardown();
});

// A UTC instant that lands at midday on the given LOCAL calendar day, so the
// fixture means the same day in every timezone the suite might run in.
const atLocalNoon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();

async function seedCapture(id: string, storedName: string) {
  await appendCapture({
    id, kind: "photo", storedName, fileName: "m.jpg", mimeType: "image/jpeg",
    capturedAt: atLocalNoon(2026, 8, 1), ownerId: "uid-1",
  } as Parameters<typeof appendCapture>[0]);
}

// Asserting only that sweepOrphans was CALLED is worthless with no captures
// seeded: the keep-list is `[]` either way, so mutating drainTriggers.ts to
// `sweepOrphans([])` — dropping the listCaptures() join — stays green while
// DELETING EVERY QUEUED PHOTO AND VOICE NOTE on the device at cold start.
// Two rows are seeded and the exact stored names are asserted, so only a real
// join passes.
it("sweeps orphaned media on install, keeping every queued capture's file", async () => {
  await AsyncStorage.clear();
  await seedCapture("c1", "c1.jpg");
  await seedCapture("c2", "c2.m4a");

  const { sweepOrphans } = jest.requireMock("../captureMedia");
  sweepOrphans.mockClear();
  const teardown = installDrainTriggers({} as never);
  // listCaptures() -> sweepOrphans() is two awaits deep.
  await new Promise((resolve) => setImmediate(resolve));

  expect(sweepOrphans).toHaveBeenCalledWith(["c1.jpg", "c2.m4a"]);
  teardown();
});
