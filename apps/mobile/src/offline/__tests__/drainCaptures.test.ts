import AsyncStorage from "@react-native-async-storage/async-storage";
import { append as appendCapture, list as listCaptures } from "../captureQueue";
import { list as listLogs } from "../queue";
import { CaptureUnidentifiedError, drainCaptureQueue } from "../drainCaptures";
import type { Resolution } from "@/api/types";

// drainCaptures.ts imports @/lib/api at module scope for its app-facing wrapper
// (currentUserId, apiFetchMultipart) even though none of the tests below exercise
// that wrapper — they call the pure drainCaptureQueue core with injected deps
// instead. @/lib/api transitively pulls in firebase/auth's ESM build, which Jest
// cannot parse unmocked; see the same mock in drainLogs.test.ts and
// resolve-upload-multipart.test.tsx.
jest.mock("@/lib/api", () => ({
  apiFetchMultipart: jest.fn(),
  currentUserId: jest.fn(() => "uid-1"),
}));

const atLocalNoon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();

// A v4 UUID, the ONLY id shape api/internal/foodlog/service.go can bind into
// its `ID *uuid.UUID` field. Deliberately not `expect.any(String)`: the bug
// this pins handed the capture queue's own `cap_<millis>_<rand>` key over,
// which is a string too, and the 400 it produced is classified as permanent —
// so the log was dropped after drainCaptures had already deleted the photo.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OWNER = "uid-1";

function res(tier: "auto" | "confirm" | "follow_up"): Resolution {
  return {
    tier,
    candidates: [{ item: { id: "food-1", name: "Oats", kcal_per_100g: 389 }, quantity_grams: 100 }],
  } as unknown as Resolution;
}

async function seed(id: string, over: Record<string, unknown> = {}) {
  return appendCapture({
    id, kind: "photo", storedName: `${id}.jpg`, fileName: "meal.jpg",
    mimeType: "image/jpeg", capturedAt: atLocalNoon(2026, 8, 6),
    ownerId: OWNER, ...over,
  } as Parameters<typeof appendCapture>[0]);
}

function deps(over: Partial<Parameters<typeof drainCaptureQueue>[0]> = {}) {
  return {
    ownerId: OWNER,
    resolve: jest.fn(async () => res("auto")),
    mediaExists: () => true,
    deleteMedia: jest.fn(async () => {}),
    ...over,
  } as Parameters<typeof drainCaptureQueue>[0];
}

beforeEach(async () => { await AsyncStorage.clear(); });

describe("drainCaptureQueue", () => {
  // tier "auto" hands off to the LOG queue — this drain never calls /v1/logs.
  it("hands an auto-tier capture to the log queue at its CAPTURE time", async () => {
    await seed("c1");
    const d = deps();

    const result = await drainCaptureQueue(d);

    expect(result.logged).toBe(1);
    const logs = await listLogs();
    expect(logs).toHaveLength(1);
    // Decision 2: the log is stamped when the photo was TAKEN, not when it resolved.
    expect(logs[0].payload.logged_at).toBe(atLocalNoon(2026, 8, 6));
    // The server's source allowlist (api/internal/metrics/labels.go:44-47) has
    // no "photo" or "voice" entry — only "ai_photo" and "ai_voice". Anything
    // else is silently bucketed into "other" (labels.go:16-19), corrupting the
    // by-source share metric with no error anywhere.
    expect(logs[0].payload.source).toBe("ai_photo");
    expect(await listCaptures()).toEqual([]);
    expect(d.deleteMedia).toHaveBeenCalledWith("c1.jpg");
  });

  // The id handed to the log queue is what drainLogs sends as the request
  // body's `id`, and the server binds it as a uuid. The capture id is NOT one.
  it("mints a fresh v4 UUID for the log, never reusing the capture id", async () => {
    await seed("cap_1754476800000_a1b2c3");

    await drainCaptureQueue(deps());

    const [log] = await listLogs();
    expect(log.id).toMatch(UUID_V4);
    expect(log.id).not.toBe("cap_1754476800000_a1b2c3");
  });

  // Idempotency: the id is the server's replay key, so two captures must never
  // present the same one.
  it("gives each handed-off capture its own distinct log id", async () => {
    await seed("cap_1754476800000_aaaaaa");
    await seed("cap_1754476800001_bbbbbb");

    await drainCaptureQueue(deps());

    const logs = await listLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0].id).toMatch(UUID_V4);
    expect(logs[1].id).toMatch(UUID_V4);
    expect(logs[0].id).not.toBe(logs[1].id);
  });

  it("stamps a voice capture's handoff with the ai_voice source, not a raw 'voice'", async () => {
    await seed("c1", { kind: "voice", storedName: "c1.m4a" });
    const d = deps();

    await drainCaptureQueue(d);

    const logs = await listLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].payload.source).toBe("ai_voice");
  });

  it("routes confirm and follow_up to review, keeping the media", async () => {
    await seed("c1");
    await seed("c2");
    const d = deps({
      resolve: jest.fn(async (c: { id: string }) => (c.id === "c1" ? res("confirm") : res("follow_up"))),
    });

    const result = await drainCaptureQueue(d);

    expect(result.review).toBe(2);
    expect(result.logged).toBe(0);
    expect(await listLogs()).toEqual([]);
    expect((await listCaptures()).map((c) => c.status)).toEqual(["review", "review"]);
    expect(d.deleteMedia).not.toHaveBeenCalled();
  });

  // "The AI could not identify it" is a SUCCESSFUL resolve with no result.
  // Retrying it burns real Gemini budget against a photo of a wall forever.
  it("treats an unidentifiable capture as terminal, not retryable", async () => {
    await seed("c1");

    await drainCaptureQueue(deps({
      resolve: jest.fn(async () => { throw new CaptureUnidentifiedError(); }),
    }));

    const [item] = await listCaptures();
    expect(item.status).toBe("failed");
    expect(item.attempts).toBe(0);
    expect(item.failureKind).toBe("identification");
  });

  // A failure with no HTTP status never got a verdict — offline is the NORMAL
  // state here, and counting it would fail a good meal after five launches.
  it("does not age a capture on a verdict-less failure", async () => {
    await seed("c1");

    const result = await drainCaptureQueue(deps({
      resolve: jest.fn(async () => { throw new Error("Network request failed"); }),
    }));

    expect(result.deferred).toBe(1);
    expect((await listCaptures())[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  // The case task-8's review caught: a permanent 4xx is a DELIVERY failure —
  // the server refused the request, so the AI never rendered a verdict — and
  // must be tagged "delivery", not left to fall through as "identification"
  // (attempts stays at 0 here too, same as CaptureUnidentifiedError, so
  // failureKind is the only thing that can tell these two apart).
  it("fails a capture permanently on a 4xx, tagged as a delivery failure", async () => {
    await seed("c1");

    await drainCaptureQueue(deps({
      resolve: jest.fn(async () => { throw Object.assign(new Error("bad"), { status: 400 }); }),
    }));

    const [item] = await listCaptures();
    expect(item.status).toBe("failed");
    expect(item.attempts).toBe(0);
    expect(item.failureKind).toBe("delivery");
  });

  it("keeps a 401 retryable — it means 'not authenticated YET'", async () => {
    await seed("c1");

    await drainCaptureQueue(deps({
      resolve: jest.fn(async () => { throw Object.assign(new Error("unauth"), { status: 401 }); }),
    }));

    expect((await listCaptures())[0]).toMatchObject({ status: "pending", attempts: 1 });
  });

  // An unhandled throw here strands every OTHER queued capture in the pass.
  it("fails a capture whose media has vanished, without throwing", async () => {
    await seed("c1");
    await seed("c2");
    const d = deps({ mediaExists: (name: string) => name !== "c1.jpg" });

    await expect(drainCaptureQueue(d)).resolves.toBeDefined();

    const items = await listCaptures();
    expect(items.find((i) => i.id === "c1")?.status).toBe("failed");
    expect(items.find((i) => i.id === "c1")?.failureKind).toBe("missing-media");
    expect(items.find((i) => i.id === "c2")).toBeUndefined(); // c2 still drained
  });

  it("never drains another user's capture", async () => {
    await seed("mine");
    await seed("theirs", { ownerId: "uid-2" });
    const d = deps();

    await drainCaptureQueue(d);

    expect(d.resolve).toHaveBeenCalledTimes(1);
    expect((await listCaptures()).map((c) => c.id)).toEqual(["theirs"]);
  });

  it("skips rows already in review or failed", async () => {
    await seed("c1");
    const d = deps({ resolve: jest.fn(async () => res("confirm")) });
    await drainCaptureQueue(d);
    await drainCaptureQueue(d);
    expect(d.resolve).toHaveBeenCalledTimes(1);
  });
});
