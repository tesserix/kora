import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient } from "@tanstack/react-query";
import { append, list } from "../queue";
import { drainLogs } from "../drainLogs";
import { apiFetch, currentUserId } from "@/lib/api";

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
  currentUserId: jest.fn(() => "user-a"),
  ApiError: class ApiError extends Error {},
}));

const payload = {
  food_item_id: "f1", meal_slot: "lunch", source: "manual",
  quantity_grams: 100, logged_at: "2026-08-02T12:00:00.000Z",
};

const sentIds = () =>
  (apiFetch as jest.Mock).mock.calls.map((c) => JSON.parse(c[1].body).id);

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  (currentUserId as jest.Mock).mockReturnValue("user-a");
});

// The cold-start trigger fires before Firebase has restored the session from
// AsyncStorage. An unauthenticated POST carries no Authorization header, comes
// straight back 401 (api.ts skips refresh-and-retry when there is no user), and
// would strand every queued log. So a signed-out drain must not send at all.
test("drainLogs sends nothing while signed out and leaves the item untouched", async () => {
  (currentUserId as jest.Mock).mockReturnValue(null);
  // What the server really answers an unauthenticated POST with.
  (apiFetch as jest.Mock).mockRejectedValue(
    Object.assign(new Error("unauthenticated"), { name: "ApiError", status: 401 }),
  );
  await append(payload, "id-1", "user-a");

  await drainLogs(new QueryClient());

  expect(apiFetch).not.toHaveBeenCalled();
  // Not merely "no POST": the item must still be a candidate for the next
  // drain, untouched — same status, same attempt count.
  const items = await list();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: "id-1", status: "pending", attempts: 0 });
});

test("drainLogs POSTs each queued item with its id and clears the queue", async () => {
  (apiFetch as jest.Mock).mockResolvedValue({ id: "id-1" });
  await append(payload, "id-1", "user-a");

  await drainLogs(new QueryClient());

  expect(apiFetch).toHaveBeenCalledWith("/v1/logs", expect.objectContaining({ method: "POST" }));
  const body = JSON.parse((apiFetch as jest.Mock).mock.calls[0][1].body);
  expect(body.id).toBe("id-1");
  expect(await list()).toHaveLength(0);
});

// A stand-in for the real POST /v1/logs, faithful to what
// api/internal/foodlog Repository.CreateIdempotent actually does:
//   - the insert is attempted FIRST, then the response is written, so a lost
//     response leaves a row behind that the client never learns about;
//   - a write whose id is already stored inserts nothing and returns the
//     stored row (ON CONFLICT DO NOTHING + reload), so a replay converges;
//   - a write with NO id gets a server-minted one, so replaying an id-less
//     write inserts a SECOND row. That last branch is what makes this fake
//     able to catch a client that stops sending the id.
function fakeServer() {
  const rows = new Map<string, unknown>();
  let loseNext = false;
  let minted = 0;
  return {
    rows,
    loseNextResponse() { loseNext = true; },
    async handle(_path: string, init: RequestInit) {
      const body = JSON.parse(init.body as string) as { id?: string };
      const id = body.id ?? `server-minted-${++minted}`;
      const existing = rows.get(id);
      const row = existing ?? { ...body, id };
      if (!existing) rows.set(id, row);
      if (loseNext) {
        loseNext = false;
        // The write is already applied; only the response is lost.
        throw Object.assign(new Error("Network request failed"), { name: "NetworkError" });
      }
      return row;
    },
  };
}

// The property the whole design turns on: the server applied the write but the
// response was lost, so the item is still queued. Replaying must converge on
// ONE row, and the client must treat the replay as success.
test("a replay after a lost response converges on one server row rather than duplicating", async () => {
  const server = fakeServer();
  (apiFetch as jest.Mock).mockImplementation((path: string, init: RequestInit) => server.handle(path, init));
  server.loseNextResponse();

  await append(payload, "id-1", "user-a");

  await drainLogs(new QueryClient());
  expect(server.rows.size).toBe(1);      // the write DID land server-side
  expect(await list()).toHaveLength(1);  // the client never heard, so it stays queued

  await drainLogs(new QueryClient());
  expect(await list()).toHaveLength(0);  // the replay is accepted as success
  expect(server.rows.size).toBe(1);      // and did NOT duplicate the meal
});

// Cold start, onlineManager.subscribe and AppState "active" all fire a drain,
// and on launch they overlap. Two concurrent passes would send the same item
// twice, and queue.drain's read-modify-write failure path can resurrect an
// item the other pass already discarded.
test("two overlapping drains send each queued item exactly once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  (apiFetch as jest.Mock).mockImplementation(async () => { await gate; return {}; });

  await append(payload, "id-1", "user-a");
  await append(payload, "id-2", "user-a");

  const first = drainLogs(new QueryClient());
  const second = drainLogs(new QueryClient());
  release();
  await Promise.all([first, second]);

  expect(sentIds()).toEqual(["id-1", "id-2"]);
  expect(await list()).toHaveLength(0);
});

test("the in-flight guard clears after a drain that rejects", async () => {
  (apiFetch as jest.Mock).mockResolvedValue({});
  await append(payload, "id-1", "user-a");

  const failing = new QueryClient();
  jest.spyOn(failing, "invalidateQueries").mockImplementation(() => { throw new Error("boom"); });
  await expect(drainLogs(failing)).rejects.toThrow("boom");

  // A guard that only cleared on success would wedge the queue forever: this
  // second drain would hand back the first one's rejected promise and send
  // nothing.
  await append(payload, "id-2", "user-a");
  await expect(drainLogs(new QueryClient())).resolves.toBeUndefined();
  expect(sentIds()).toEqual(["id-1", "id-2"]);
});

test("drainLogs invalidates logs and dashboard after sending", async () => {
  (apiFetch as jest.Mock).mockResolvedValue({ id: "id-1" });
  await append(payload, "id-1", "user-a");

  const qc = new QueryClient();
  const spy = jest.spyOn(qc, "invalidateQueries");
  await drainLogs(qc);

  expect(spy).toHaveBeenCalledWith({ queryKey: ["logs"] });
  expect(spy).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
});

// The server-backed views cost a network round trip each, so a pass that sent
// nothing must not refetch them. The queued rows are the exception: they are
// read straight off local storage, and a pass that sent nothing may still have
// flipped one pending -> failed, or may simply be the first pass to learn who
// is signed in (the diary's owner filter returns nothing until then).
test("a drain that sent nothing refreshes only the queued rows, not the server views", async () => {
  const qc = new QueryClient();
  const spy = jest.spyOn(qc, "invalidateQueries");

  await drainLogs(qc);

  expect(spy).not.toHaveBeenCalledWith({ queryKey: ["logs"] });
  expect(spy).not.toHaveBeenCalledWith({ queryKey: ["dashboard"] });
  expect(spy).toHaveBeenCalledWith({ queryKey: ["queuedLogs"] });
});
