/**
 * Pure unit conversion helpers for the client-only imperial/metric preference.
 * The backend always stores/returns metric values (kg, cm); these helpers
 * convert for display and parse user input back to metric for persistence.
 */

export type UnitSystem = "metric" | "imperial";

export const KG_PER_LB = 0.45359237;
export const LB_PER_KG = 2.2046226218;
export const CM_PER_IN = 2.54;

export function lbFromKg(kg: number): number {
  return kg * LB_PER_KG;
}

export function kgFromLb(lb: number): number {
  return lb * KG_PER_LB;
}

export function cmFromFtIn(ft: number, inch: number): number {
  return cmFromIn(ft * 12 + inch);
}

/**
 * Plain inches to centimetres (kora#45).
 *
 * `cmFromFtIn` already existed for HEIGHT, which imperial users state as a
 * feet-and-inches pair. A tape measurement is not stated that way — nobody
 * reports a 0ft 32in waist — so it needs the single-argument direction, and
 * calling `cmFromFtIn(0, inch)` to get it would read as a height conversion
 * everywhere it appeared.
 */
export function cmFromIn(inch: number): number {
  return inch * CM_PER_IN;
}

/**
 * Centimetres to inches — the display direction, which had no helper at all
 * before tape measurements existed (kora#45). Every stored length is metric;
 * this is the only place the imperial figure comes from.
 */
export function inFromCm(cm: number): number {
  return cm / CM_PER_IN;
}

export function formatWeight(kg: number, system: UnitSystem): { value: string; unit: string } {
  if (system === "imperial") {
    return { value: lbFromKg(kg).toFixed(1), unit: "lb" };
  }
  return { value: kg.toFixed(1), unit: "kg" };
}

export function weightUnitLabel(system: UnitSystem): "kg" | "lb" {
  return system === "imperial" ? "lb" : "kg";
}

export function parseWeightToKg(text: string, system: UnitSystem): number | null {
  const value = parseFloat(text);
  if (!Number.isFinite(value) || value <= 0) return null;
  return system === "imperial" ? kgFromLb(value) : value;
}

export const ML_PER_FL_OZ = 29.5735295625;

export function mlToFlOz(ml: number): number {
  return ml / ML_PER_FL_OZ;
}

export function flOzToMl(flOz: number): number {
  return flOz * ML_PER_FL_OZ;
}
