// kora#241, the transport half of the barcode arm.
//
// drainCaptures.test.ts injects `resolve`, so drainCaptures.ts's own
// `resolveCapture` is dead code there — the endpoint, the request body and the
// cache fallback are all invisible to it. This suite drives the app-facing
// `drainCaptures(queryClient)` instead, mocking only @/lib/api's apiFetch, so
// the dispatch under test is the one production takes. Same rationale as
// drainCaptures-upload-multipart.test.ts for the media arm.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiFetch } from "@/lib/api";
import { CACHED_MATCH_TIER } from "@/api/types";
import { append as appendCapture, list as listCaptures } from "../captureQueue";
import { getFoodByBarcode } from "../foodCache";
import { list as listLogs } from "../queue";
import { drainCaptures } from "../drainCaptures";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  apiFetchMultipart: jest.fn(),
  currentUserId: jest.fn(() => "uid-1"),
}));

// The cache is a fixture here; foodCache has its own suite. Only the fallback
// wiring is under test.
jest.mock("../foodCache", () => ({ getFoodByBarcode: jest.fn(async () => null) }));

const CODE = "5000112637922";

// What the server returns for a barcode it knows: exactly one candidate at
// tier "auto" (api/internal/resolve/handler.go's barcodeCandidate).
const SERVER_HIT = {
  tier: "auto",
  candidates: [{ item: { id: "food-1", name: "Coke Zero 330ml" }, portion_grams: 330 }],
};

const CACHED_FOOD = {
  id: "food-1", name: "Coke Zero 330ml", barcode: CODE, serving_grams: 330,
  kcal_per_100g: 0,
};

// drainCaptures only ever calls invalidateQueries on this.
const queryClient = { invalidateQueries: jest.fn() } as never;

// An error the way @/lib/api reports one that DID reach the server.
function httpError(status: number): Error {
  return Object.assign(new Error(`http ${status}`), { status });
}

async function seedBarcode() {
  await appendCapture({
    id: "cap_1754006400000_aaaaaa", kind: "barcode", code: CODE,
    capturedAt: "2026-08-21T10:00:00.000Z", ownerId: "uid-1",
  } as Parameters<typeof appendCapture>[0]);
}

beforeEach(async () => {
  await AsyncStorage.clear();
  (apiFetch as jest.Mock).mockReset().mockResolvedValue(SERVER_HIT);
  (getFoodByBarcode as jest.Mock).mockReset().mockResolvedValue(null);
});

test("a queued barcode drains against /v1/resolve/barcode", async () => {
  await seedBarcode();

  await drainCaptures(queryClient);

  // The Go handler binds `barcode`, not `code` — barcodeRequest in
  // api/internal/resolve/handler.go. The wrong key binds to the empty string
  // and 400s as invalid_input, which the drain classifies as PERMANENT: the
  // row is failed, not retried, so the scan is lost for good.
  expect(apiFetch).toHaveBeenCalledWith("/v1/resolve/barcode", {
    method: "POST",
    body: JSON.stringify({ barcode: CODE }),
  });
});

test("a resolved barcode becomes a queued log and leaves the capture queue", async () => {
  await seedBarcode();

  await drainCaptures(queryClient);

  const logs = await listLogs();
  expect(logs).toHaveLength(1);
  expect(logs[0].payload).toMatchObject({ food_item_id: "food-1", source: "ai_barcode" });
  expect(await listCaptures()).toEqual([]);
});

// The connection came back but is flaky. The device may now hold this exact
// product — the user can have scanned it online in between, and
// useResolveBarcode caches what it resolves — so answering from the cache
// beats deferring the row another pass.
test("falls back to the local cache when the request never reached the server", async () => {
  await seedBarcode();
  (apiFetch as jest.Mock).mockRejectedValue(new Error("Network request failed"));
  (getFoodByBarcode as jest.Mock).mockResolvedValue(CACHED_FOOD);

  await drainCaptures(queryClient);

  expect(getFoodByBarcode).toHaveBeenCalledWith(CODE);
  // Review, not logged: resolutionFromCachedFood is deliberately
  // `tier: "confirm"` and marks its provenance, so a cache answer can never
  // be mistaken for a fresh server one.
  const [row] = await listCaptures();
  expect(row).toMatchObject({ status: "review" });
  expect(row!.resolution?.provenance).toBe(CACHED_MATCH_TIER);
});

// A 4xx is the server REFUSING this code. Papering over it with a local guess
// would turn a delivery failure into an answer the server rejected.
test("does not consult the cache when the server answered with an error", async () => {
  await seedBarcode();
  (apiFetch as jest.Mock).mockRejectedValue(httpError(400));
  (getFoodByBarcode as jest.Mock).mockResolvedValue(CACHED_FOOD);

  await drainCaptures(queryClient);

  expect(getFoodByBarcode).not.toHaveBeenCalled();
  expect((await listCaptures())[0]).toMatchObject({ status: "failed", failureKind: "delivery" });
});

// Still offline at drain time, still unseen: the row must stay pending and
// keep its retries, not fail.
test("keeps the row pending when neither the server nor the cache can answer", async () => {
  await seedBarcode();
  (apiFetch as jest.Mock).mockRejectedValue(new Error("Network request failed"));

  await drainCaptures(queryClient);

  expect((await listCaptures())[0]).toMatchObject({ status: "pending", attempts: 0 });
});
