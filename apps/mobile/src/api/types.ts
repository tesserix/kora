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
  weight_kg: number;
  share_progress: boolean;
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
  /** Present on barcode-sourced foods; enables an offline repeat scan. */
  barcode?: string;
};

// Sentinel `provenance` for "we deliberately don't know the source" — e.g. a
// FoodItem synthesized in the offline cache from a gram-scaled serving
// summary rather than received whole from the server (see
// src/offline/foodCache.ts foodsFromPins/foodsFromSavedMeals).
// ProvenanceChip renders nothing for this value rather than falling through
// to its default "AI estimate ±15%" copy, which specifically means a
// model's own guess — not a fact whose original source just wasn't carried
// through.
export const UNKNOWN_PROVENANCE = "unknown";

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
  /** What the user actually said or typed. Present only on ai_text/ai_voice logs. */
  input_phrase?: string;
};

export type MemoryFood = {
  food_item_id: string;
  name: string;
  meal_slot: string;
  grams: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  count: number;
  last_logged_at: string;
};

export type MemoryMeal = {
  id: string;
  name: string;
  meal_slot: string;
  items: MemoryFood[];
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  count: number;
  last_logged_at: string;
};

export type Memory = {
  recents: MemoryFood[];
  frequent: MemoryFood[];
  usual_meals: MemoryMeal[];
};

export type PinnedFood = {
  food_item_id: string;
  name: string;
  meal_slot: string;
  grams: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
};

// LoggableFood is the minimal shape useInstantLog.logFood needs; both MemoryFood
// and PinnedFood satisfy it.
export type LoggableFood = Pick<MemoryFood, "food_item_id" | "name" | "meal_slot" | "grams">;

export type SavedMealItem = {
  food_item_id: string;
  name: string;
  grams: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
};

export type SavedMeal = {
  id: string;
  name: string;
  meal_slot: string;
  items: SavedMealItem[];
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
};

// LoggableMeal is the minimal shape useInstantLog.logMeal needs; both MemoryMeal
// and SavedMeal satisfy it.
export type LoggableMeal = {
  name: string;
  meal_slot: string;
  items: { food_item_id: string; grams: number }[];
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

export type WeightEntry = {
  id: string;
  weight_kg: number;
  logged_at: string;
};

export type ResolveTier = "auto" | "confirm" | "follow_up";

export interface ResolvedCandidate {
  item: FoodItem;
  portion_grams: number;
  kcal: number;
  match_score: number;
  match_tier: string;
  /** This item's own confidence. Optional: an older server omits it. */
  tier?: ResolveTier;
  /**
   * Client-set only, never sent by the server. Marks a row the user resolved
   * by hand after capture: it is loggable, but the server has computed no kcal
   * for it yet, so the card must render "—" rather than invent a figure.
   */
  kcal_unknown?: boolean;
}

export interface Resolution {
  candidates: ResolvedCandidate[];
  tier: ResolveTier;
  follow_up_question?: string;
  is_estimate: boolean;
  kcal_low?: number;
  kcal_high?: number;
  provenance: string;
  /** Speech-to-text transcript, present only on a successful voice resolve. */
  transcript?: string;
}

export interface Friend {
  id: string;
  display_name: string;
}

export interface FriendRequest {
  id: string;
  user: Friend;
}

export interface FriendRequests {
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}

export interface MyFriendCode {
  code: string;
  link: string;
}

export interface ProgressView {
  streak_days: number;
  adherence_days: number;
  adherence_window: number;
}

export interface FriendProgress {
  id: string;
  display_name: string;
  sharing: boolean;
  streak_days?: number;
  adherence_days?: number;
}

export interface FriendsProgress {
  me: ProgressView;
  friends: FriendProgress[];
}

export type GroupRole = "owner" | "member";

export interface GroupSummary {
  id: string;
  name: string;
  member_count: number;
  role: GroupRole;
}

export interface GroupMemberView {
  id: string;
  display_name: string;
  role: GroupRole;
}

export interface GroupDetail {
  id: string;
  name: string;
  invite_code: string;
  my_role: GroupRole;
  members: GroupMemberView[];
}

export interface GroupProgress {
  members: FriendProgress[];
}

export interface GroupCode {
  code: string;
  link: string;
}

export type Metric = "on_target" | "logged";
export type ChallengeStatus = "upcoming" | "active" | "ended";

export interface ChallengeSummary {
  id: string;
  title: string;
  metric: Metric;
  status: ChallengeStatus;
  start_date: string;
  end_date: string;
  participant_count: number;
  joined: boolean;
}

export interface ChallengeStanding {
  user_id: string;
  display_name: string;
  score: number;
}

export interface ChallengeDetail {
  id: string;
  group_id: string;
  title: string;
  metric: Metric;
  status: ChallengeStatus;
  start_date: string;
  end_date: string;
  joined: boolean;
  can_delete: boolean;
  standings: ChallengeStanding[];
  winner?: ChallengeStanding;
}

export type NotificationType = "friend_request" | "friend_accept" | "group_invite" | "challenge_created" | "challenge_started" | "challenge_ended" | "challenge_passed";

export interface AppNotification {
  id: string;
  type: NotificationType;
  actor_id: string;
  actor_name: string;
  entity_id?: string;
  read: boolean;
  created_at: string;
}

export type FeedbackKind = "bug" | "feature";

/** Request body for POST /v1/feedback. Snake_case matches the API contract. */
export interface SubmitFeedbackInput {
  kind: FeedbackKind;
  subject: string;
  description: string;
  app_version: string;
  platform: string;
  os_version: string;
  device_model: string;
}

/** What POST /v1/feedback returns inside the `data` envelope. */
export interface FeedbackCreated {
  id: string;
  status: string;
}
