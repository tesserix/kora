import type { OnboardingInput } from "@/api/types";

/** The onboarding payload in flight between the onboarding screen and /plan. */
export type PlanDraft = OnboardingInput;

const SEXES: readonly PlanDraft["sex"][] = ["male", "female"];
const ACTIVITY_LEVELS: readonly PlanDraft["activity_level"][] = [
  "sedentary",
  "light",
  "moderate",
  "active",
  "very_active",
];
const GOALS: readonly PlanDraft["goal"][] = ["fat_loss", "maintenance", "muscle_gain"];

/** Route params are strings; absent and null fields are left out. */
export function draftToParams(d: PlanDraft): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(d)) {
    if (value !== undefined && value !== null) params[key] = String(value);
  }
  return params;
}

type Params = Record<string, string | string[] | undefined>;

// A param that is present must be a single finite number; NaN means reject.
function num(p: Params, key: string): number | undefined {
  const v = p[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.trim() === "") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function oneOf<T extends string>(v: Params[string], allowed: readonly T[]): T | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

/**
 * Trust boundary: route params can be anything a deep link carries, so every
 * required field must be present and valid, and any optional number present
 * must be finite. Anything else is null, never a partially-filled draft.
 */
export function draftFromParams(p: Params): PlanDraft | null {
  const sex = oneOf(p.sex, SEXES);
  const activity_level = oneOf(p.activity_level, ACTIVITY_LEVELS);
  const goal = oneOf(p.goal, GOALS);
  const birth_year = num(p, "birth_year");
  const height_cm = num(p, "height_cm");
  const weight_kg = num(p, "weight_kg");
  const optional = {
    goal_weight_kg: num(p, "goal_weight_kg"),
    pace_kg_per_week: num(p, "pace_kg_per_week"),
    target_kcal_override: num(p, "target_kcal_override"),
    target_protein_override_g: num(p, "target_protein_override_g"),
  };
  if (!sex || !activity_level || !goal) return null;
  // `!Number.isFinite` also rejects undefined (missing).
  if (![birth_year, height_cm, weight_kg].every(Number.isFinite)) return null;
  if (Object.values(optional).some(Number.isNaN)) return null;
  if (p.timezone !== undefined && typeof p.timezone !== "string") return null;
  const draft: PlanDraft = {
    sex,
    birth_year: birth_year as number,
    height_cm: height_cm as number,
    weight_kg: weight_kg as number,
    activity_level,
    goal,
  };
  if (typeof p.timezone === "string") draft.timezone = p.timezone;
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) Object.assign(draft, { [key]: value });
  }
  return draft;
}
