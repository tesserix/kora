import type { DashboardSummary } from "@/api/types";

/**
 * What the app hands the widget. Field names are mirrored verbatim by
 * `NutritionSnapshot` in targets/kora-widgets/Snapshot.swift — the two are a
 * single wire format and must be changed together.
 *
 * Figures are whole numbers: the widget has no room for decimals and rounding
 * once here keeps the app and the widget from disagreeing by a tenth.
 */
export type WidgetSnapshot = {
  /** The local day these figures describe, "YYYY-MM-DD". Drives the staleness guard. */
  date: string;
  kcalConsumed: number;
  kcalTarget: number;
  proteinConsumed: number;
  proteinTarget: number;
  carbsConsumed: number;
  carbsTarget: number;
  fatConsumed: number;
  fatTarget: number;
  /** Step goal, which lives in the app (useHealth's STEP_GOAL) and is invisible to the widget. */
  stepGoal: number;
};

export type BuildSnapshotInput = {
  summary: DashboardSummary;
  stepGoal: number;
};

export function buildSnapshot({ summary, stepGoal }: BuildSnapshotInput): WidgetSnapshot {
  return {
    date: summary.date,
    kcalConsumed: Math.round(summary.consumed.kcal),
    kcalTarget: Math.round(summary.targets.kcal),
    proteinConsumed: Math.round(summary.consumed.protein_g),
    proteinTarget: Math.round(summary.targets.protein_g),
    carbsConsumed: Math.round(summary.consumed.carbs_g),
    carbsTarget: Math.round(summary.targets.carbs_g),
    fatConsumed: Math.round(summary.consumed.fat_g),
    fatTarget: Math.round(summary.targets.fat_g),
    stepGoal,
  };
}
