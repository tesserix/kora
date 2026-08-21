import type { WeightEntry, WeightSource } from "@/api/types";

/**
 * The derived body-composition values, computed rather than stored (kora#45).
 *
 * The schema stores only what an instrument MEASURED. BMI, fat mass in kg and
 * fat-free mass are all arithmetic over values Kora already holds, and storing
 * a read copy of any of them would create a second source of truth able to
 * contradict Kora's own height and weight — a row that disagrees with itself,
 * with nothing to say which field to believe.
 *
 * They live here, as pure functions, so that no call site re-derives them
 * slightly differently. Every one returns `null` rather than a placeholder
 * number when its inputs are missing or impossible: an unknown value that
 * renders as 0 is indistinguishable from a real measurement of 0.
 */

/** Below this, height is a unit mistake (metres typed as cm) rather than a person. */
const MIN_PLAUSIBLE_HEIGHT_CM = 50;

function isUsable(value: number | undefined | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Body mass index from the profile's height and the given weight.
 *
 * Height comes from the PROFILE (`heightCm`, see src/lib/plan.ts), never from a
 * stored column — there is no BMI column and there must not be one. A scale
 * that prints its own BMI is printing a number derived from the height IT was
 * told, which is not necessarily Kora's.
 */
export function bmi(weightKg: number | undefined, heightCm: number | undefined): number | null {
  if (!isUsable(weightKg) || !isUsable(heightCm)) return null;
  if (weightKg <= 0 || heightCm < MIN_PLAUSIBLE_HEIGHT_CM) return null;
  const heightM = heightCm / 100;
  return weightKg / (heightM * heightM);
}

/**
 * Fat mass in kg from weight and body fat percentage.
 *
 * Omron reports body fat as BOTH `32.6 %` and `22.9 kg` — one fact in two
 * units. The percentage is what is stored; this is the other unit.
 */
export function fatMassKg(
  weightKg: number | undefined,
  bodyFatPct: number | undefined,
): number | null {
  if (!isUsable(weightKg) || !isUsable(bodyFatPct)) return null;
  if (weightKg <= 0 || bodyFatPct < 0 || bodyFatPct > 100) return null;
  return (weightKg * bodyFatPct) / 100;
}

/**
 * Fat-free mass in kg — everything that is not fat.
 *
 * Omron prints this too (58.21 kg). It is still `weight - fat mass`, so it is
 * derived here rather than stored.
 */
export function fatFreeMassKg(
  weightKg: number | undefined,
  bodyFatPct: number | undefined,
): number | null {
  const fat = fatMassKg(weightKg, bodyFatPct);
  if (fat === null || !isUsable(weightKg)) return null;
  return weightKg - fat;
}

/** The three derived values for one entry, given the profile height. */
export function derivedComposition(
  entry: Pick<WeightEntry, "weight_kg" | "body_fat_pct">,
  heightCm: number | undefined,
): { bmi: number | null; fatMassKg: number | null; fatFreeMassKg: number | null } {
  return {
    bmi: bmi(entry.weight_kg, heightCm),
    fatMassKg: fatMassKg(entry.weight_kg, entry.body_fat_pct),
    fatFreeMassKg: fatFreeMassKg(entry.weight_kg, entry.body_fat_pct),
  };
}

/**
 * Whether two readings may share a trend line.
 *
 * They may not if they came from different instruments: Renpho and Omron
 * disagree on what "skeletal muscle" even means (48.9% vs 25.7% for the same
 * body), and DEXA and bioimpedance disagree on body fat by several points. A
 * chart that joins them invisibly turns an instrument change into what reads as
 * real progress or real loss.
 *
 * This does not decide what to DO about it — separate series, a marker at the
 * switch, or refusing to join — only that the values are not interchangeable.
 */
export function isComparable(a: WeightSource, b: WeightSource): boolean {
  return a === b;
}
