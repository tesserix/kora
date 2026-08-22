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
import { reconcileWeightReminder } from "@/reminders/reconcileWeightReminder";
import { resolveAuthState } from "@/lib/authState";
import type { NotificationType } from "@/api/types";
import { recordMentorCheckIn } from "@/mentor/checkInOutbox";
import {
  MENTOR_ACTION_CHANGE,
  MENTOR_ACTION_DONE,
  MENTOR_ACTION_SNOOZE,
  MENTOR_NOTIFICATION_CATEGORY,
} from "@/mentor/notificationConstants";

const TOKEN_KEY = "kora.pushToken";

function projectId(): string | undefined {
  return Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
}

// registerPushToken requests permission, fetches the Expo push token, and
// registers it with the API. It is a silent no-op until the EAS projectId
// exists (i.e. before `eas init`) or if the user denies notifications.
//
// It never rejects. Push is best-effort, and its only caller is a floating
// `void registerPushToken()` on sign-in, so anything thrown here would land as
// an unhandled rejection — a red LogBox box on top of the UI in development,
// covering the footer's primary button. Every step is genuinely fallible:
// there is no push service on a simulator, a real device can be offline, and
// the API can refuse. None of that should disturb an otherwise good sign-in;
// registration simply retries on the next one.
export async function registerPushToken(): Promise<void> {
  const pid = projectId();
  if (!pid) return;

  try {
    const current = await Notifications.getPermissionsAsync();
    let status = current.status;
    if (status !== "granted") {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== "granted") return;

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: pid });
    await AsyncStorage.setItem(TOKEN_KEY, token);
    await registerDevice(token, Platform.OS);
  } catch {
    // Deliberately swallowed — see above. There is no logger in this app
    // (`console` is unused across app/ and src/), and the repo's convention for
    // best-effort side effects is a commented catch: see src/motion/haptics.ts.
  }
}

// unregisterPushToken removes the device binding for the cached token so a
// shared device stops receiving the previous user's push.
export async function unregisterPushToken(): Promise<void> {
  const token = await AsyncStorage.getItem(TOKEN_KEY);
  if (!token) return;
  await unregisterDevice(token);
  await AsyncStorage.removeItem(TOKEN_KEY);
}

// usePushRegistration registers the device whenever a user signs in, and
// re-arms that user's local reminders at the same moment.
//
// The reminder half exists because the launch pass is now gated on a signed-in
// user (#171): a launch that lands on the sign-in screen deliberately arms
// nothing and disarms whatever was left over. Without this, a user who then
// signs in would have no reminders for the rest of the session — the next
// foreground pass would eventually fix it, which is not the same as working.
export function usePushRegistration(): void {
  useEffect(() => {
    if (!isFirebaseConfigured || !auth) return;
    const unsub = onAuthStateChanged(auth, (user) => {
      if (!user) return;
      void registerPushToken();
      void reconcileWeightReminder().catch(() => {});
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
  void Notifications.setNotificationCategoryAsync(MENTOR_NOTIFICATION_CATEGORY, [
    {
      identifier: MENTOR_ACTION_DONE,
      buttonTitle: "Done",
      options: { opensAppToForeground: false },
    },
    {
      identifier: MENTOR_ACTION_SNOOZE,
      buttonTitle: "Snooze 15 min",
      options: { opensAppToForeground: false },
    },
    {
      identifier: MENTOR_ACTION_CHANGE,
      buttonTitle: "Change",
      options: { opensAppToForeground: true },
    },
  ]).catch(() => {});
  // Reschedule reminders on every launch so they survive reinstalls and
  // permission changes. setupPushHandler runs once at module scope
  // (app/_layout.tsx), so no additional once-guard is needed here.
  //
  // No argument: this launch witnessed no weigh-in, but the user may well have
  // logged one before swiping the app away. Passing a placeholder `null` here
  // used to re-arm today's reminder on every relaunch — weigh in at 06:40,
  // reopen at 06:50, buzz at 07:00. reconcileWeightReminder now looks the real
  // date up itself.
  void reconcileWeightReminder().catch(() => {});
}

// handledResponseKey de-duplicates deliveries of the SAME notification response.
//
// Module scope, deliberately: the duplicates come from the listener being
// re-registered. usePushResponder is called at the top of TabsLayout, which
// remounts (auth resolving, the profile query settling, the onboarding
// redirect), and expo-notifications re-delivers the pending launch response to
// each newly added listener. One tap therefore produced several navigations —
// the device report needed the capture screen closed 3-4 times before it
// stopped. Per-hook state would reset on exactly the remounts that cause this.
//
// The key is the DELIVERY, not the scheduled request: a DAILY trigger keeps one
// request identifier for every occurrence, so keying on the identifier alone
// would kill tomorrow's deep link.
let handledResponseKey: string | null = null;

function responseKey(response: Notifications.NotificationResponse): string {
  const { identifier } = response.notification.request;
  return `${identifier}:${response.notification.date ?? ""}:${response.actionIdentifier ?? ""}`;
}

type MentorNotificationData = {
  kind: "mentor";
  commitmentId: string;
  scheduledFor: string;
  localDate: string;
};

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function mentorNotificationData(
  data: unknown,
  deliveredAt: number,
): MentorNotificationData | null {
  const value = data as Partial<MentorNotificationData> | null;
  if (!value
    || value.kind !== "mentor"
    || typeof value.commitmentId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value.commitmentId)) return null;
  if (typeof value.scheduledFor === "string"
    && Number.isFinite(Date.parse(value.scheduledFor))
    && typeof value.localDate === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value.localDate)) {
    return value as MentorNotificationData;
  }
  const delivered = new Date(deliveredAt);
  if (!Number.isFinite(delivered.getTime())) return null;
  return {
    kind: "mentor",
    commitmentId: value.commitmentId,
    scheduledFor: delivered.toISOString(),
    localDate: localDate(delivered),
  };
}

// usePushResponder deep-links when the user taps a push.
//
// Every target is `replace`, never `push`. These are entry points, not steps in
// a journey: a second delivery must land the user on the destination, not stack
// a second copy of it on top of the first.
export function usePushResponder(): void {
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(async (response) => {
      // Claimed synchronously, before the first await, so two deliveries racing
      // each other cannot both pass this guard.
      const key = responseKey(response);
      if (key === handledResponseKey) return;
      handledResponseKey = key;

      // Auth gate (#171). The listener is registered at the top of TabsLayout,
      // whereas the onAuthStateChanged -> /sign-in redirect runs later in an
      // effect, so this callback is live during the signed-out moments of a
      // launch — which is how a deleted account's reminder opened the capture
      // screen on the sign-in screen.
      //
      // Awaited rather than read from auth.currentUser: persistence is
      // AsyncStorage-backed, so a signed-in user cold-starting FROM a
      // notification tap has a null currentUser at delivery time, and a
      // synchronous check would drop their deep link. The key is already
      // claimed above, so a response that belongs to a dead session stays
      // consumed and cannot navigate later either.
      if ((await resolveAuthState()) !== "signed-in") return;

      const data = response.notification.request.content.data as {
        type?: NotificationType;
        entity_id?: string;
        kind?: string;
      };
      if (data?.kind === "mentor") {
        if (response.actionIdentifier === MENTOR_ACTION_CHANGE
          || response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER
          || !response.actionIdentifier) {
          router.replace("/mentor");
          return;
        }
        const mentorData = mentorNotificationData(data, response.notification.date);
        if (!mentorData) return;
        if (response.actionIdentifier === MENTOR_ACTION_DONE) {
          await recordMentorCheckIn({
            commitmentId: mentorData.commitmentId,
            scheduled_for: mentorData.scheduledFor,
            local_date: mentorData.localDate,
            action: "done",
            snoozed_until: null,
          });
          return;
        }
        if (response.actionIdentifier === MENTOR_ACTION_SNOOZE) {
          const snoozedUntil = new Date(Date.now() + 15 * 60 * 1000);
          await Notifications.scheduleNotificationAsync({
            content: {
              title: response.notification.request.content.title ?? "Your Kora commitment",
              body: response.notification.request.content.body ?? "A gentle reminder from your Kora mentor.",
              categoryIdentifier: MENTOR_NOTIFICATION_CATEGORY,
              data: mentorData,
            },
            trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: snoozedUntil },
          });
          await recordMentorCheckIn({
            commitmentId: mentorData.commitmentId,
            scheduled_for: mentorData.scheduledFor,
            local_date: mentorData.localDate,
            action: "snoozed",
            snoozed_until: snoozedUntil.toISOString(),
          });
          return;
        }
        return;
      }
      if (data?.kind === "reminder") {
        router.replace("/capture");
        return;
      }
      if (data?.kind === "custom") {
        router.replace("/");
        return;
      }
      // Weight check-in reminders land on Progress, where WeightLogSheet lives —
      // the only place in the app a weight can be logged. Falling through to the
      // targetFor path (which has no "weight" case) would drop the user wherever
      // the app happened to be, which is not a deep link at all.
      if (data?.kind === "weight") {
        router.replace("/progress");
        return;
      }
      if (!data?.type) return;
      const target = targetFor({ type: data.type, entity_id: data.entity_id });
      if (target) router.replace(target);
    });
    return () => sub.remove();
  }, []);
}
