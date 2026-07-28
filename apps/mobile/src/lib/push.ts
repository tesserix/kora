import { useEffect } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { onAuthStateChanged } from "firebase/auth";
import { router } from "expo-router";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { registerDevice, unregisterDevice } from "@/lib/pushApi";
import { targetFor } from "@/lib/notificationTarget";
import { loadPrefs } from "@/reminders/prefs";
import { loadCustom } from "@/reminders/customPrefs";
import { applyAllReminders } from "@/reminders/schedule";
import type { NotificationType } from "@/api/types";

const TOKEN_KEY = "kora.pushToken";

function projectId(): string | undefined {
  return Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
}

// registerPushToken requests permission, fetches the Expo push token, and
// registers it with the API. It is a silent no-op until the EAS projectId
// exists (i.e. before `eas init`) or if the user denies notifications.
export async function registerPushToken(): Promise<void> {
  const pid = projectId();
  if (!pid) return;

  const current = await Notifications.getPermissionsAsync();
  let status = current.status;
  if (status !== "granted") {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== "granted") return;

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: pid });
  await AsyncStorage.setItem(TOKEN_KEY, token);
  await registerDevice(token, Platform.OS);
}

// unregisterPushToken removes the device binding for the cached token so a
// shared device stops receiving the previous user's push.
export async function unregisterPushToken(): Promise<void> {
  const token = await AsyncStorage.getItem(TOKEN_KEY);
  if (!token) return;
  await unregisterDevice(token);
  await AsyncStorage.removeItem(TOKEN_KEY);
}

// usePushRegistration registers the device whenever a user signs in.
export function usePushRegistration(): void {
  useEffect(() => {
    if (!isFirebaseConfigured || !auth) return;
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) void registerPushToken();
    });
    return unsub;
  }, []);
}

// setupPushHandler configures how foreground notifications are presented.
// Verified against the installed expo-notifications@57 types and the v57 docs:
// shouldShowBanner/shouldShowList replaced the deprecated shouldShowAlert in SDK 54+.
export function setupPushHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  // Reschedule reminders on every launch so they survive reinstalls and
  // permission changes. setupPushHandler runs once at module scope
  // (app/_layout.tsx), so no additional once-guard is needed here.
  void Promise.all([loadPrefs(), loadCustom()])
    .then(([mealPrefs, customs]) => applyAllReminders(mealPrefs, customs))
    .catch(() => {});
}

// usePushResponder deep-links when the user taps a push.
export function usePushResponder(): void {
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as {
        type?: NotificationType;
        entity_id?: string;
        kind?: string;
      };
      if (data?.kind === "reminder") {
        router.push("/capture");
        return;
      }
      if (data?.kind === "custom") {
        router.push("/");
        return;
      }
      if (!data?.type) return;
      const target = targetFor({ type: data.type, entity_id: data.entity_id });
      if (target) router.push(target);
    });
    return () => sub.remove();
  }, []);
}
