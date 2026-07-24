export type Profile = {
  id: string;
  email: string;
  display_name: string;
  goal: string;
  target_kcal: number;
  target_protein_g: number;
  target_carbs_g: number;
  target_fat_g: number;
  onboarded_at: string | null;
};

export type FoodItem = {
  id: string;
  name: string;
  brand: string;
  provenance: string;
  serving_desc: string;
  serving_grams: number;
  kcal_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
};

export type Candidate = {
  item: FoodItem;
  match_score: number;
  match_tier: string;
};

export type FoodLog = {
  id: string;
  food_item_id?: string;
  logged_at: string;
  meal_slot: string;
  source: string;
  description: string;
  quantity_grams: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  provenance: string;
};

export type Totals = {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
};

export type DashboardSummary = {
  date: string;
  consumed: Totals;
  targets: Totals;
  water_ml: number;
  streak_days: number;
  source_counts: Record<string, number>;
};

export type OnboardingInput = {
  sex: "male" | "female";
  birth_year: number;
  height_cm: number;
  weight_kg: number;
  activity_level: "sedentary" | "light" | "moderate" | "active" | "very_active";
  goal: "fat_loss" | "maintenance" | "muscle_gain";
};

export type ResolveTier = "auto" | "confirm" | "follow_up";

export interface ResolvedCandidate {
  item: FoodItem;
  portion_grams: number;
  kcal: number;
  match_score: number;
  match_tier: string;
}

export interface Resolution {
  candidates: ResolvedCandidate[];
  tier: ResolveTier;
  follow_up_question?: string;
  is_estimate: boolean;
  kcal_low?: number;
  kcal_high?: number;
  provenance: string;
}
