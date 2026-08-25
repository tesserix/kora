export type Profile = {
  id: string;
  email: string;
  display_name: string;
  goal: string;
  target_kcal: number;
  target_protein_g: number;
  target_carbs_g: number;
  target_fat_g: number;
  goal_weight_kg: number;
  pace_kg_per_week: number;
  target_date: string | null;
  onboarded_at: string | null;
  weight_kg: number;
  /**
   * Onboarding height, already on the wire from GET /v1/me (internal/user's
   * User is serialised whole) and declared here since kora#45 because BMI is
   * DERIVED from it. There is no BMI column and there must not be one — see
   * src/lib/bodyComposition.ts.
   */
  height_cm: number;
  /**
   * Handles and pictures (kora#449). Also on the wire from GET /v1/me for the
   * same reason height_cm is: internal/user's User is serialised whole, and
   * this field rides along with it. "" means no picture (and, same as
   * LookupResult.avatar_url below, no bucket configured) — never treat it as
   * a broken URL.
   */
  avatar_url: string;
};

export interface AIQuotaWindow {
  used: number;
  limit: number;
  remaining: number;
  resets_at: string;
}

export interface AITopUpStatus {
  active: boolean;
  unlimited: boolean;
  pack_code?: string;
  remaining: number;
  daily_remaining: number;
  expires_at?: string;
}

export interface AIUsageStatus {
  daily: AIQuotaWindow;
  weekly: AIQuotaWindow;
  monthly: AIQuotaWindow;
  top_up?: AITopUpStatus;
  // Server-derived: free windows and any purchased pack, already combined.
  // The app must not re-derive this — the arithmetic lives in one place.
  blocked?: boolean;
}

// Every amount is integer paise, itemised by the API. The app renders these
// and never computes GST or a platform fee itself.
export interface AIPackPrice {
  base_paise: number;
  platform_fee_paise: number;
  taxable_paise: number;
  gst_paise: number;
  total_paise: number;
  gst_rate_basis_points: number;
  platform_fee_rate_basis_points: number;
}

export interface AIPack {
  code: string;
  name: string;
  base_paise: number;
  grant: number;
  daily_cap: number;
  unlimited: boolean;
  summary: string;
  price: AIPackPrice;
  base_rupees: string;
  total_rupees: string;
}

export type AIOrderStatus = "created" | "paid" | "failed" | "expired";

export interface AIOrder {
  id: string;
  pack_code: string;
  base_paise: number;
  platform_fee_paise: number;
  gst_paise: number;
  total_paise: number;
  currency: string;
  status: AIOrderStatus;
  payment_session_id?: string;
  // Built by the server so the app never has to know whether it is talking to
  // the sandbox or the live gateway.
  checkout_url?: string;
  invoice_number?: string;
  paid_at?: string;
  created_at: string;
}

export type CoachKind = "protein" | "fibre" | "weight_down" | "weight_up" | "today";

export interface CoachNudge {
  kind: CoachKind;
  title: string;
  text: string;
}

export interface CoachCitation {
  label: string;
  value: string;
}

export type CoachRole = "user" | "otto";

export interface CoachTurn {
  role: CoachRole;
  text: string;
  citations: CoachCitation[];
  created_at: string;
  /** Set only on turns answered in this session — the stored thread has no attribution. */
  agent?: string;
  proposal?: MentorCommitmentProposal;
  plan?: MealPlanProposal | null;
}

export interface CoachNudgesResponse {
  nudges: CoachNudge[];
  show_support: boolean;
}

export interface CoachThreadResponse {
  turns: CoachTurn[];
  show_support: boolean;
}

/** Who answered, as published in the agent registry. Absent when the plain model replied. */
export interface CoachAgent {
  name: string;
  skill: string;
  /** Set when a planner draft was reviewed by another agent before being shown. */
  reviewed_by?: string;
}

/** One preference this answer touches. Allergies and exclusions never appear
 *  here — those are enforced server-side, so an answer that reaches the client
 *  has already been kept clear of them. */
export interface CoachDietFlag {
  subject: string;
  label: string;
  kind: MentorFoodRuleKind;
  severity: "block" | "flag";
  match: string;
}

export interface CoachAnswer {
  answer: string;
  citations: CoachCitation[];
  show_support: boolean;
  agent?: CoachAgent;
  proposal?: MentorCommitmentProposal | null;
  plan?: MealPlanProposal | null;
  diet_flags?: CoachDietFlag[];
}

export interface MealPlanMeal {
  name: string;
  description: string;
  /** How the meal is made. Required on every reviewed meal — a card that names
   *  food it cannot tell you how to cook is not approvable. */
  preparation: string;
}

/** `date` is the planner's own label ("Monday", "2026-08-25"), shown verbatim —
 *  nothing schedules from it. */
export interface MealPlanDay {
  date: string;
  meals: MealPlanMeal[];
}

/** A reviewed plan the user has yet to approve. Approval activates its finite
 *  reminder projection, but never logs meals into the diary. */
export interface MealPlanProposal {
  id: string;
  summary: string;
  days: MealPlanDay[];
  agent_name: string;
  reviewed_by: string;
  accepted_at: string | null;
  /** The user's local calendar date when they approved, and the zone it was
   *  read in. Both are null/empty until approval. */
  starts_on: string | null;
  timezone: string;
  created_at: string;
}

export type MentorCoachingStyle = "supportive" | "direct" | "educational" | "accountability";
export type MentorReminderIntensity = "light" | "balanced" | "frequent";

export type MentorDietPattern =
  | ""
  | "vegetarian"
  | "vegan"
  | "eggetarian"
  | "jain"
  | "halal"
  | "pescatarian";

export interface MentorProfileInput {
  motivation: string;
  dietary_preferences: string;
  allergies: string;
  diet_pattern: MentorDietPattern;
  coaching_style: MentorCoachingStyle;
  reminder_intensity: MentorReminderIntensity;
  quiet_start_minute: number;
  quiet_end_minute: number;
  health_steps_enabled: boolean;
  health_sleep_enabled: boolean;
  health_workouts_enabled: boolean;
  health_energy_enabled: boolean;
  health_heart_rate_enabled: boolean;
}

export interface MentorProfile extends MentorProfileInput {
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

// A rule's severity decides what Kora does with it: "block" is an allergy or
// absolute exclusion and is never shown in a plan, "flag" is a preference and
// is only annotated.
export type MentorFoodRuleSeverity = "block" | "flag";
export type MentorFoodRuleKind = "allergy" | "exclusion" | "preference";
export type MentorFoodRuleSource = "user" | "pattern" | "coach";

export interface MentorFoodRuleInput {
  subject: string;
  kind: MentorFoodRuleKind;
  severity?: MentorFoodRuleSeverity;
  label?: string;
}

export interface MentorFoodRule {
  id: string;
  subject: string;
  kind: MentorFoodRuleKind;
  severity: MentorFoodRuleSeverity;
  label: string;
  source: MentorFoodRuleSource;
  // Null until the user accepts it. Kora enforces confirmed rules only, so a
  // proposal it inferred never silently constrains a plan.
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MentorFoodSubject {
  subject: string;
  label: string;
  family?: string;
}

export interface MentorFoodRules {
  rules: MentorFoodRule[];
  // The picker's options come from the server so it cannot offer a subject the
  // server would then refuse.
  subjects: MentorFoodSubject[];
  patterns: MentorDietPattern[];
}

export type MentorCommitmentKind = "hydration" | "walking" | "meal" | "custom";
export type MentorCommitmentCadence = "fixed" | "interval";
export type MentorCommitmentStatus = "active" | "paused" | "archived";

export interface MentorCommitmentInput {
  title: string;
  kind: MentorCommitmentKind;
  cadence: MentorCommitmentCadence;
  weekdays_mask: number;
  start_minute: number;
  interval_minutes: number | null;
  end_minute: number | null;
  timezone: string;
  starts_on: string;
  ends_on: string | null;
  status: MentorCommitmentStatus;
}

export interface MentorCommitment extends MentorCommitmentInput {
  id: string;
  source: string;
  agent_name: string | null;
  created_at: string;
  updated_at: string;
}

export type MentorCommitmentProposal = Omit<MentorCommitmentInput, "status"> & {
  id: string;
  source: string;
  agent_name: string;
  reviewed_by: string;
  accepted_commitment_id: string | null;
  accepted_at: string | null;
  created_at: string;
};

export type MentorProposalAcceptance = Omit<MentorCommitmentInput, "status"> & {
  proposalId: string;
  commitmentId: string;
};

export interface MentorHealthDayInput {
  local_date: string;
  timezone: string;
  steps?: number | null;
  sleep_minutes?: number | null;
  workout_minutes?: number | null;
  active_energy_kcal?: number | null;
  resting_heart_rate_bpm?: number | null;
  observed_at: string;
}

export type MentorCheckInAction = "done" | "skipped" | "snoozed";

export interface MentorCheckInInput {
  scheduled_for: string;
  local_date: string;
  action: MentorCheckInAction;
  snoozed_until: string | null;
}

export interface MentorCheckIn extends MentorCheckInInput {
  id: string;
  commitment_id: string;
  created_at: string;
  updated_at: string;
}

/** What the capture composer's message turned out to BE.
 *
 * The composer used to post everything typed to food resolution, which asks a
 * model "what foods are in this?" — a question with no honest answer for "help
 * me build a meal plan", so the model invented four items and offered to log
 * them. The server now decides intent first and answers with one of these two
 * shapes; see api/internal/coach/message.go. */
export type CaptureMessage =
  | { kind: "resolution"; resolution: Resolution }
  | ({ kind: "answer" } & CoachAnswer);

export type ServingUnit = {
  name: string;
  amount: number;
  base_amount: number;
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
  /** The base unit of measurement for this food ("g" or "ml"). */
  base_unit?: string;
  /** Available serving units for this food (name, amount, base_amount). */
  serving_units?: ServingUnit[];
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

// Sentinel `match_tier` (and `Resolution.provenance`) for a result the device
// produced from its own offline cache rather than receiving from the server.
//
// It exists for the same reason UNKNOWN_PROVENANCE does: a cache hit is a
// genuinely different kind of answer from a live one — a food this user has
// encountered before, with no fresh server data and no server-computed kcal
// behind it — and nothing in the `Candidate`/`ResolvedCandidate` shape would
// otherwise distinguish the two. Without a marker a cached guess renders
// identically to a fresh AI resolution, which is the honesty problem this
// branch keeps having to fix.
//
// Set ONLY by src/offline/cachedResolution.ts. The server never sends it.
export const CACHED_MATCH_TIER = "cached";

export const isCachedResult = (v: { match_tier?: string } | null | undefined): boolean =>
  v?.match_tier === CACHED_MATCH_TIER;

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
  source: LogSource;
  description: string;
  quantity_grams: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  provenance: string;
  /** What the user actually said or typed. Present only on ai_text/ai_voice logs. */
  input_phrase?: string;
  /** The amount entered by the user (e.g. 1, 0.5, 200). Null for legacy logs. */
  entered_amount?: number | null;
  /** The unit entered by the user (e.g. "sachet", "cup", "g", "ml"). Null for legacy logs. */
  entered_unit?: string | null;
  /**
   * The logged food's base unit ("g" or "ml"), joined in from the food item.
   * It is a LABEL only — nutrition is computed server-side and nothing here
   * converts anything — but without it a LEGACY liquid row (no entered pair,
   * so quantity_grams is all there is) renders as grams.
   *
   * Absent when the log resolved to no food item. Callers must treat its
   * absence as "unknown, assume g", never as "the food is gram-based".
   */
  base_unit?: string;
  /**
   * The logged food's named serving units, same caveat as base_unit: not
   * currently returned by the log-fetch endpoint.
   */
  serving_units?: ServingUnit[];
  /**
   * True when the portion logged was a system estimate rather than one
   * derived from real data or stated by the user — mirrors
   * ResolvedCandidate.portion_assumed above. Optional because an older
   * server, or a cached/replayed row, may omit it.
   */
  portion_assumed?: boolean;
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
  /** What the user entered for this item (e.g. 1, 2, 0.5). Null for a legacy gram-entered item. */
  entered_amount?: number | null;
  /** The unit entered alongside entered_amount (e.g. "sachet", "g", "ml"). Null for a legacy item. */
  entered_unit?: string | null;
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
  items: {
    food_item_id: string;
    grams: number;
    /** What the user entered for this item (e.g. 1, 2, 0.5). Null/absent for a legacy gram-entered item. */
    entered_amount?: number | null;
    /** The unit entered alongside entered_amount (e.g. "sachet", "g", "ml"). Null/absent for a legacy item. */
    entered_unit?: string | null;
  }[];
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
  // The device's IANA zone, sent so a user is not provisioned into the server's
  // DefaultTimezone (Australia/Sydney) regardless of where they live. Every
  // account created before this was Sydney — see kora#84.
  timezone?: string;
  sex: "male" | "female";
  birth_year: number;
  height_cm: number;
  weight_kg: number;
  activity_level: "sedentary" | "light" | "moderate" | "active" | "very_active";
  goal: "fat_loss" | "maintenance" | "muscle_gain";
  goal_weight_kg?: number;
  pace_kg_per_week?: number;
};

/**
 * Which instrument produced a body-composition reading (kora#45).
 *
 * Load-bearing, not metadata: the same-named metric is not comparable across
 * instruments. Renpho reports Skeletal Muscle at 48.9% where Omron reports
 * 25.7% for the same body — different definitions, not measurement noise — and
 * DEXA body fat differs from consumer bioimpedance by several points on the
 * same day. A trend that joins two sources without consulting this shows a
 * person losing half their muscle overnight.
 *
 * Mirrors weight_entries_source_check in api migration 000039 and
 * api/internal/tracking/model.go's Source.
 */
export type WeightSource = "manual" | "scale_screenshot" | "inbody" | "dexa" | "healthkit";

/**
 * A weigh-in, optionally with the body composition a scale, InBody or DEXA
 * report measured alongside it (kora#45).
 *
 * Every composition field is OPTIONAL, matching its nullable column: absent
 * must not collapse into a measured zero, because a body fat of 0.0% is not
 * "unknown" and a chart plotting one as the other draws a cliff that never
 * happened.
 *
 * BMI, fat mass in kg and fat-free mass are deliberately absent — they are
 * derived, and storing them would create a second source of truth able to
 * contradict Kora's own height and weight. Derive them with the helpers in
 * src/lib/bodyComposition.ts.
 */
export type WeightEntry = {
  id: string;
  weight_kg: number;
  logged_at: string;
  body_fat_pct?: number;
  subcutaneous_fat_pct?: number;
  /**
   * A vendor RATING, not a percentage — hence no `_pct`. Renpho shows a bare
   * `7`, Omron `7.5 level`, Tanita a 1-59 scale. Never render it with a % sign.
   */
  visceral_fat_rating?: number;
  /** A SUBSET of muscle mass, not the same number in another unit. */
  skeletal_muscle_pct?: number;
  muscle_mass_kg?: number;
  body_water_pct?: number;
  protein_pct?: number;
  /** Bone MASS in kg. A DEXA report's bone DENSITY is a different quantity. */
  bone_mass_kg?: number;
  /**
   * Recorded for comparison ONLY — never a calorie target. Kora derives BMR
   * itself via Mifflin-St Jeor in src/lib/plan.ts, and that is what drives the
   * daily target. Renpho and Omron disagree by ~200 kcal/day on the same body,
   * so a scale-driven target would jump when the user changes scales.
   */
  scale_bmr_kcal?: number;
  /**
   * Tape measurements in CENTIMETRES (kora#45), whatever the user's units
   * preference — the client converts for display, exactly as it does for kg.
   *
   * Optional and independent of one another: someone who measures only their
   * waist has a waist and nothing else, and every absent one means NOT
   * MEASURED rather than zero. They come from a tape, not the scale that
   * produced the metrics above, which is why they sit apart from them here
   * and at the end of the catalogue in src/lib/bodyCompositionFields.ts.
   *
   * Deliberately NOT on `BodyCompositionReading` below: a scale screenshot
   * cannot contain a tape measurement, so the vision pass must never be
   * asked for one.
   */
  neck_cm?: number;
  chest_cm?: number;
  waist_cm?: number;
  hip_cm?: number;
  /** ONE arm — whichever the user measures consistently. Not a left/right pair. */
  arm_cm?: number;
  /** ONE thigh, on the same reasoning as `arm_cm`. */
  thigh_cm?: number;
  source: WeightSource;
};

/**
 * GET /v1/weight/trend's decided result (kora#45): a per-metric, per-range
 * weekly rate of change, already guardrailed server-side.
 *
 * `rate_per_week` and `basis` are OPTIONAL, not nullable — they are absent
 * entirely from the wire unless `status` is "ok". A suppressed or
 * insufficient-data result never carries a rate.
 */
export type WeightTrend = {
  status: "ok" | "insufficient_data" | "suppressed";
  rate_per_week?: number;
  basis?: { readings: number; days: number };
  spans_instruments: boolean;
  show_support: boolean;
};

/**
 * What POST /v1/body-composition/read returns (kora#314, PR B) — the vision
 * pass' best legible read of a smart-scale screenshot. Mirrors
 * api/internal/ai/types.go's BodyCompositionReading field for field. Every
 * field is OPTIONAL and an absent one means the model could not see it,
 * NEVER a measured zero — the same rule WeightEntry's composition fields
 * carry, for the same reason.
 */
export type BodyCompositionReading = {
  weight_kg?: number;
  body_fat_pct?: number;
  subcutaneous_fat_pct?: number;
  /** A vendor RATING, not a percentage — see WeightEntry's own note. */
  visceral_fat_rating?: number;
  skeletal_muscle_pct?: number;
  muscle_mass_kg?: number;
  body_water_pct?: number;
  protein_pct?: number;
  bone_mass_kg?: number;
  scale_bmr_kcal?: number;
  /**
   * "YYYY-MM-DD" — the calendar date the SCREENSHOT ITSELF shows, never a
   * timestamp and never today's date by default. Absent when not legible.
   */
  reading_date?: string;
};

/** One field the reader saw but discarded, and why — mirrors api/internal/bodyread.DroppedField. */
export type BodyCompositionDroppedField = {
  field: string;
  reason: string;
};

/**
 * The full response body of POST /v1/body-composition/read.
 *
 * WRITES NOTHING — this endpoint only reads. Nothing here is saved until the
 * user confirms via BodyCompositionForm and useAddWeight.
 */
export type BodyCompositionReadResult = {
  reading: BodyCompositionReading;
  /** Always an array, never null — the server initializes it non-nil so every client handles one empty shape. */
  dropped_fields: BodyCompositionDroppedField[];
  /** True only when NOTHING at all survived validation — the handler maps this to a 422 instead, so a client never actually sees `true` here; kept because it's on the wire. */
  unreadable: boolean;
};

export type ResolveTier = "auto" | "confirm" | "follow_up";

// The food-log `source` value the server actually accepts — its allowlist is
// api/internal/metrics/labels.go:44-47. Anything outside it is bucketed into
// "other" by labels.go:16-19, silently corrupting the by-source share metric
// rather than erroring. Moved here (out of app/capture.tsx, where it
// originated) so a leaf module like src/offline/drainCaptures.ts can type a
// handoff source against it without importing from the app/ directory.
export type ResolutionSource = "ai_photo" | "ai_text" | "ai_voice" | "ai_barcode";

// Every `source` a food log can carry — the AI capture sources above plus the
// non-AI ones. It is deliberately a SUPERSET of ResolutionSource rather than a
// second, parallel union: the two would drift, and a subtly different source
// list is worse than the bare `string` this replaces.
//
// The extra members and where the server accepts them:
//   "manual" — foodlog.Service.Create's default for an empty source
//              (api/internal/foodlog/service.go:188-190).
//   "memory" — CreateBatch's default, and a batchSources member
//              (service.go:503-508, batchSources at :480).
//   "meal"   — batchSources member (service.go:480).
//   "recipe" — batchSources member, written by recipes.LogRecipe
//              (api/internal/recipes/log.go:15).
// All eight are the food_logs.source CHECK constraint
// (000029_food_logs_source_check.up.sql) and metrics.knownSources, which the
// migration names as the authoritative list.
//
// Note "manual" is the only member of this union a client may send to the
// SINGLE-log endpoint that isn't also a resolution source; the batch endpoint
// rejects anything outside batchSources with a 400.
export type LogSource = ResolutionSource | "manual" | "memory" | "meal" | "recipe";

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
  /**
   * True when the server had no serving size for this food, so the portion is
   * a system estimate, not a measurement. It is a guess and must never be
   * rendered as an exact figure without saying so.
   */
  portion_assumed?: boolean;
}

export interface Resolution {
  /**
   * The server can send `null` here (a Go nil slice with no `omitempty` —
   * api/internal/ai/types.go:81 — on several no-result paths, including
   * barcode's "not recognized" branch). Every resolve mutation in
   * src/api/resolveWire.ts (normalizeResolution) coerces that to `[]` before
   * returning, so every consumer of a `Resolution` value in this app can
   * trust this field is always a real array. Do not bypass that
   * normalization by calling apiFetch directly for a new resolve endpoint.
   */
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
  // kora#449: GET /v1/friends and GET /v1/friends/requests both project
  // social.FriendView, which always carries handle and avatar_url (see
  // api/internal/social/model.go) -- the type was never updated to match
  // when handles shipped. avatar_url is "" for a user with no picture.
  handle: string;
  avatar_url: string;
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

// The viewer's relationship to a looked-up person (kora#453). Mirrors
// api/internal/identity/friendship.go's FriendshipStatus EXACTLY — these are
// the only five wire values the server ever sends, and a string-literal
// union (not `string`) is what makes a typo here a compile error instead of
// a silent fallthrough to LookupResultCard's default case.
//   "none"             — no relationship yet -> "Send request"
//   "request_sent"     — viewer already sent a request, still pending -> "Requested"
//   "request_received" — the looked-up person already sent THE VIEWER a
//                         request -> "Respond", not a live send button
//   "friends"          — accepted friendship -> "Already friends"
//   "self"             — the viewer looked up their own handle
export type FriendshipStatus = "none" | "request_sent" | "request_received" | "friends" | "self";

// Handles (kora#449). The projection GET /v1/users/lookup returns. There is
// no listing form of that endpoint — exact match only — so there is no array
// type here either.
export type LookupResult = {
  id: string;
  display_name: string;
  handle: string;
  // "" when the person has no picture, and when no bucket is configured.
  // Treat it as "no picture", never as a failure.
  avatar_url: string;
  // kora#453. See FriendshipStatus's doc comment above for the exact wire
  // values. The server degrades this to "none" when it has no relationship
  // provider wired, which is a degrade, not a claim that no relationship
  // exists — LookupResultCard must not read anything more into it.
  friendship_status: FriendshipStatus;
};

export type MyHandle = { handle: string };

// Sharing circles (kora#326/#437). ShareCategory mirrors the server's
// access.Category allow-list and the share_grants_category_check constraint;
// a value outside it can never be granted, so the union is the whole set.
export type ShareCategory = "progress" | "body";

// CircleMember never carries an email — same projection rule as Friend and
// the server's share.MemberView.
export interface CircleMember {
  id: string;
  display_name: string;
  // "" when the person has no picture, and when no bucket is configured.
  // Treat it as "no picture", never as a failure — same rule as
  // LookupResult.avatar_url above.
  avatar_url: string;
}

// The MEMBER's view of a circle they were added to (kora#440). Mirrors the
// server's share.MembershipView, and deliberately carries no circle name —
// those are the owner's private labels.
// One weigh-in as a FRIEND is allowed to see it (kora#438/#441). Mirrors the
// server's tracking.FriendBodyEntry: every metric optional, and no id,
// created_at, hk_uuid or source — the server does not send them.
//
// A missing field means NOT MEASURED. Never render it as zero.
export interface FriendBodyEntry {
  logged_at: string;
  local_date: string;
  weight_kg: number;
  body_fat_pct?: number;
  subcutaneous_fat_pct?: number;
  visceral_fat_rating?: number;
  skeletal_muscle_pct?: number;
  muscle_mass_kg?: number;
  body_water_pct?: number;
  protein_pct?: number;
  bone_mass_kg?: number;
  scale_bmr_kcal?: number;
  neck_cm?: number;
  chest_cm?: number;
  waist_cm?: number;
  hip_cm?: number;
  arm_cm?: number;
  thigh_cm?: number;
}

export interface Membership {
  circle_id: string;
  owner: CircleMember;
  categories: ShareCategory[];
}

export interface Circle {
  id: string;
  name: string;
  members: CircleMember[];
  categories: ShareCategory[];
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

export interface RecipeIngredient {
  food_item_id: string | null;
  name: string;
  raw_text: string;
  /** false means the food index has no match — the line shows but adds no macros. */
  resolved: boolean;
  grams: number;
  entered_amount: number | null;
  entered_unit: string | null;
  /** The grams above are a system estimate, not a measurement. Must be rendered as such. */
  portion_assumed: boolean;
  match_score: number | null;
  match_tier: string | null;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
}

export interface Recipe {
  id: string;
  name: string;
  servings: number;
  source: "manual" | "paste" | "photo";
  ingredients: RecipeIngredient[];
  /** > 0 means the totals below are PARTIAL. Say so in the UI. */
  unresolved_count: number;
  total_kcal: number;
  total_protein_g: number;
  total_carbs_g: number;
  total_fat_g: number;
  total_fiber_g: number;
  per_serving_kcal: number;
  per_serving_protein_g: number;
  per_serving_carbs_g: number;
  per_serving_fat_g: number;
  per_serving_fiber_g: number;
}

export interface RecipeIngredientInput {
  food_item_id: string | null;
  raw_text: string;
  grams: number;
  entered_amount?: number | null;
  entered_unit?: string | null;
  portion_assumed?: boolean;
  match_score?: number | null;
  match_tier?: string | null;
  /** SERVER-POPULATED on a parse draft only (the matched food's canonical
   *  name, for display) — absent otherwise, and IGNORED by the server on
   *  create/update, which re-derives the name from food_item_id. Never set
   *  this from the client. */
  name?: string;
}

export interface RecipeDraft {
  name: string;
  servings: number;
  source: "paste" | "photo";
  ingredients: RecipeIngredientInput[];
}

export interface SaveRecipeBody {
  name: string;
  servings: number;
  source: "manual" | "paste" | "photo";
  ingredients: RecipeIngredientInput[];
}

export interface LogRecipeResult {
  logged: number;
  /** Unresolved ingredients that could not be logged — tell the user. */
  skipped: string[];
}

/** A declared fast. `ended_at`/`ended_by` absent means it is still open. */
export interface FastingInterval {
  id: string;
  user_id: string;
  started_at: string;
  ended_at?: string;
  ended_by?: string;
  local_date: string;
}
