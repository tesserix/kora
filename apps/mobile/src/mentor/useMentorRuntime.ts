import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import type { MentorCommitment, MentorProfile } from "@/api/types";
import { useMentorCommitments, useMentorProfile, useSyncMentorHealth } from "@/api/hooks";
import { currentUserId } from "@/lib/api";
import { useIsOnline } from "@/offline/connectivity";
import { reconcileWeightReminder } from "@/reminders/reconcileWeightReminder";
import {
  activateMentorProjection,
  saveMentorProjection,
  type MentorProjection,
} from "./projection";
import { collectMentorHealthDays } from "./healthSync";
import {
  beginMentorHealthUpload,
  finishMentorHealthUpload,
  mentorHealthSyncGeneration,
} from "./healthSyncGate";
import { flushMentorCheckIns } from "./checkInOutbox";

const HEALTH_SYNC_INTERVAL_MS = 15 * 60 * 1000;

export function projectMentorData(
  profile: MentorProfile,
  commitments: MentorCommitment[],
): MentorProjection {
  return {
    profile: {
      quiet_start_minute: profile.quiet_start_minute,
      quiet_end_minute: profile.quiet_end_minute,
    },
    commitments: commitments.map((commitment) => ({
      id: commitment.id,
      title: commitment.title,
      kind: commitment.kind,
      cadence: commitment.cadence,
      weekdays_mask: commitment.weekdays_mask,
      start_minute: commitment.start_minute,
      interval_minutes: commitment.interval_minutes,
      end_minute: commitment.end_minute,
      timezone: commitment.timezone,
      starts_on: commitment.starts_on,
      ends_on: commitment.ends_on,
      status: commitment.status,
    })),
  };
}

export function useMentorRuntime(): void {
  const ownerID = currentUserId();
  const online = useIsOnline();
  const profile = useMentorProfile();
  const commitments = useMentorCommitments();
  const { mutateAsync: syncHealth } = useSyncMentorHealth();
  const healthSyncInFlight = useRef(false);
  const lastHealthAttempt = useRef<{ consent: string; at: number } | null>(null);

  const syncHealthNow = useCallback(async (): Promise<void> => {
    const data = profile.data;
    if (!ownerID || !data?.confirmed_at || healthSyncInFlight.current) return;
    const consent = {
      steps: data.health_steps_enabled,
      sleep: data.health_sleep_enabled,
      workouts: data.health_workouts_enabled,
      energy: data.health_energy_enabled,
      heartRate: data.health_heart_rate_enabled,
    };
    if (!consent.steps && !consent.sleep && !consent.workouts && !consent.energy && !consent.heartRate) return;
    const consentKey = `${consent.steps}:${consent.sleep}:${consent.workouts}:${consent.energy}:${consent.heartRate}`;
    const now = Date.now();
    const last = lastHealthAttempt.current;
    if (last?.consent === consentKey && now - last.at < HEALTH_SYNC_INTERVAL_MS) return;

    const generation = mentorHealthSyncGeneration();
    if (generation === null) return;
    lastHealthAttempt.current = { consent: consentKey, at: now };
    healthSyncInFlight.current = true;
    try {
      const collection = await collectMentorHealthDays(consent);
      if (collection.status === "ready" && collection.days.length > 0 && beginMentorHealthUpload(generation)) {
        try {
          await syncHealth({ days: collection.days });
        } finally {
          finishMentorHealthUpload();
        }
      }
    } finally {
      healthSyncInFlight.current = false;
    }
  }, [ownerID, profile.data, syncHealth]);

  useEffect(() => {
    if (!ownerID || !profile.data || !commitments.data) return;
    const projection = projectMentorData(profile.data, commitments.data);
    void (async () => {
      await saveMentorProjection(ownerID, projection);
      await activateMentorProjection(ownerID);
      await reconcileWeightReminder();
    })().catch((err) => console.warn("mentor: reminder projection failed", err));
  }, [commitments.data, ownerID, profile.data]);

  useEffect(() => {
    if (ownerID && online) {
      void flushMentorCheckIns().catch((err) => console.warn("mentor: check-in retry failed", err));
    }
  }, [online, ownerID]);

  useEffect(() => {
    void syncHealthNow().catch((err) => console.warn("mentor: Health sync failed", err));
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        if (online) {
          void flushMentorCheckIns().catch((err) => console.warn("mentor: check-in retry failed", err));
        }
        void syncHealthNow().catch((err) => console.warn("mentor: Health sync failed", err));
      }
    });
    return () => sub.remove();
  }, [online, syncHealthNow]);
}
