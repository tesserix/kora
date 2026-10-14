import { Platform } from "react-native";
import * as Application from "expo-application";

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8080";
const TIMEOUT_MS = 5_000;

type AppConfig = { min_build?: { ios?: unknown; android?: unknown } };

// isUpdateRequired asks kora-api for the oldest native build it still serves
// and compares it with this one. Deliberately plain fetch, not apiFetch: the
// builds this exists to stop are the ones whose sign-in no longer works, so it
// must not need a token, and it must not trip apiFetch's 401 sign-out path.
//
// It fails OPEN on every uncertainty (offline, a timeout, a malformed answer,
// a development build with no build number): blocking a working app because
// the gate could not be read would be an outage the gate itself caused.
export async function isUpdateRequired(): Promise<boolean> {
  const current = Number(Application.nativeBuildVersion);
  if (!Number.isInteger(current) || current <= 0) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/v1/app-config`, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { data?: AppConfig };
    const min = Platform.OS === "android" ? body.data?.min_build?.android : body.data?.min_build?.ios;
    return typeof min === "number" && current < min;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Where "Update Kora" sends the user. The App Store id is eas.json's ascAppId.
export const STORE_URL =
  Platform.OS === "android"
    ? "https://play.google.com/store/apps/details?id=com.tesserix.kora"
    : "https://apps.apple.com/app/id6799465324";
