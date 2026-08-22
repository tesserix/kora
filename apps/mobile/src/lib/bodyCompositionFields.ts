import type { BodyCompositionReading, WeightEntry, WeightSource } from "@/api/types";
import { lbFromKg, weightUnitLabel, type UnitSystem } from "@/units";

/**
 * The one description of every body-composition metric Kora stores (kora#45).
 *
 * Three surfaces need the same facts about these ten numbers — the manual
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
  | "scale_bmr_kcal";

/**
 * What kind of quantity a metric is, which decides its unit label.
 *
 * `rating` exists solely so that visceral fat cannot be rendered with a `%`.
 * It is a vendor rating on a vendor scale — Renpho prints a bare `7`, Omron
 * `7.5 level`, Tanita a 1-59 band — and a `%` next to it is not a cosmetic
 * slip, it is a claim about the number that is false.
 */
export type CompositionUnitKind = "mass" | "percent" | "rating" | "kcal";

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

const PERCENT: CompositionRange = { min: 0, max: 100 };
const POSITIVE: CompositionRange = { min: 0, max: Number.POSITIVE_INFINITY, exclusiveMin: true };

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
    case "rating":
      return `${metric.label} rating`;
  }
}

/** Whether a metric's stored value is in kg and therefore unit-converted for display. */
export function isMassMetric(metric: CompositionMetric): boolean {
  return metric.unitKind === "mass";
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
  const raw = (reading as Record<string, unknown>).detected_source;
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
 * The stored value converted for display. Only the kg-backed metrics move; a
 * percentage, a rating and a kcal figure are the same number in either system.
 */
export function displayNumber(metric: CompositionMetric, stored: number, system: UnitSystem): number {
  return isMassMetric(metric) && system === "imperial" ? lbFromKg(stored) : stored;
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
