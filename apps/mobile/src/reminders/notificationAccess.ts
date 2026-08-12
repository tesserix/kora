import { Linking } from "react-native";
import * as Notifications from "expo-notifications";
import { openNotificationSettings as openNativeNotificationSettings } from "../../modules/widget-bridge";

export type NotificationAccessResult = { granted: boolean; blocked: boolean };

type ToastApi = { show: (o: { message: string; actionLabel?: string; onAction?: () => void }) => void };

const BLOCKED_MESSAGE = "Notifications are off for Kora. Turn them on in Settings to get reminders.";
const DECLINED_MESSAGE = "Reminders need notification permission.";

// notifyNotificationAccessDenied surfaces the ONE bit of feedback the bug report
// was about: a denied enable used to revert the switch in total silence. When
// iOS has permanently blocked the app (no re-prompt possible), the toast offers
// a direct route to Settings; otherwise it's a plain heads-up since a fresh
// system prompt is still available next time.
export function notifyNotificationAccessDenied(toast: ToastApi, blocked: boolean): void {
  if (blocked) {
    toast.show({ message: BLOCKED_MESSAGE, actionLabel: "Open Settings", onAction: () => void openNotificationSettings() });
  } else {
    toast.show({ message: DECLINED_MESSAGE });
  }
}

// Deep-links straight to Kora's Notifications pane in iOS Settings, saving
// the tap from Settings→Kora→Notifications the plain Linking.openSettings()
// route leaves the user with. Falls back to Linking.openSettings() when the
// native method is missing (a dev client built before this shipped won't
// have it until the next native build) or throws.
export async function openNotificationSettings(): Promise<void> {
  const opened = await openNativeNotificationSettings();
  if (!opened) {
    await Linking.openSettings();
  }
}

// ensureNotificationAccess centralises the get→request OS permission flow so
// every reminder surface (meal slots, custom reminders, weight check-in) shares
// one definition of "denied" vs "permanently blocked".
//
// `blocked` is true only when the final status is denied AND canAskAgain is
// false — the state iOS puts an app in after ONE denial, since it never
// re-prompts. In that state only the Settings app can restore permission, so
// callers use `blocked` to decide whether a toast needs an "Open Settings"
// action or just plain copy telling the user a fresh prompt was declined.
export async function ensureNotificationAccess(): Promise<NotificationAccessResult> {
  const perm = await Notifications.getPermissionsAsync();
  if (perm.granted) return { granted: true, blocked: false };

  const req = await Notifications.requestPermissionsAsync();
  if (req.granted) return { granted: true, blocked: false };

  return { granted: false, blocked: req.canAskAgain === false };
}
