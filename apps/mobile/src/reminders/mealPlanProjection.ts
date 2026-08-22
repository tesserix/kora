import AsyncStorage from "@react-native-async-storage/async-storage";
import type { MealPlanProposal } from "@/api/types";

const ACTIVE_OWNER_KEY = "kora.mealPlanProjection.activeOwner.v1";
const OWNER_KEY_PREFIX = "kora.mealPlanProjection.v1.";
const MAX_PLAN_DAYS = 62;
const MAX_MEALS_PER_DAY = 6;

function ownerKey(ownerID: string): string {
  return `${OWNER_KEY_PREFIX}${encodeURIComponent(ownerID)}`;
}

// Only an approved plan may become a projection: reminders are the user's own
// decision made concrete, and a proposal they never approved must not put
// notifications on their phone.
function isAcceptedPlan(value: unknown): value is MealPlanProposal {
  const plan = value as Partial<MealPlanProposal> | null;
  return !!plan
    && typeof plan.id === "string" && plan.id.length > 0
    && typeof plan.summary === "string"
    && typeof plan.accepted_at === "string" && Number.isFinite(Date.parse(plan.accepted_at))
    && typeof plan.starts_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(plan.starts_on)
    && typeof plan.timezone === "string" && plan.timezone.length > 0
    && Array.isArray(plan.days) && plan.days.length > 0 && plan.days.length <= MAX_PLAN_DAYS
    && plan.days.every((day) =>
      typeof day?.date === "string" && day.date.trim().length > 0
      && Array.isArray(day.meals) && day.meals.length > 0 && day.meals.length <= MAX_MEALS_PER_DAY
      && day.meals.every((meal) =>
        typeof meal?.name === "string" && meal.name.trim().length > 0
        && typeof meal.description === "string"
        && typeof meal.preparation === "string" && meal.preparation.trim().length > 0));
}

function parseProjection(raw: string | null): MealPlanProposal | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return isAcceptedPlan(value) ? value : null;
  } catch {
    return null;
  }
}

export async function activateMealPlanProjection(ownerID: string, plan: MealPlanProposal): Promise<void> {
  if (!ownerID || !isAcceptedPlan(plan)) {
    await deactivateMealPlanProjection();
    return;
  }
  await AsyncStorage.setItem(ownerKey(ownerID), JSON.stringify(plan));
  await AsyncStorage.setItem(ACTIVE_OWNER_KEY, ownerID);
}

export async function loadMealPlanProjection(ownerID: string): Promise<MealPlanProposal | null> {
  try {
    return parseProjection(await AsyncStorage.getItem(ownerKey(ownerID)));
  } catch {
    return null;
  }
}

export async function loadActiveMealPlanProjection(): Promise<MealPlanProposal | null> {
  try {
    const ownerID = await AsyncStorage.getItem(ACTIVE_OWNER_KEY);
    return ownerID ? loadMealPlanProjection(ownerID) : null;
  } catch {
    return null;
  }
}

export async function deactivateMealPlanProjection(): Promise<void> {
  try {
    const ownerID = await AsyncStorage.getItem(ACTIVE_OWNER_KEY);
    const keys = ownerID ? [ACTIVE_OWNER_KEY, ownerKey(ownerID)] : [ACTIVE_OWNER_KEY];
    await AsyncStorage.multiRemove(keys);
  } catch {
    // A corrupt or unavailable local store must not block sign-out.
  }
}
