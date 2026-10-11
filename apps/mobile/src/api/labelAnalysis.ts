export type LabelNutrients = Partial<Record<"energy_kcal" | "protein_g" | "fat_g" | "saturated_fat_g" | "carbohydrate_g" | "sugars_g" | "fibre_g" | "sodium_mg", number | null>>;

export type LabelAnalysis = {
  basis: "per_100g" | "per_100ml";
  per_100: LabelNutrients;
  per_serving: LabelNutrients;
  needs_review: boolean;
  issues: string[];
  analysis: {
    status: "ready" | "review_required";
    summary: string;
    escalated: boolean;
    consumed_amount_known: false;
  };
};

export function parseLabelAnalysis(raw: unknown): LabelAnalysis {
  const data = raw as LabelAnalysis;
  if (!data || !["per_100g", "per_100ml"].includes(data.basis) || !data.per_100 || !data.per_serving ||
      !data.analysis || !["ready", "review_required"].includes(data.analysis.status) || typeof data.analysis.summary !== "string" ||
      data.analysis.consumed_amount_known !== false || typeof data.needs_review !== "boolean") {
    throw new Error("Invalid label analysis");
  }
  for (const column of [data.per_100, data.per_serving]) {
    for (const value of Object.values(column)) {
      if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error("Invalid label value");
    }
  }
  return data;
}
