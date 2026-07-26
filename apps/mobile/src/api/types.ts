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
