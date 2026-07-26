import { useEffect } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { onAuthStateChanged } from "firebase/auth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { registerDevice, unregisterDevice } from "@/lib/pushApi";

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
