import AsyncStorage from "@react-native-async-storage/async-storage";

import { apiFetch } from "@/lib/api";

/**
 * Keeps the server's copy of the user's IANA timezone matching the device.
 *
 * WHY THIS EXISTS (kora#160): `users.timezone` is written once, at provisioning
 * or onboarding, and nothing has ever updated it. Every account created before
 * kora#84 is stuck on the `Australia/Sydney` default — all 8 prod rows as of
 * 2026-08-14 — and anyone who moves stays on their old zone forever.
 *
 * It is not a cosmetic field. Streak and challenge windows resolve through it,
 * so a London user on a Sydney zone can have a streak break at 2pm local. Since
 * kora#212 Phase 4 it ALSO selects which food locale the resolver prefers, so a
 * user in India on the default gets Australian foods ranked above Indian ones
 * with no way to correct it.
 *
 * Called on foreground rather than at launch alone, because the interesting
 * case is a device that changed zone while the app was backgrounded — a flight,
 * or simply crossing into daylight saving.
 */

/**
 * The last zone we successfully sent, so a steady state costs no requests.
 *
 * PERSISTED, not just held in memory: this runs on every foreground, and a
 * fresh process would otherwise re-send on the first foreground of every
 * launch — a pointless write to `users` per app start, forever, for a value
 * that almost never changes.
 */
const LAST_SYNCED_KEY = "profile.timezone.lastSynced";

let lastSynced: string | null = null;
let loaded = false;

async function loadLastSynced(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    lastSynced = await AsyncStorage.getItem(LAST_SYNCED_KEY);
  } catch {
    // Storage failing just means we may send one redundant PATCH. Not worth
    // failing a background correction over.
    lastSynced = null;
  }
}

/** Resets module state. Tests only. */
export function resetTimezoneSyncForTests(): void {
  lastSynced = null;
  loaded = false;
}

/**
 * Returns the device's IANA zone, or null when it cannot be determined.
 *
 * Hermes implements `Intl`, but a zone can still come back empty or as the
 * unhelpful "UTC" placeholder on a misconfigured device. Returning null in that
 * case means "do not touch the server value" — the stored zone, even if stale,
 * is a better guess than one we are not confident in.
 */
export function deviceTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz || !tz.includes("/")) {
      // Every real IANA zone is "Region/City". Rejecting anything else also
      // rejects "UTC" and "Local", which the API refuses anyway because they
      // mean "no opinion" and "the server's zone" rather than the user's.
      return null;
    }
    return tz;
  } catch {
    return null;
  }
}

/**
 * PATCHes the profile when the device zone differs from `profileTimezone`.
 *
 * Deliberately silent on failure. This runs on every foreground and is a
 * background correction the user never asked for, so a failed sync must never
 * surface an error or block anything — the next foreground retries it.
 *
 * @param profileTimezone the zone currently stored on the server, if known.
 * @returns the zone that was sent, or null when nothing needed sending.
 */
export async function syncTimezone(profileTimezone?: string | null): Promise<string | null> {
  const device = deviceTimezone();
  if (!device) return null;
  await loadLastSynced();
  // Already correct on the server, or already sent (this launch or a previous one).
  if (device === profileTimezone || device === lastSynced) return null;

  try {
    await apiFetch("/v1/me", {
      method: "PATCH",
      body: JSON.stringify({ timezone: device }),
    });
    lastSynced = device;
    try {
      await AsyncStorage.setItem(LAST_SYNCED_KEY, device);
    } catch {
      // The zone IS synced; only the memo failed. Worst case we re-send once
      // next launch, which is harmless and idempotent.
    }
    return device;
  } catch {
    // Left unset on purpose so the next foreground tries again.
    return null;
  }
}
