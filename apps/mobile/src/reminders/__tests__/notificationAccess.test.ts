import { Linking } from "react-native";
import * as Notifications from "expo-notifications";
import {
  ensureNotificationAccess,
  notifyNotificationAccessDenied,
  openNotificationSettings,
} from "../notificationAccess";

jest.mock("expo-notifications", () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));

const mockOpenNativeNotificationSettings = jest.fn();
jest.mock("../../../modules/widget-bridge", () => ({
  openNotificationSettings: (...args: unknown[]) => mockOpenNativeNotificationSettings(...args),
}));

const mockGetPermissions = Notifications.getPermissionsAsync as jest.Mock;
const mockRequestPermissions = Notifications.requestPermissionsAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ensureNotificationAccess", () => {
  test("already granted short-circuits without prompting", async () => {
    mockGetPermissions.mockResolvedValue({ granted: true });

    const result = await ensureNotificationAccess();

    expect(result).toEqual({ granted: true, blocked: false });
    expect(mockRequestPermissions).not.toHaveBeenCalled();
  });

  test("undetermined + fresh prompt granted resolves granted", async () => {
    mockGetPermissions.mockResolvedValue({ granted: false, canAskAgain: true });
    mockRequestPermissions.mockResolvedValue({ granted: true, canAskAgain: true });

    const result = await ensureNotificationAccess();

    expect(result).toEqual({ granted: true, blocked: false });
  });

  test("denied with canAskAgain false is blocked — only Settings can fix it", async () => {
    mockGetPermissions.mockResolvedValue({ granted: false, canAskAgain: false });
    mockRequestPermissions.mockResolvedValue({ granted: false, canAskAgain: false });

    const result = await ensureNotificationAccess();

    expect(result).toEqual({ granted: false, blocked: true });
  });

  test("denied after a fresh prompt (canAskAgain still true) is not blocked", async () => {
    mockGetPermissions.mockResolvedValue({ granted: false, canAskAgain: true });
    mockRequestPermissions.mockResolvedValue({ granted: false, canAskAgain: true });

    const result = await ensureNotificationAccess();

    expect(result).toEqual({ granted: false, blocked: false });
  });
});

describe("notifyNotificationAccessDenied", () => {
  test("blocked shows the Open Settings action wired to openNotificationSettings", async () => {
    const show = jest.fn();
    mockOpenNativeNotificationSettings.mockResolvedValue(true);

    notifyNotificationAccessDenied({ show }, true);

    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Notifications are off for Kora. Turn them on in Settings to get reminders.",
        actionLabel: "Open Settings",
        onAction: expect.any(Function),
      }),
    );
    await show.mock.calls[0][0].onAction();
    expect(mockOpenNativeNotificationSettings).toHaveBeenCalled();
  });

  test("not blocked shows a plain toast with no action", () => {
    const show = jest.fn();

    notifyNotificationAccessDenied({ show }, false);

    expect(show).toHaveBeenCalledWith({ message: "Reminders need notification permission." });
  });
});

describe("openNotificationSettings", () => {
  test("prefers the native method when present", async () => {
    mockOpenNativeNotificationSettings.mockResolvedValue(true);
    const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);

    await openNotificationSettings();

    expect(mockOpenNativeNotificationSettings).toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
  });

  test("falls back to Linking.openSettings when the native method resolves false (missing or throws)", async () => {
    mockOpenNativeNotificationSettings.mockResolvedValue(false);
    const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);

    await openNotificationSettings();

    expect(mockOpenNativeNotificationSettings).toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalled();
  });
});
