import type { BodyCompositionReading, WeightEntry, WeightSource } from "@/api/types";
import { cmFromIn, inFromCm, kgFromLb, lbFromKg, weightUnitLabel, type UnitSystem } from "@/units";

/**
 * The one description of every body-composition metric Kora stores (kora#45).
 *
 * Three surfaces need the same facts about these sixteen numbers — the manual
 * entry form, the trend picker, and #314's screenshot-confirm screen — and the
 * facts are the kind that go wrong when they are restated: whether a metric is
 * a percentage or a vendor rating, what unit its label must say, and what
 * range the server will accept. Restating them per surface is how a rating
 * acquires a `%` on one screen and not another.
 *
 * Only MEASURED metrics appear here. BMI, fat mass in kg and fat-free mass are
 * derived in bodyComposition.ts and have no entry field by design — a form
 * that let you type BMI would be the second source of truth the schema was
 * shaped to avoid.
 */

/** Every metric key that can carry a typed value. `weight_kg` is the row itself. */
export type CompositionMetricKey =
  | "weight_kg"
  | "body_fat_pct"
  | "subcutaneous_fat_pct"
  | "visceral_fat_rating"
  | "skeletal_muscle_pct"
  | "muscle_mass_kg"
  | "body_water_pct"
  | "protein_pct"
  | "bone_mass_kg"
  | "scale_bmr_kcal"
  // Tape measurements (kora#45). Stored in centimetres, appended after the
  // scale metrics — see COMPOSITION_METRICS' ordering comment for why they
  // cannot be interleaved with them.
  | "neck_cm"
  | "chest_cm"
  | "waist_cm"
  | "hip_cm"
  | "arm_cm"
  | "thigh_cm";

/**
 * What kind of quantity a metric is, which decides its unit label.
 *
 * `rating` exists solely so that visceral fat cannot be rendered with a `%`.
 * It is a vendor rating on a vendor scale — Renpho prints a bare `7`, Omron
 * `7.5 level`, Tanita a 1-59 band — and a `%` next to it is not a cosmetic
 * slip, it is a claim about the number that is false.
 *
 * `length` is the tape measurements (kora#45). It exists as its own kind
 * rather than reusing `mass` because both are stored metric and converted for
 * an imperial user, but they convert by DIFFERENT constants into DIFFERENT
 * units — a waist rendered with `lb` would be as wrong as a rating rendered
 * with `%`.
 */
export type CompositionUnitKind = "mass" | "percent" | "rating" | "kcal" | "length";

/** Bounds mirroring validateComposition in api/internal/tracking/repository.go. */
export interface CompositionRange {
  min: number;
  max: number;
  /** True when the server rejects `min` itself (masses must be POSITIVE). */
  exclusiveMin?: boolean;
}

export interface CompositionMetric {
  key: CompositionMetricKey;
  /** Sentence-case name, used as the field label and the trend picker's chip. */
  label: string;
  unitKind: CompositionUnitKind;
  /** Weight is the weigh-in itself; everything else is optional. */
  required?: boolean;
  /** Shown under the field where the name alone is genuinely ambiguous. */
  note?: string;
  range: CompositionRange;
}

/** The widest vendor scale in use is Tanita's 1-59; mirrors maxVisceralFatRating. */
const MAX_VISCERAL_FAT_RATING = 59;

/**
 * Mirrors maxMeasurementCm in api/internal/tracking/repository.go. 300cm is
 * past any human circumference, so it rejects the mistake that actually
 * happens — millimetres typed into a centimetre field — without refusing a
 * real reading. Kept the same number as the server's so a value this form
 * accepts is never one the server then rejects.
 */
const MAX_MEASUREMENT_CM = 300;

const PERCENT: CompositionRange = { min: 0, max: 100 };
const POSITIVE: CompositionRange = { min: 0, max: Number.POSITIVE_INFINITY, exclusiveMin: true };
/** Bounds in CENTIMETRES, which is what `inRange` checks — it is handed the stored value. */
const LENGTH_CM: CompositionRange = { min: 0, max: MAX_MEASUREMENT_CM, exclusiveMin: true };

/**
 * Order is the order a Renpho screenshot reads top to bottom, so someone
 * copying one in types down the list rather than hunting for each field. #314
 * inherits the same order for the same reason.
 */
export const COMPOSITION_METRICS: readonly CompositionMetric[] = [
  { key: "weight_kg", label: "Weight", unitKind: "mass", required: true, range: POSITIVE },
  { key: "body_fat_pct", label: "Body fat", unitKind: "percent", range: PERCENT },
  { key: "subcutaneous_fat_pct", label: "Subcutaneous fat", unitKind: "percent", range: PERCENT },
  {
    key: "visceral_fat_rating",
    label: "Visceral fat",
    unitKind: "rating",
    note: "A rating on your scale's own scale, not a percentage.",
    range: { min: 0, max: MAX_VISCERAL_FAT_RATING, exclusiveMin: true },
  },
  {
    key: "skeletal_muscle_pct",
    label: "Skeletal muscle",
    unitKind: "percent",
    note: "A subset of muscle mass, not the same figure in another unit.",
    range: PERCENT,
  },
  { key: "muscle_mass_kg", label: "Muscle mass", unitKind: "mass", range: POSITIVE },
  { key: "body_water_pct", label: "Body water", unitKind: "percent", range: PERCENT },
  { key: "protein_pct", label: "Protein", unitKind: "percent", range: PERCENT },
  {
    key: "bone_mass_kg",
    label: "Bone mass",
    unitKind: "mass",
    note: "Mass, as a scale reports it. A DEXA bone density is a different quantity.",
    range: POSITIVE,
  },
  {
    key: "scale_bmr_kcal",
    label: "Scale BMR",
    unitKind: "kcal",
    note: "Recorded for comparison only — your daily target stays Kora's own.",
    range: POSITIVE,
  },
  // Tape measurements (kora#45), and they go at the END on purpose. The order
  // above is a Renpho screenshot read top to bottom; a tape measurement is not
  // on that screenshot, so slotting one in beside body fat would break the
  // read-down-the-list property for the people the order exists for. Being
  // last is also what puts all six inside BodyCompositionForm's OTHER_METRICS
  // — the "More fields" disclosure — so they never intrude on the two-tap
  // weigh-in. Neither is incidental: reordering this list moves them onto the
  // first screen of the weigh-in sheet.
  { key: "neck_cm", label: "Neck", unitKind: "length", range: LENGTH_CM },
  { key: "chest_cm", label: "Chest", unitKind: "length", range: LENGTH_CM },
  { key: "waist_cm", label: "Waist", unitKind: "length", range: LENGTH_CM },
  { key: "hip_cm", label: "Hip", unitKind: "length", range: LENGTH_CM },
  {
    key: "arm_cm",
    label: "Arm",
    unitKind: "length",
    note: "One arm — whichever you measure. Keep to the same one so the trend is a trend.",
    range: LENGTH_CM,
  },
  {
    key: "thigh_cm",
    label: "Thigh",
    unitKind: "length",
    note: "One thigh, on the same reasoning as arm.",
    range: LENGTH_CM,
  },
] as const;

export function compositionMetric(key: CompositionMetricKey): CompositionMetric {
  const found = COMPOSITION_METRICS.find((m) => m.key === key);
  // Unreachable through the type system; thrown rather than defaulted because a
  // silently substituted metric would mislabel a field.
  if (!found) throw new Error(`unknown composition metric: ${key}`);
  return found;
}

/**
 * The unit suffix to render beside a value.
 *
 * A rating returns "" — deliberately, and it is the reason this function
 * exists rather than a lookup table with a "%" fallback.
 */
export function unitLabel(metric: CompositionMetric, system: UnitSystem): string {
  switch (metric.unitKind) {
    case "mass":
      return weightUnitLabel(system);
    case "percent":
      return "%";
    case "kcal":
      return "kcal";
    case "length":
      return system === "imperial" ? "in" : "cm";
    case "rating":
      return "";
  }
}

/**
 * The spoken label for a field or a plotted metric.
 *
 * VoiceOver reads this instead of the visual "label + unit" pair, so it has to
 * carry the unit in words — "percent", not "%" — and say "rating" where there
 * is no unit at all rather than trailing off after the name.
 */
export function metricAccessibilityLabel(metric: CompositionMetric, system: UnitSystem): string {
  switch (metric.unitKind) {
    case "mass":
      return `${metric.label} in ${system === "imperial" ? "pounds" : "kilograms"}`;
    case "percent":
      return `${metric.label} percent`;
    case "kcal":
      return `${metric.label} in kilocalories`;
    case "length":
      return `${metric.label} in ${system === "imperial" ? "inches" : "centimetres"}`;
    case "rating":
      return `${metric.label} rating`;
  }
}

/** Whether a metric's stored value is in kg and therefore unit-converted for display. */
export function isMassMetric(metric: CompositionMetric): boolean {
  return metric.unitKind === "mass";
}

/**
 * Whether a metric is stored in a metric unit that an imperial user sees
 * converted — mass (kg→lb) or length (cm→in).
 *
 * The predicate callers actually want. Every conversion site used to ask
 * `isMassMetric` because mass was the only converted kind; asking that question
 * now would silently write an imperial user's typed INCHES into a centimetre
 * column, which is a wrong measurement rather than a visible bug.
 */
export function isConvertedMetric(metric: CompositionMetric): boolean {
  return metric.unitKind === "mass" || metric.unitKind === "length";
}

/**
 * The value a stored entry holds for a metric, or undefined when it was never
 * measured.
 *
 * Never coalesces to 0. The whole point of the nullable columns is that absent
 * and zero are different facts, and a `?? 0` here would erase that on the way
 * to every chart.
 */
export function metricValue(entry: WeightEntry, key: CompositionMetricKey): number | undefined {
  const value = entry[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * The instruments a hand-typed reading can plausibly claim.
 *
 * `scale_screenshot` is #314's to set and `healthkit` is #30's — neither is
 * something a user can honestly select while typing, so neither is offered
 * here. They remain valid `WeightSource` values; they are just not manual ones.
 */
export const MANUAL_SOURCES: readonly WeightSource[] = ["manual", "inbody", "dexa"] as const;

const SOURCE_LABELS: Record<WeightSource, string> = {
  manual: "Scale",
  scale_screenshot: "Scale screenshot",
  inbody: "InBody",
  dexa: "DEXA",
  healthkit: "Apple Health",
};

export function sourceLabel(source: WeightSource): string {
  return SOURCE_LABELS[source] ?? source;
}

/**
 * The instruments a screenshot's own pixels could plausibly identify (kora#314
 * PR C). Not `MANUAL_SOURCES`' complement — `manual` and `healthkit` are never
 * something a screenshot detects, they're the absence of a screenshot.
 */
export const DETECTABLE_SOURCES: readonly WeightSource[] = ["scale_screenshot", "inbody", "dexa"] as const;

function isDetectableSource(value: unknown): value is WeightSource {
  return typeof value === "string" && (DETECTABLE_SOURCES as readonly string[]).includes(value);
}

/**
 * Reads the API's detected-instrument field defensively (kora#314 PR C).
 *
 * A sibling PR is adding a nullable field to POST /v1/body-composition/read's
 * response — the vision pass' best guess at which instrument (`scale_screenshot`,
 * `inbody` or `dexa`) produced the screenshot. This branch is being built
 * against api/ before that lands, and it must work correctly whichever order
 * the two PRs merge in. So this reads the field through an untyped index
 * rather than a typed property of `BodyCompositionReading` — the type may not
 * even declare it yet — and validates whatever comes back against the three
 * values detection is allowed to produce.
 *
 * Anything else — the field absent (API not yet updated), null (nothing
 * detected), or a string outside `DETECTABLE_SOURCES` (a future instrument
 * this build doesn't know about) — falls back to `scale_screenshot`, which is
 * exactly what every screenshot read meant before detection existed. A
 * misdetection is not fatal either way: the caller offers this as the
 * PRE-SELECTED option in an editable control (see `orderSourcesDetectedFirst`
 * below), never as an unchangeable fact — source decides which readings may
 * share a trend line (migration 000039), so a wrong guess must stay
 * correctable.
 */
export function detectedInstrumentSource(reading: BodyCompositionReading): WeightSource {
  // Wire name is `instrument`, matching the API's ai.BodyCompositionReading
  // field (kora#314). Read via an index rather than a declared property
  // because the two halves of this change landed as separate PRs and this
  // build's BodyCompositionReading type may not declare it yet; the guard
  // below means an absent or unknown value degrades to the pre-detection
  // behaviour rather than erroring.
  const raw = (reading as Record<string, unknown>).instrument;
  return isDetectableSource(raw) ? raw : "scale_screenshot";
}

/**
 * `DETECTABLE_SOURCES`, reordered so `detected` is first.
 *
 * `BodyCompositionForm` defaults its selected source to `sources[0]`, so this
 * is what turns a detected instrument into the control's pre-selection while
 * still handing it all three options to correct to — the multi-entry branch
 * of `sources` (a SegmentedGlass control), not the single-entry branch (a
 * stated, unchangeable fact). Kept a plain array op rather than a new form
 * prop: the "detected value goes first" rule lives here, once, instead of
 * being re-derived by every caller that wants a detected default.
 */
export function orderSourcesDetectedFirst(detected: WeightSource): readonly WeightSource[] {
  return [detected, ...DETECTABLE_SOURCES.filter((s) => s !== detected)];
}

/**
 * The stored value converted for display. Only the kg- and cm-backed metrics
 * move; a percentage, a rating and a kcal figure are the same number in either
 * system.
 */
export function displayNumber(metric: CompositionMetric, stored: number, system: UnitSystem): number {
  if (system !== "imperial") return stored;
  switch (metric.unitKind) {
    case "mass":
      return lbFromKg(stored);
    case "length":
      return inFromCm(stored);
    default:
      return stored;
  }
}

/**
 * The inverse of `displayNumber`: what the user typed, in the unit they were
 * shown, turned back into what the column stores.
 *
 * Lives here rather than in the form so the two directions sit next to each
 * other. They have to agree exactly — a display path converting cm→in while
 * the parse path left inches alone would round-trip a 32in waist into a 32cm
 * one, and nothing on screen would look wrong.
 */
export function storedNumber(metric: CompositionMetric, typed: number, system: UnitSystem): number {
  if (system !== "imperial") return typed;
  switch (metric.unitKind) {
    case "mass":
      return kgFromLb(typed);
    case "length":
      return cmFromIn(typed);
    default:
      return typed;
  }
}

/**
 * How a metric's figure is written.
 *
 * A tenth for everything a scale prints to a tenth — including the visceral
 * rating, which Omron gives as 7.5 — and whole numbers for BMR, where a
 * decimal would imply a precision the device does not claim.
 */
export function formatMetricNumber(metric: CompositionMetric, value: number): string {
  return metric.unitKind === "kcal" ? String(Math.round(value)) : value.toFixed(1);
}

/**
 * How a stored reading's origin is named in prose, as distinct from how an
 * instrument is named in the form's "Measured with" picker (kora#419).
 *
 * The two questions are genuinely different. The picker asks what you
 * measured WITH, where `manual` really is a scale you stood on and "Scale" is
 * the right word. A provenance sentence asks where the number CAME FROM, and
 * there "Scale" sits beside "Scale screenshot" and reads as one device rather
 * than as a figure someone typed. Only this second use is renamed; changing
 * SOURCE_LABELS would have put "Typed in" under "Measured with", which is not
 * a thing you can measure with.
 */
const PROVENANCE_LABELS: Partial<Record<WeightSource, string>> = {
  // Keeps the word "Scale" -- a typed reading really did come off a scale, so
  // dropping it would be its own inaccuracy, and "Measured by typed in" is
  // not a sentence. The parenthetical is what separates it from "Scale
  // screenshot", which is the same instrument read a different way.
  manual: "Scale (typed in)",
};

export function provenanceLabel(source: WeightSource): string {
  return PROVENANCE_LABELS[source] ?? sourceLabel(source);
}
