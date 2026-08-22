import AsyncStorage from "@react-native-async-storage/async-storage";
import { MAX_CAPTURES, append, list } from "../captureQueue";
import { enqueueBarcodeCapture, enqueueCapture, enqueueTextCapture } from "../enqueueCapture";
import { NoOwnerError } from "../owner";

jest.mock("@/lib/api", () => ({
  currentUserId: jest.fn(() => null),
}));
jest.mock("../captureMedia", () => ({
  copyIntoQueue: jest.fn(async (_uri: string, id: string) => `${id}.jpg`),
  deleteQueuedMedia: jest.fn(async () => {}),
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

// The prose test above ("copies the media BEFORE appending...") only checks
// that copyIntoQueue was called and that the resulting row has the right
// shape — both hold identically regardless of which happens first, since the
// mocked copy always succeeds. This test binds the actual invariant: when the
// copy fails, no row may ever have been appended.
it("leaves the queue empty when the copy fails, so no row can outlive its file", async () => {
  const { copyIntoQueue } = jest.requireMock("../captureMedia");
  copyIntoQueue.mockRejectedValueOnce(new Error("disk full"));

  await expect(
    enqueueCapture({ uri: "file:///cache/x.jpg", name: "meal.jpg", type: "image/jpeg" }, "photo", "lunch"),
  ).rejects.toThrow("disk full");
  await expect(list()).resolves.toEqual([]);
});

it("refuses to queue when nobody is signed in", async () => {
  const { resolveOwnerId } = jest.requireMock("../owner");
  resolveOwnerId.mockResolvedValueOnce(null);
  await expect(
    enqueueCapture({ uri: "file:///cache/x.jpg", name: "m.jpg", type: "image/jpeg" }, "photo"),
  ).rejects.toMatchObject({ name: "NoOwnerError" });
  await expect(list()).resolves.toEqual([]);
});

// The queue's cap is enforced by `append`, which runs AFTER the media has been
// copied — so a refusal at MAX_CAPTURES used to leave 1-3 MB of photo on disk
// with no row referencing it, reclaimed only by the NEXT launch's orphan
// sweep. A user retrying against a full queue could add tens of MB in one
// session.
it("deletes the copied media when the queue refuses the row", async () => {
  const { copyIntoQueue, deleteQueuedMedia } = jest.requireMock("../captureMedia");
  copyIntoQueue.mockClear();
  deleteQueuedMedia.mockClear();

  // Fill the queue to its cap so the next append is refused.
  for (let i = 0; i < MAX_CAPTURES; i++) {
    await append({
      id: `seed-${i}`, kind: "photo", storedName: `seed-${i}.jpg`, fileName: "m.jpg",
      mimeType: "image/jpeg", capturedAt: new Date(2026, 7, 1, 12).toISOString(), ownerId: "uid-1",
    } as Parameters<typeof append>[0]);
  }

  await expect(
    enqueueCapture({ uri: "file:///cache/x.jpg", name: "meal.jpg", type: "image/jpeg" }, "photo", "lunch"),
  ).rejects.toThrow(/too many captures/i);

  // The copy DID happen (the cap is only knowable inside append's lock), and
  // the file it wrote must be gone again.
  expect(copyIntoQueue).toHaveBeenCalledTimes(1);
  const storedName = await copyIntoQueue.mock.results[0].value;
  expect(deleteQueuedMedia).toHaveBeenCalledWith(storedName);
  // And no row leaked past the cap.
  expect(await list()).toHaveLength(MAX_CAPTURES);
});

// kora#196. enqueueCapture's whole contract is media: copy the file first,
// then append, so a failure can only ever leak a file with no row. A text
// capture has no file, so none of that machinery applies to it.
describe("enqueueTextCapture (kora#196)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("queues the phrase without writing any media", async () => {
    const row = await enqueueTextCapture("chicken and rice", "lunch");
    expect(row).toMatchObject({ kind: "text", phrase: "chicken and rice", mealSlot: "lunch" });
    const { copyIntoQueue } = jest.requireMock("../captureMedia");
    expect(copyIntoQueue).not.toHaveBeenCalled();
  });

  it("mints an id in the same shape the media path uses", async () => {
    const row = await enqueueTextCapture("two eggs");
    expect(row.id).toMatch(/^cap_\d+_[a-z0-9]+$/);
  });

  it("refuses to queue with nobody signed in, rather than queueing an ownerless row", async () => {
    const { resolveOwnerId } = jest.requireMock("../owner");
    resolveOwnerId.mockResolvedValueOnce(null);
    await expect(enqueueTextCapture("two eggs")).rejects.toBeInstanceOf(NoOwnerError);
  });
});

// kora#241. Same shape as the text sibling — no file, so none of the
// copy-before-append machinery applies.
describe("enqueueBarcodeCapture (kora#241)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("queues the code without writing any media", async () => {
    const row = await enqueueBarcodeCapture("5000112637922", "lunch");
    expect(row).toMatchObject({ kind: "barcode", code: "5000112637922", mealSlot: "lunch" });
    const { copyIntoQueue } = jest.requireMock("../captureMedia");
    expect(copyIntoQueue).not.toHaveBeenCalled();
  });

  // The scanner fires repeatedly at one product, so the caller can and will
  // ask twice. It gets back the row that IS queued — "saved" either way, and
  // never a second row.
  it("hands back the existing row rather than queueing the same code twice", async () => {
    const first = await enqueueBarcodeCapture("5000112637922");
    const second = await enqueueBarcodeCapture("5000112637922");
    expect(second.id).toBe(first.id);
    expect(await list()).toHaveLength(1);
  });

  it("refuses to queue with nobody signed in, rather than queueing an ownerless row", async () => {
    const { resolveOwnerId } = jest.requireMock("../owner");
    resolveOwnerId.mockResolvedValueOnce(null);
    await expect(enqueueBarcodeCapture("5000112637922")).rejects.toBeInstanceOf(NoOwnerError);
  });
});
