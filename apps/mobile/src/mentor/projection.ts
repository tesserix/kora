import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  MentorCommitmentCadence,
  MentorCommitmentKind,
  MentorCommitmentStatus,
} from "@/api/types";

export type ProjectedMentorCommitment = {
  id: string;
  title: string;
  kind: MentorCommitmentKind;
  cadence: MentorCommitmentCadence;
  weekdays_mask: number;
  start_minute: number;
  interval_minutes: number | null;
  end_minute: number | null;
  timezone: string;
  starts_on: string;
  ends_on: string | null;
  status: MentorCommitmentStatus;
};

export type MentorProjection = {
  profile: {
    quiet_start_minute: number;
    quiet_end_minute: number;
  };
  commitments: ProjectedMentorCommitment[];
};

const ACTIVE_OWNER_KEY = "kora.mentorProjection.activeOwner.v1";
const OWNER_KEY_PREFIX = "kora.mentorProjection.v1.";

function ownerKey(ownerID: string): string {
  return `${OWNER_KEY_PREFIX}${encodeURIComponent(ownerID)}`;
}

function isMinute(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1439;
}

function isCommitment(value: unknown): value is ProjectedMentorCommitment {
  const item = value as Partial<ProjectedMentorCommitment> | null;
  return !!item
    && typeof item.id === "string" && item.id.length > 0
    && typeof item.title === "string" && item.title.length > 0
    && typeof item.kind === "string"
    && typeof item.cadence === "string"
    && Number.isInteger(item.weekdays_mask) && item.weekdays_mask! >= 0 && item.weekdays_mask! <= 127
    && isMinute(item.start_minute)
    && (item.interval_minutes === null || (Number.isInteger(item.interval_minutes) && item.interval_minutes! > 0))
    && (item.end_minute === null || isMinute(item.end_minute))
    && typeof item.timezone === "string" && item.timezone.length > 0
    && typeof item.starts_on === "string"
    && (item.ends_on === null || typeof item.ends_on === "string")
    && typeof item.status === "string";
}

function parseProjection(raw: string | null): MentorProjection | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<MentorProjection>;
    if (!value.profile || !isMinute(value.profile.quiet_start_minute) || !isMinute(value.profile.quiet_end_minute)) {
      return null;
    }
    if (!Array.isArray(value.commitments) || !value.commitments.every(isCommitment)) return null;
    return value as MentorProjection;
  } catch {
    return null;
  }
}

export async function saveMentorProjection(ownerID: string, projection: MentorProjection): Promise<void> {
  await AsyncStorage.setItem(ownerKey(ownerID), JSON.stringify(projection));
}

export async function loadMentorProjection(ownerID: string): Promise<MentorProjection | null> {
  try {
    return parseProjection(await AsyncStorage.getItem(ownerKey(ownerID)));
  } catch {
    return null;
  }
}

export async function activateMentorProjection(ownerID: string): Promise<void> {
  await AsyncStorage.setItem(ACTIVE_OWNER_KEY, ownerID);
}

export async function loadActiveMentorProjection(): Promise<MentorProjection | null> {
  try {
    const ownerID = await AsyncStorage.getItem(ACTIVE_OWNER_KEY);
    return ownerID ? loadMentorProjection(ownerID) : null;
  } catch {
    return null;
  }
}

export async function deactivateMentorProjection(): Promise<void> {
  try {
    const ownerID = await AsyncStorage.getItem(ACTIVE_OWNER_KEY);
    const keys = ownerID ? [ACTIVE_OWNER_KEY, ownerKey(ownerID)] : [ACTIVE_OWNER_KEY];
    await AsyncStorage.multiRemove(keys);
  } catch {
    // A corrupt or unavailable local store must not block sign-out.
  }
}
