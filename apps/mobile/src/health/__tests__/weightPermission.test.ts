import {
  AuthorizationRequestStatus,
  getRequestStatusForAuthorization,
  requestAuthorization,
} from "@kingstinct/react-native-healthkit";
import { requestWeightPermission, weightPermissionRequested } from "../weightPermission";

// @kingstinct/react-native-healthkit is globally mocked in jest.setup.js as
// jest.fn()s; grab the references and configure them per test, the same
// pattern useHealth.test.tsx already uses.
const mockGetRequestStatus = getRequestStatusForAuthorization as jest.Mock;
const mockRequestAuthorization = requestAuthorization as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

describe("weightPermissionRequested", () => {
  // `unnecessary` is HealthKit saying "requesting would show no sheet", i.e.
  // the user HAS been asked. It says nothing about whether they said yes --
  // Apple hides that -- and this gate does not need to know.
  test("reports requested when the status is unnecessary", async () => {
    mockGetRequestStatus.mockResolvedValue(AuthorizationRequestStatus.unnecessary);

    await expect(weightPermissionRequested()).resolves.toBe(true);
  });

  // The state a fresh install is in, and the whole point of #375: asking here
  // would put the Health sheet in front of a user who has been given no
  // reason for it.
  test("reports not requested when the status is shouldRequest", async () => {
    mockGetRequestStatus.mockResolvedValue(AuthorizationRequestStatus.shouldRequest);

    await expect(weightPermissionRequested()).resolves.toBe(false);
  });

  // `unknown` means HealthKit could not answer at all. "No sheet has been
  // shown" is the honest reading, and false keeps callers conservative.
  test("reports not requested when the status is unknown", async () => {
    mockGetRequestStatus.mockResolvedValue(AuthorizationRequestStatus.unknown);

    await expect(weightPermissionRequested()).resolves.toBe(false);
  });

  test("asks HealthKit about body mass specifically", async () => {
    mockGetRequestStatus.mockResolvedValue(AuthorizationRequestStatus.unnecessary);

    await weightPermissionRequested();

    expect(mockGetRequestStatus).toHaveBeenCalledWith({ toRead: ["HKQuantityTypeIdentifierBodyMass"] });
  });

  // Never checks the status by requesting authorization -- that IS the bug.
  test("never requests authorization just to read the status", async () => {
    mockGetRequestStatus.mockResolvedValue(AuthorizationRequestStatus.shouldRequest);

    await weightPermissionRequested();

    expect(mockRequestAuthorization).not.toHaveBeenCalled();
  });
});

describe("requestWeightPermission", () => {
  test("requests read access to body mass", async () => {
    mockRequestAuthorization.mockResolvedValue(true);

    await requestWeightPermission();

    expect(mockRequestAuthorization).toHaveBeenCalledWith({ toRead: ["HKQuantityTypeIdentifierBodyMass"] });
  });

  // The library's boolean reports that the REQUEST completed, not that reads
  // were granted (Apple does not expose that). A false must not be mistaken
  // for a failure and must not throw.
  test("resolves even when the request reports false", async () => {
    mockRequestAuthorization.mockResolvedValue(false);

    await expect(requestWeightPermission()).resolves.toBeUndefined();
  });

  test("propagates a rejected request so the caller can decide", async () => {
    mockRequestAuthorization.mockRejectedValue(new Error("HealthKit refused"));

    await expect(requestWeightPermission()).rejects.toThrow("HealthKit refused");
  });
});
