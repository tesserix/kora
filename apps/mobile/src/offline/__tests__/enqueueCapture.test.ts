import AsyncStorage from "@react-native-async-storage/async-storage";
import { list } from "../captureQueue";
import { enqueueCapture } from "../enqueueCapture";

jest.mock("@/lib/api", () => ({
  currentUserId: jest.fn(() => null),
}));
jest.mock("../captureMedia", () => ({
  copyIntoQueue: jest.fn(async (_uri: string, id: string) => `${id}.jpg`),
}));
jest.mock("../owner", () => {
  const actual = jest.requireActual("../owner");
  return { ...actual, resolveOwnerId: jest.fn(async () => "uid-1") };
});

beforeEach(async () => { await AsyncStorage.clear(); });

it("copies the media BEFORE appending, so no row can reference a missing file", async () => {
  // Pinned: enqueueCapture and captureQueue.append each take their own
  // `new Date().toISOString()` reading. Without a fixed clock the two calls
  // can straddle a millisecond boundary, making the capturedAt === queuedAt
  // assertion below flaky rather than a real check of same-instant capture.
  jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
  jest.setSystemTime(new Date("2026-08-06T05:00:00.000Z"));
  try {
    const { copyIntoQueue } = jest.requireMock("../captureMedia");
    await enqueueCapture(
      { uri: "file:///cache/x.jpg", name: "meal.jpg", type: "image/jpeg" },
      "photo",
      "lunch",
    );
    expect(copyIntoQueue).toHaveBeenCalled();
    const [item] = await list();
    expect(item).toMatchObject({ kind: "photo", mealSlot: "lunch", storedName: expect.any(String) });
    expect(item.capturedAt).toBe(item.queuedAt);
  } finally {
    jest.useRealTimers();
  }
});

it("refuses to queue when nobody is signed in", async () => {
  const { resolveOwnerId } = jest.requireMock("../owner");
  resolveOwnerId.mockResolvedValueOnce(null);
  await expect(
    enqueueCapture({ uri: "file:///cache/x.jpg", name: "m.jpg", type: "image/jpeg" }, "photo"),
  ).rejects.toMatchObject({ name: "NoOwnerError" });
  await expect(list()).resolves.toEqual([]);
});
