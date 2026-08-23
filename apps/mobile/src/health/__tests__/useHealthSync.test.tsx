import { renderHook, waitFor } from "@testing-library/react-native";
import { Platform } from "react-native";
import {
  AuthorizationRequestStatus,
  getRequestStatusForAuthorization,
  isHealthDataAvailable,
  queryQuantitySamplesWithAnchor,
  requestAuthorization,
} from "@kingstinct/react-native-healthkit";
import { useHealthSync } from "../useHealthSync";

// The real "@/lib/api" pulls in firebase/auth (real ESM) which Jest cannot
// parse unmocked — the same reason LogWeightSheet.test.tsx mocks it.
const mockApiFetch = jest.fn();
jest.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

// The sync's auth gate. Signed-in is the only state that reaches HealthKit at
// all, so it is the default here and the interesting cases override it.
const mockResolveAuthState = jest.fn();
jest.mock("@/lib/authState", () => ({ resolveAuthState: () => mockResolveAuthState() }));

// The anchor is the whole self-healing mechanism (see syncWeight.ts): mocked
// so a test can assert it was NOT advanced, which is what "this launch was
// skipped and will retry" looks like from the outside.
const mockReadAnchor = jest.fn();
const mockWriteAnchor = jest.fn();
jest.mock("../anchorStore", () => ({
  readAnchor: (...args: unknown[]) => mockReadAnchor(...args),
  writeAnchor: (...args: unknown[]) => mockWriteAnchor(...args),
}));

const mockIsAvailable = isHealthDataAvailable as jest.Mock;
const mockGetRequestStatus = getRequestStatusForAuthorization as jest.Mock;
const mockRequestAuthorization = requestAuthorization as jest.Mock;
const mockQueryWithAnchor = queryQuantitySamplesWithAnchor as jest.Mock;

// Platform.OS is a getter on a shared singleton under jest-expo, so — as with
// useHealth.test.tsx — it is overridden via defineProperty rather than
// jest.mock, which does not intercept jest-expo's own react-native mock.
const originalOS = Platform.OS;
function setPlatformOS(os: string) {
  Object.defineProperty(Platform, "OS", { get: () => os, configurable: true });
}

// Obviously synthetic: this repo is public, so no real body measurements
// appear anywhere, not even in fixtures.
const SYNTHETIC_KG = 11.1;

function anchoredResponse() {
  return {
    samples: [
      {
        uuid: "sample-1",
        quantity: SYNTHETIC_KG,
        startDate: new Date("2026-08-23T07:00:00.000Z"),
        sourceRevision: { source: { name: "Test Scale" } },
      },
    ],
    newAnchor: "anchor-2",
  };
}

beforeEach(() => {
  setPlatformOS("ios");
  mockResolveAuthState.mockResolvedValue("signed-in");
  mockReadAnchor.mockResolvedValue("anchor-1");
  mockWriteAnchor.mockResolvedValue(undefined);
  mockApiFetch.mockResolvedValue({ accepted: 1, rejected: [] });
  mockIsAvailable.mockReturnValue(true);
  mockQueryWithAnchor.mockResolvedValue(anchoredResponse());
});

afterEach(() => {
  setPlatformOS(originalOS);
  jest.clearAllMocks();
});

// A negative assertion made straight after render passes for free, because
// the effect's async chain has not run yet. Letting the event loop turn a few
// times first is what makes "never called" mean the run finished WITHOUT
// calling it, rather than "has not got there yet".
//
// Deliberately NOT wrapped in act(): renderHook already has an act() of its
// own in flight, a second one overlapping it is unsupported (React logs
// exactly that and the queued work never drains), and this hook sets no state
// at all — it only fires effects — so there is nothing for act to flush.
async function flushSync() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

// #375, the bug itself. useHealthSync is mounted at the app root
// (app/_layout.tsx), so anything it does happens on the very first launch,
// before the user has been shown a single screen that explains Health. It
// must therefore never be the caller that triggers iOS's permission sheet.
test("never requests HealthKit authorization on the launch path", async () => {
  mockGetRequestStatus.mockResolvedValue(AuthorizationRequestStatus.shouldRequest);

  renderHook(() => useHealthSync());

  await waitFor(() => expect(mockGetRequestStatus).toHaveBeenCalled());
  await flushSync();
  expect(mockRequestAuthorization).not.toHaveBeenCalled();
});

test("does not query HealthKit before the user has ever been prompted", async () => {
  mockGetRequestStatus.mockResolvedValue(AuthorizationRequestStatus.shouldRequest);

  renderHook(() => useHealthSync());

  await waitFor(() => expect(mockGetRequestStatus).toHaveBeenCalled());
  await flushSync();
  expect(mockQueryWithAnchor).not.toHaveBeenCalled();
  expect(mockApiFetch).not.toHaveBeenCalled();
});

// The skipped launch must cost nothing. syncWeight only advances the anchor
// after a successful query, so throwing out of the gate leaves the cursor
// where it was and the first launch AFTER the prompt still picks up the full
// window — nothing is silently skipped forever.
test("leaves the anchor untouched when the prompt has not happened, so the next launch retries", async () => {
  mockGetRequestStatus.mockResolvedValue(AuthorizationRequestStatus.shouldRequest);

  renderHook(() => useHealthSync());

  await waitFor(() => expect(mockGetRequestStatus).toHaveBeenCalled());
  await flushSync();
  expect(mockWriteAnchor).not.toHaveBeenCalled();
});

// `unknown` is HealthKit declining to answer. Treating it as "not prompted"
// keeps the launch path on the conservative side.
test("skips the sync when the request status is unknown", async () => {
  mockGetRequestStatus.mockResolvedValue(AuthorizationRequestStatus.unknown);

  renderHook(() => useHealthSync());

  await waitFor(() => expect(mockGetRequestStatus).toHaveBeenCalled());
  await flushSync();
  expect(mockQueryWithAnchor).not.toHaveBeenCalled();
  expect(mockWriteAnchor).not.toHaveBeenCalled();
});

// The other half of the acceptance criteria: once the user HAS been prompted
// (whatever they answered — Apple does not tell us), the launch/foreground
// sync must work exactly as it did before this change.
test("syncs as before once the permission has been requested", async () => {
  mockGetRequestStatus.mockResolvedValue(AuthorizationRequestStatus.unnecessary);

  renderHook(() => useHealthSync());

  await waitFor(() => expect(mockQueryWithAnchor).toHaveBeenCalled());
  expect(mockQueryWithAnchor).toHaveBeenCalledWith(
    "HKQuantityTypeIdentifierBodyMass",
    expect.objectContaining({ anchor: "anchor-1", unit: "kg" }),
  );
  await waitFor(() => expect(mockWriteAnchor).toHaveBeenCalledWith("weight", "anchor-2"));
  expect(mockApiFetch).toHaveBeenCalledWith("/v1/health/sync", expect.objectContaining({ method: "POST" }));
  // Even on the happy path the sheet is never shown from here.
  expect(mockRequestAuthorization).not.toHaveBeenCalled();
});

// The gate is not reached at all on the paths that were already guarded —
// asserted so the new call cannot become a per-launch native round-trip for
// users it can never help.
test("does not ask about permission on a non-iOS platform", async () => {
  setPlatformOS("android");
  mockGetRequestStatus.mockResolvedValue(AuthorizationRequestStatus.unnecessary);

  renderHook(() => useHealthSync());
  await flushSync();

  expect(mockResolveAuthState).not.toHaveBeenCalled();
  expect(mockGetRequestStatus).not.toHaveBeenCalled();
});

test("does not ask about permission while signed out", async () => {
  mockResolveAuthState.mockResolvedValue("signed-out");
  mockGetRequestStatus.mockResolvedValue(AuthorizationRequestStatus.unnecessary);

  renderHook(() => useHealthSync());
  await flushSync();

  expect(mockResolveAuthState).toHaveBeenCalled();
  expect(mockGetRequestStatus).not.toHaveBeenCalled();
});

// HealthKit being unavailable outranks the permission question: there is
// nothing to be prompted about.
test("does not ask about permission when HealthKit itself is unavailable", async () => {
  mockIsAvailable.mockReturnValue(false);
  mockGetRequestStatus.mockResolvedValue(AuthorizationRequestStatus.unnecessary);

  renderHook(() => useHealthSync());
  await flushSync();

  expect(mockReadAnchor).toHaveBeenCalled();
  expect(mockGetRequestStatus).not.toHaveBeenCalled();
  expect(mockWriteAnchor).not.toHaveBeenCalled();
});
