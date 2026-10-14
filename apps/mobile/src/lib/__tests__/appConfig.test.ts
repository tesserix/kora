import { isUpdateRequired } from "../appConfig";

let mockBuild: string | null = "40";
// A getter, because the module is imported before this file's body runs and
// a plain value would be copied at that moment.
jest.mock("expo-application", () => ({
  get nativeBuildVersion() {
    return mockBuild;
  },
}));

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  mockBuild = "40";
});

function config(minBuild: unknown) {
  return { ok: true, json: async () => ({ data: { min_build: minBuild } }) };
}

test("a build below the floor must update", async () => {
  fetchMock.mockResolvedValue(config({ ios: 41, android: 1 }));
  await expect(isUpdateRequired()).resolves.toBe(true);
  expect(fetchMock.mock.calls[0][0]).toMatch(/\/v1\/app-config$/);
  // No token: the builds this stops cannot sign in.
  expect(fetchMock.mock.calls[0][1]?.headers).toBeUndefined();
});

test("a build at or above the floor carries on", async () => {
  fetchMock.mockResolvedValue(config({ ios: 40, android: 99 }));
  await expect(isUpdateRequired()).resolves.toBe(false);
});

test("fails open on every uncertainty", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
  await expect(isUpdateRequired()).resolves.toBe(false);

  fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
  await expect(isUpdateRequired()).resolves.toBe(false);

  fetchMock.mockResolvedValueOnce(config({ ios: "41" }));
  await expect(isUpdateRequired()).resolves.toBe(false);

  mockBuild = null;
  fetchMock.mockResolvedValueOnce(config({ ios: 41 }));
  await expect(isUpdateRequired()).resolves.toBe(false);
});
