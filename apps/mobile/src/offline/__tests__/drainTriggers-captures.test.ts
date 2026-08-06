import { onlineManager } from "@tanstack/react-query";
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

it("sweeps orphaned media on install", async () => {
  const { sweepOrphans } = jest.requireMock("../captureMedia");
  const teardown = installDrainTriggers({} as never);
  await Promise.resolve();
  expect(sweepOrphans).toHaveBeenCalled();
  teardown();
});
