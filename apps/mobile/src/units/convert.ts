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
  return ft * 12 * CM_PER_IN + inch * CM_PER_IN;
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
